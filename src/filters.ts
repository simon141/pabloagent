import type { Harness } from "./harness";
import { execSummary, isExploratoryCommand } from "./rollout";
import type { ThreadItem } from "./types";

export interface FilterCategory {
  id: string;
  label: string;
  hint: string;
}

interface Node {
  type?: string;
  origin?: string;
  entryType?: string;
  label?: string;
  tool?: string;
  input?: string;
  summary?: string;
  explored?: boolean;
}

const DEFAULT_HIDDEN: Partial<Record<Harness, readonly string[]>> = {
  codex: ["reasoning", "metadata", "events"],
  claude: [
    "reasoning",
    "context",
    "type:ai-title",
    "type:attachment:command_permissions",
    "type:attachment:edited_text_file",
    "type:mode",
    "type:pr-link",
    "type:attachment:queued_command",
    "type:attachment:task_reminder",
  ],
  opencode: ["steps"],
  pi: ["thought-encrypted"],
};

export function defaultHidden(harness: Harness): string[] {
  return [...(DEFAULT_HIDDEN[harness] ?? [])];
}

const ENTRY_PREFIX = "type:";

const entryFilterId = (entryType: string): string =>
  `${ENTRY_PREFIX}${entryType}`;

const isEntryFilter = (id: string): boolean => id.startsWith(ENTRY_PREFIX);

export function entryTypeOf(id: string): string | null {
  return isEntryFilter(id) ? id.slice(ENTRY_PREFIX.length) : null;
}

export function entryFilterFor(entryType: string): FilterCategory {
  const attachment = entryType.startsWith("attachment:")
    ? entryType.slice("attachment:".length)
    : null;
  return {
    id: entryFilterId(entryType),
    label: attachment ?? entryType,
    hint: attachment
      ? `Attachments claude injects as ${attachment}.`
      : `Session entries of type ${entryType}.`,
  };
}

const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "write",
  "notebookedit",
  "apply_patch",
  "patch",
  "str_replace",
  "str_replace_editor",
]);

const SHELL_TOOLS = new Set(["bash", "exec", "shell", "sh", "run", "terminal"]);

function toolCategory(node: Node): string {
  const tool = String(node.tool ?? "").toLowerCase();
  if (EDIT_TOOLS.has(tool)) return "patch";
  if (node.explored) return "explored";
  if (SHELL_TOOLS.has(tool)) return "exec";
  return "tool";
}

function codexToolCategory(node: Node): string {
  const input = String(node.input ?? "");
  if (
    /\bapply_patch\s*\(/.test(input) ||
    /^\*\*\* (Begin Patch|Update File)/m.test(input)
  ) {
    return "patch";
  }
  const command = node.summary ?? execSummary(input);
  if (!command) return "tool";
  return (node.explored ?? isExploratoryCommand(command)) ? "explored" : "exec";
}

interface HarnessFilters {
  categories: FilterCategory[];

  classify: (node: Node) => string | null;
}

const REASONING = (what: string): FilterCategory => ({
  id: "reasoning",
  label: "Reasoning",
  hint: what,
});
const ENCRYPTED_THOUGHT: FilterCategory = {
  id: "thought-encrypted",
  label: "Thought (encrypted)",
  hint: "Encrypted thought markers only, without plaintext or redacted reasoning.",
};
const EXEC: FilterCategory = {
  id: "exec",
  label: "Shell commands",
  hint: "The ⌘ Ran cards — anything that changed something.",
};
const EXPLORED: FilterCategory = {
  id: "explored",
  label: "File reads and searches",
  hint: "The 🔍 Explored cards: reads, greps, listings, web lookups.",
};
const PATCH = (tools: string): FilterCategory => ({
  id: "patch",
  label: "File edits",
  hint: tools,
});
const OTHER_TOOLS = (examples: string): FilterCategory => ({
  id: "tool",
  label: "Other tool calls",
  hint: examples,
});

const FILTERS: Record<Harness, HarnessFilters> = {
  codex: {
    categories: [
      REASONING("All thinking steps, including encrypted markers."),
      ENCRYPTED_THOUGHT,
      EXEC,
      EXPLORED,
      PATCH("apply_patch calls."),
      OTHER_TOOLS("Web search, tool search, MCP servers, anything new."),
      {
        id: "context",
        label: "Injected context",
        hint: "AGENTS.md and the environment blocks sent as the first user turn.",
      },
      {
        id: "instructions",
        label: "System and developer instructions",
        hint: "The system prompt, permissions, plugins and skills preamble.",
      },
      {
        id: "metadata",
        label: "Session and turn metadata",
        hint: "Session start, per-turn settings, workspace state.",
      },
      {
        id: "events",
        label: "Lifecycle events",
        hint: "Turn started, turn complete, patch applied.",
      },
    ],
    classify: (node) => {
      if (node.type === "reasoning") return "reasoning";
      if (node.type === "rawToolCall") return codexToolCategory(node);
      if (node.type !== "contextEntry") return null;
      const origin = String(node.origin ?? "");
      if (origin === "reasoning" && node.label === "Thought (encrypted)") {
        return "thought-encrypted";
      }
      if (origin === "reasoning") return "reasoning";
      if (origin.startsWith("event/")) return "events";
      if (origin === "developer" || origin === "system") return "instructions";
      if (origin === "injected context") return "context";
      if (
        origin === "session_meta" ||
        origin === "turn_context" ||
        origin === "world_state"
      ) {
        return "metadata";
      }
      return null;
    },
  },

  claude: {
    categories: [
      REASONING(
        "Thinking blocks, and the markers for a thought the model redacted.",
      ),
      EXEC,
      EXPLORED,
      PATCH(
        "Edit, MultiEdit, Write and NotebookEdit — including the diff cards.",
      ),
      OTHER_TOOLS("Task, TodoWrite, MCP servers, anything new."),
      {
        id: "sidechain",
        label: "Subagent work",
        hint: "A Task subagent's own messages, thinking and tool calls.",
      },
      {
        id: "context",
        label: "Injected context",
        hint:
          "What claude said on your behalf: caveats, compaction summaries," +
          " background-agent notifications.",
      },
      // Everything else claude writes is filtered by its own entry type
      // instead of by a group here, see `entryFilterFor`.
    ],
    classify: (node) => {
      if (node.type === "reasoning") return "reasoning";
      if (node.type === "rawToolCall") return toolCategory(node);
      if (node.type !== "contextEntry") return null;
      // Checked before the origins below: the entry type is the more specific
      // answer.
      if (node.entryType) return entryFilterId(node.entryType);
      const origin = String(node.origin ?? "");
      if (origin === "reasoning") return "reasoning";
      if (origin === "sidechain") return "sidechain";
      if (origin.startsWith("injected")) return "context";
      // `tool result` names no tool (its call is above the window read so
      // far), so it stays visible rather than guessed at.
      return null;
    },
  },

  opencode: {
    categories: [
      REASONING("The reasoning parts opencode records in plaintext."),
      EXEC,
      EXPLORED,
      PATCH("edit, write and patch calls."),
      OTHER_TOOLS("todowrite, task, MCP servers, anything new."),
      {
        id: "steps",
        label: "Step boundaries",
        hint: "The step-finish cards, one per model request, with its token count.",
      },
      {
        id: "metadata",
        label: "Other session parts",
        hint: "Part and event shapes that are neither chat, a tool call nor a step.",
      },
    ],
    classify: (node) => {
      if (node.type === "reasoning") return "reasoning";
      if (node.type === "rawToolCall") return toolCategory(node);
      if (node.type !== "contextEntry") return null;
      const origin = String(node.origin ?? "");
      if (origin === "step-finish") return "steps";
      if (origin === "opencode part" || origin === "opencode event")
        return "metadata";
      // `opencode error` is the app reporting a failure, never filterable.
      return null;
    },
  },

  pi: {
    categories: [
      REASONING("All thinking blocks, including encrypted markers."),
      ENCRYPTED_THOUGHT,
      EXEC,
      EXPLORED,
      PATCH("edit and write calls."),
      OTHER_TOOLS("Extension tools, MCP servers, anything new."),
      {
        id: "settings",
        label: "Model and thinking-level changes",
        hint: "The model_change, thinking_level_change, session name and label entries.",
      },
      {
        id: "compaction",
        label: "Compactions and branch switches",
        hint: "The summaries pi leaves when it compacts a session or moves to another branch.",
      },
      {
        id: "metadata",
        label: "Session metadata",
        hint: "The session header and the entries extensions write.",
      },
    ],
    classify: (node) => {
      if (node.type === "reasoning") return "reasoning";
      if (node.type === "rawToolCall") return toolCategory(node);
      if (node.type !== "contextEntry") return null;
      const origin = String(node.origin ?? "");
      if (origin === "reasoning" && node.label === "Thought (encrypted)") {
        return "thought-encrypted";
      }
      if (origin === "reasoning") return "reasoning";
      if (
        origin === "model_change" ||
        origin === "thinking_level_change" ||
        origin === "session_info" ||
        origin === "label"
      ) {
        return "settings";
      }
      if (
        origin === "compaction" ||
        origin === "branch_summary" ||
        origin === "branchSummary" ||
        origin === "compactionSummary"
      ) {
        return "compaction";
      }
      if (
        origin === "session" ||
        origin === "custom" ||
        origin === "custom_message"
      ) {
        return "metadata";
      }
      // `turn end` is a turn that errored or was aborted, and `tool result` an
      // output whose call was never read. Both stay visible.
      return null;
    },
  },
};

export function filtersFor(harness: Harness): FilterCategory[] {
  return FILTERS[harness]?.categories ?? [];
}

export function categoryOf(harness: Harness, item: ThreadItem): string | null {
  return FILTERS[harness]?.classify(item as Node) ?? null;
}

export function categoriesOf(harness: Harness, item: ThreadItem): string[] {
  const category = categoryOf(harness, item);
  if (!category) return [];
  return category === "thought-encrypted"
    ? [category, "reasoning"]
    : [category];
}

export function isHidden(
  harness: Harness,
  hidden: readonly string[],
  item: ThreadItem,
): boolean {
  if (!hidden.length) return false;
  return categoriesOf(harness, item).some((category) =>
    hidden.includes(category),
  );
}

export function knownHidden(
  harness: Harness,
  hidden: readonly string[],
): string[] {
  const ids = new Set(filtersFor(harness).map((f) => f.id));
  return hidden.filter((id) => ids.has(id) || isEntryFilter(id));
}

export function allFiltersFor(
  harness: Harness,
  seen: Iterable<string>,
  hidden: readonly string[],
): FilterCategory[] {
  const types = new Set<string>();
  for (const id of seen) {
    const type = entryTypeOf(id);
    if (type) types.add(type);
  }
  for (const id of hidden) {
    const type = entryTypeOf(id);
    if (type) types.add(type);
  }
  // Sorted by the label on screen, not the id: an attachment's id carries an
  // `attachment:` prefix the reader never sees.
  const entries = [...types]
    .map((type) => entryFilterFor(type))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...filtersFor(harness), ...entries];
}

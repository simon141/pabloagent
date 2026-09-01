import {
  addBreakdown,
  emptyBreakdown,
  type SessionTokens,
  type TokenBreakdown,
} from "./context";
import { isExploratoryCommand } from "./rollout";
import type { EmbeddedImage, RawToolCallItem, ThreadItem } from "./types";

export interface PiEntry {
  type?: string;

  id?: string;
  parentId?: string | null;
  timestamp?: string;
  version?: number;
  cwd?: string;
  parentSession?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    provider?: string;
    usage?: Record<string, unknown>;
    stopReason?: string;
    errorMessage?: string;
    command?: string;
    output?: string;
    exitCode?: number;
    cancelled?: boolean;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    summary?: string;
    customType?: string;
    [k: string]: unknown;
  };
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  summary?: string;
  tokensBefore?: number;
  fromId?: string;
  name?: string;
  label?: string;
  targetId?: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

interface Part {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  mimeType?: string;
  data?: string;
  [k: string]: unknown;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

const LABEL_KEYS = ["command", "path", "file_path", "pattern", "url", "query"];

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function parts(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as Part[];
  if (content && typeof content === "object") return [content as Part];
  return [];
}

function bodyText(value: unknown): string {
  if (typeof value === "string") return value;
  return parts(value)
    .map((p) => {
      if (typeof p.text === "string") return p.text;
      if (p.type === "image" && typeof p.data !== "string") {
        return `[image ${String(p.mimeType ?? "")}]`.replace(" ]", "]");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function imagesOf(value: unknown): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  for (const p of parts(value)) {
    if (p.type !== "image" || typeof p.data !== "string" || !p.data) continue;
    out.push({ mime: String(p.mimeType ?? "image/png"), data: p.data });
  }
  return out;
}

function piToolSummary(
  tool: string,
  args: unknown,
): { label: string; explored: boolean } {
  const input = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  const pick = LABEL_KEYS.find((k) => typeof input[k] === "string" && input[k]);
  let label = pick ? String(input[pick]) : "";
  if (!label) {
    const first = Object.entries(input).find(
      ([, v]) => typeof v === "string" && v,
    );
    label = first ? String(first[1]) : "";
  }
  const explored =
    READ_ONLY_TOOLS.has(tool) ||
    (tool === "bash" && typeof input.command === "string"
      ? isExploratoryCommand(input.command)
      : false);
  return { label: label ? `${tool} ${label}` : tool, explored };
}

function firstWords(text: string, max = 48): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line || "(empty)";
}

function metaLabel(entry: PiEntry): string {
  const kind = String(entry.type ?? "entry");
  switch (kind) {
    case "session":
      return `Session start — pi session v${String(entry.version ?? "?")}`;
    case "model_change":
      return `Model — ${String(entry.provider ?? "")}/${String(entry.modelId ?? "")}`;
    case "thinking_level_change":
      return `Thinking level — ${String(entry.thinkingLevel ?? "")}`;
    case "compaction":
      return `Compaction — ${Number(entry.tokensBefore ?? 0).toLocaleString()} tokens summarised`;
    case "branch_summary":
      return `Branch switched — summary of the path left behind`;
    case "session_info":
      return `Session name — ${String(entry.name ?? "")}`;
    case "label":
      return `Label — ${String(entry.label ?? "(cleared)")}`;
    case "custom":
      return `Extension state — ${String(entry.customType ?? "")}`;
    case "custom_message":
      return `Extension message — ${String(entry.customType ?? "")}`;
    default:
      return `Session entry — ${kind}`;
  }
}

export function renderPiSession(
  entries: PiEntry[],
  keyPrefix = "p",
): ThreadItem[] {
  const out: ThreadItem[] = [];
  const calls = new Map<string, RawToolCallItem>();
  const callStartedAt = new Map<string, number>();

  let index = -1;
  let part = 0;
  const nextId = () => `${keyPrefix}-${index}-${part++}`;

  const context = (origin: string, label: string, text: string) => {
    if (!text.trim()) return;
    out.push({
      type: "contextEntry",
      id: nextId(),
      label,
      origin,
      text,
    } as ThreadItem);
  };

  for (const entry of entries) {
    index += 1;
    part = 0;

    const kind = String(entry.type ?? "");
    const entryAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    const timestamp = Number.isFinite(entryAt) ? entryAt : undefined;
    if (!kind) continue;

    if (kind !== "message") {
      // Session bookkeeping, any entry type a newer pi introduces becomes a
      // card rather than vanishing.
      const body =
        kind === "session"
          ? [
              String(entry.cwd ?? ""),
              entry.parentSession ? `forked from ${entry.parentSession}` : "",
            ]
              .filter(Boolean)
              .join("\n") || stringify(entry)
          : typeof entry.summary === "string" && entry.summary
            ? entry.summary
            : typeof entry.content === "string" || Array.isArray(entry.content)
              ? bodyText(entry.content)
              : stringify(entry);
      context(kind, metaLabel(entry), body);
      continue;
    }

    const message = entry.message ?? {};
    const role = String(message.role ?? "");

    if (role === "user") {
      // Every user-role message is something somebody sent: pi injects
      // context into the system prompt, not the conversation.
      const images = imagesOf(message.content);
      out.push({
        type: "userMessage",
        id: nextId(),
        content: [{ type: "text", text: bodyText(message.content) }],
        ...(images.length ? { images } : {}),
      } as ThreadItem);
      continue;
    }

    if (role === "assistant") {
      for (const p of parts(message.content)) {
        const pk = String(p.type ?? "");
        if (pk === "text") {
          out.push({
            type: "agentMessage",
            id: nextId(),
            text: String(p.text ?? ""),
          } as ThreadItem);
          continue;
        }
        if (pk === "thinking") {
          const thought = String(p.thinking ?? "");
          if (thought.trim()) {
            out.push({
              type: "reasoning",
              id: nextId(),
              summary: [thought],
            } as ThreadItem);
          } else {
            // Some providers leave only an encrypted signature: a marker is
            // the honest maximum.
            context("reasoning", "Thought (encrypted)", stringify(p));
          }
          continue;
        }
        if (pk === "image") {
          const images = imagesOf([p]);
          if (images.length) {
            out.push({
              type: "agentMessage",
              id: nextId(),
              text: "",
              images,
            } as ThreadItem);
            continue;
          }
        }
        if (pk === "toolCall") {
          const tool = String(p.name ?? "tool");
          const { label, explored } = piToolSummary(tool, p.arguments);
          const item: RawToolCallItem = {
            type: "rawToolCall",
            id: nextId(),
            tool,
            namespace: null,
            input: stringify(p.arguments),
            output: "",
            // Only the toolResult entry says the work is done.
            status: "inProgress",
            rawType: pk,
            summary: label,
            explored,
          };
          if (p.id) {
            calls.set(String(p.id), item);
            if (timestamp !== undefined)
              callStartedAt.set(String(p.id), timestamp);
          } else item.status = "completed";
          out.push(item as ThreadItem);
          continue;
        }
        // A content part this build has never seen still shows up.
        context(
          "assistant part",
          `Message part — ${pk || "part"}`,
          stringify(p),
        );
      }
      // A turn that ended badly says so on the message, not in a part.
      const stop = String(message.stopReason ?? "");
      if (stop === "error" || stop === "aborted") {
        context(
          "turn end",
          stop === "aborted" ? "Turn aborted" : "Turn error",
          String(message.errorMessage ?? "") || stringify(message),
        );
      }
      continue;
    }

    if (role === "toolResult") {
      const call = message.toolCallId
        ? calls.get(String(message.toolCallId))
        : undefined;
      const images = imagesOf(message.content);
      // With the images pulled out, the stringify fallback would only restate
      // their base64, so an image-only result keeps an empty text body.
      const text =
        bodyText(message.content) ||
        (message.content && !images.length ? stringify(message.content) : "");
      if (!call) {
        // The call is above the window read so far, better a card than a
        // silently dropped output.
        context(
          "tool result",
          `Tool result — ${String(message.toolName ?? message.toolCallId ?? "unpaired")}`,
          text,
        );
        continue;
      }
      call.output = text;
      if (images.length) call.images = images;
      call.status = message.isError ? "failed" : "completed";
      const startedAt = message.toolCallId
        ? callStartedAt.get(String(message.toolCallId))
        : undefined;
      if (
        startedAt !== undefined &&
        timestamp !== undefined &&
        timestamp >= startedAt
      ) {
        call.durationMs = timestamp - startedAt;
      }
      continue;
    }

    if (role === "bashExecution") {
      // A `!command` the user ran from the TUI: a complete call-with-output in
      // one entry, so it renders as an already-finished tool card.
      const command = String(message.command ?? "");
      out.push({
        type: "rawToolCall",
        id: nextId(),
        tool: "bash",
        namespace: null,
        input: command,
        output: String(message.output ?? ""),
        status: message.cancelled ? "failed" : "completed",
        rawType: "bashExecution",
        summary: command ? `bash ${command}` : "bash",
        explored: isExploratoryCommand(command),
      } as ThreadItem);
      continue;
    }

    if (role === "branchSummary" || role === "compactionSummary") {
      context(
        role,
        role === "branchSummary" ? "Branch summary" : "Compaction summary",
        String(message.summary ?? "") || stringify(message),
      );
      continue;
    }

    if (role === "custom") {
      context(
        "custom",
        `Extension — ${String(message.customType ?? "custom")}`,
        bodyText(message.content) || stringify(message),
      );
      continue;
    }

    // A message role this build has never seen still shows up.
    context(
      "message",
      `Message — ${firstWords(role || "unknown role")}`,
      stringify(message),
    );
  }

  return out;
}

// pi appends a `session_info` entry every time the session is named, so the
// last one is the name it has now.
export function piSessionName(entries: PiEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "session_info") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name) return name;
  }
  return "";
}

function piBreakdown(usage: Record<string, unknown>): TokenBreakdown | null {
  const num = (key: string) => Number(usage[key] ?? 0) || 0;
  const cost = (usage.cost ?? {}) as Record<string, unknown>;
  const reported = Number(cost.total ?? NaN);
  const total =
    num("totalTokens") || num("input") + num("output") + num("cacheRead");
  if (total <= 0) return null;
  return {
    input: num("input"),
    cacheRead: num("cacheRead"),
    cacheWrite: num("cacheWrite"),
    cacheWrite1h: 0,
    output: num("output"),
    reasoning: num("reasoning"),
    total,
    cost: Number.isFinite(reported) ? reported : null,
  };
}

export function piFacts(entries: PiEntry[]): {
  model: string;
  effort: string;
  cwd: string;
  tokens: SessionTokens | null;
} {
  let model = "";
  let effort = "";
  let cwd = "";
  let last: TokenBreakdown | null = null;
  const session = emptyBreakdown();

  for (const entry of entries) {
    if (entry.type === "session" && typeof entry.cwd === "string")
      cwd = entry.cwd;
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!effort && entry.type === "thinking_level_change") {
      effort = String(entry.thinkingLevel ?? "");
    }
    if (!model && entry.type === "model_change" && entry.modelId) {
      model = `${String(entry.provider ?? "")}/${String(entry.modelId)}`;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant")
      continue;
    if (!model && typeof entry.message.model === "string") {
      const provider = String(entry.message.provider ?? "");
      model = provider
        ? `${provider}/${entry.message.model}`
        : entry.message.model;
    }
    if (!entry.message.usage) continue;
    const usage = piBreakdown(entry.message.usage as Record<string, unknown>);
    if (!usage) continue;
    if (!last) last = usage;
    addBreakdown(session, usage);
  }

  return {
    model,
    effort,
    cwd,
    tokens: last ? { last, session, window: 0 } : null,
  };
}

import { isExploratoryCommand } from "./rollout";
import type { EmbeddedImage, RawToolCallItem, ThreadItem } from "./types";

export interface ClaudeEntry {
  type?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
    [k: string]: unknown;
  };

  promptSource?: string;
  origin?: { kind?: string };

  isMeta?: boolean;

  isSidechain?: boolean;
  isCompactSummary?: boolean;
  toolUseResult?: unknown;
  attachment?: { type?: string; [k: string]: unknown };
  cwd?: string;
  version?: string;
  sessionId?: string;
  timestamp?: string;
  [k: string]: unknown;
}

interface Part {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}

const DUPLICATE_ENTRIES = new Set(["queue-operation", "last-prompt"]);

const LABEL_KEYS = [
  "command",
  "file_path",
  "pattern",
  "url",
  "query",
  "path",
  "description",
  "skill",
  "prompt",
];

const READ_ONLY_TOOLS = new Set([
  "Read",
  "NotebookRead",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "BashOutput",
  "ToolSearch",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
]);

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function imagesOf(value: unknown): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  for (const part of parts(
    (value as { content?: unknown })?.content ?? value,
  )) {
    if (String(part.type ?? "") !== "image") continue;
    const source = (
      part as { source?: { type?: string; media_type?: string; data?: string } }
    ).source;
    if (
      source?.type !== "base64" ||
      typeof source.data !== "string" ||
      !source.data
    )
      continue;
    out.push({
      mime: String(source.media_type ?? "image/png"),
      data: source.data,
    });
  }
  return out;
}

function withoutImages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter(
    (part) =>
      String((part as Part)?.type ?? "") !== "image" ||
      (part as { source?: { type?: string } })?.source?.type !== "base64",
  );
}

function parts(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as Part[];
  if (content && typeof content === "object") return [content as Part];
  return [];
}

function bodyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === "string" ? part : String((part as Part)?.text ?? ""),
      )
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const body = value as { content?: unknown; text?: unknown };
    if (body.content !== undefined) return bodyText(body.content);
    if (typeof body.text === "string") return body.text;
    return stringify(value);
  }
  return "";
}

function toolSummary(
  tool: string,
  input: unknown,
): { label: string; explored: boolean } {
  const args = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const pick = LABEL_KEYS.find((k) => typeof args[k] === "string" && args[k]);
  let label = pick ? String(args[pick]) : "";
  if (!label) {
    const first = Object.entries(args).find(
      ([, v]) => typeof v === "string" && v,
    );
    label = first ? String(first[1]) : "";
  }
  if (
    tool === "Grep" &&
    typeof args.path === "string" &&
    args.path &&
    args.pattern
  ) {
    label = `${String(args.pattern)} in ${String(args.path)}`;
  }
  const explored =
    READ_ONLY_TOOLS.has(tool) ||
    (tool === "Bash" && typeof args.command === "string"
      ? isExploratoryCommand(args.command)
      : false);
  // A `Bash` heading drops the tool name (the ⌘/🔍 already say it ran) and
  // prefers `description` to `command`: a truncated `&&` chain is usually just
  // the `cd` that started it, and the command is still the card's body.
  if (tool === "Bash") {
    const described =
      typeof args.description === "string" ? args.description.trim() : "";
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const shell = described || command;
    return { label: shell || tool, explored };
  }
  return { label: label ? `${tool} ${label}` : tool, explored };
}

function isTyped(entry: ClaudeEntry): boolean {
  if (!entry.promptSource || entry.isMeta) return false;
  const kind = entry.origin?.kind;
  return kind === undefined || kind === "human";
}

function partLabel(part: Part): string {
  const kind = String(part.type ?? "part");
  if (kind === "text") return firstWords(String(part.text ?? ""));
  if (kind === "thinking")
    return `thinking — ${firstWords(String(part.thinking ?? ""))}`;
  if (kind.endsWith("tool_use")) return `${String(part.name ?? "tool")} call`;
  if (kind.endsWith("tool_result")) return "tool result";
  return kind;
}

function firstWords(text: string, max = 48): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line || "(empty)";
}

function metaLabel(entry: ClaudeEntry): string {
  const kind = String(entry.type ?? "entry");
  switch (kind) {
    case "attachment": {
      const at = String(entry.attachment?.type ?? "attachment").replace(
        /[_-]+/g,
        " ",
      );
      return `Attached — ${at}`;
    }
    case "system":
      return `System — ${firstWords(bodyText(entry.content ?? entry.message))}`;
    case "ai-title":
      return `Session title — ${String(entry.aiTitle ?? "")}`;
    case "summary":
      return `Summary — ${String(entry.summary ?? "")}`;
    case "mode":
      return `Mode — ${String(entry.mode ?? "")}`;
    case "permission-mode":
      return `Permission mode — ${String(entry.permissionMode ?? "")}`;
    case "file-history-snapshot":
      return "File history snapshot";
    default:
      return `Session entry — ${kind}`;
  }
}

export function renderClaudeSession(
  entries: ClaudeEntry[],
  keyPrefix = "c",
): ThreadItem[] {
  const out: ThreadItem[] = [];
  const calls = new Map<string, RawToolCallItem>();
  const callStartedAt = new Map<string, number>();

  let index = -1;
  let part = 0;
  const nextId = () => `${keyPrefix}-${index}-${part++}`;

  const context = (
    origin: string,
    label: string,
    text: string,
    entryType?: string,
  ) => {
    if (!text.trim()) return;
    out.push({
      type: "contextEntry",
      id: nextId(),
      label,
      origin,
      text,
      ...(entryType ? { entryType } : {}),
    } as ThreadItem);
  };

  const foldResult = (p: Part, finishedAt?: number) => {
    const call = p.tool_use_id ? calls.get(String(p.tool_use_id)) : undefined;
    // Images are pulled out before the stringify fallback runs, or a
    // screenshot's base64 lands in the card as a wall of text.
    const images = imagesOf(p.content);
    const remainder = images.length ? withoutImages(p.content) : p.content;
    // A result with no text parts at all (e.g. `tool_reference` parts) would
    // otherwise fold in as an empty output.
    const hasRemainder = Array.isArray(remainder)
      ? remainder.length > 0
      : Boolean(remainder);
    const text =
      bodyText(remainder) || (hasRemainder ? stringify(remainder) : "");
    if (!call) {
      // The call is above the window read so far, better a card than a
      // silently dropped output.
      context(
        "tool result",
        `Tool result — ${String(p.tool_use_id ?? "unpaired")}`,
        text,
      );
      return;
    }
    call.output = text;
    if (images.length) call.images = images;
    call.status = p.is_error ? "failed" : "completed";
    const startedAt = p.tool_use_id
      ? callStartedAt.get(String(p.tool_use_id))
      : undefined;
    if (
      startedAt !== undefined &&
      finishedAt !== undefined &&
      finishedAt >= startedAt
    ) {
      call.durationMs = finishedAt - startedAt;
    }
  };

  for (const entry of entries) {
    index += 1;
    part = 0;

    const kind = String(entry.type ?? "");
    const entryAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    const timestamp = Number.isFinite(entryAt) ? entryAt : undefined;
    if (!kind || DUPLICATE_ENTRIES.has(kind)) continue;

    if (kind !== "user" && kind !== "assistant") {
      // Session bookkeeping, any entry type a newer claude introduces becomes
      // a card rather than vanishing.
      const body =
        kind === "attachment"
          ? stringify(entry.attachment)
          : bodyText(entry.content) || stringify(entry);
      // An attachment is filtered by *its* type rather than by being an
      // attachment, so an unknown type arrives with a checkbox of its own.
      const entryType =
        kind === "attachment"
          ? `attachment:${String(entry.attachment?.type ?? "attachment")}`
          : kind;
      context(kind, metaLabel(entry), body, entryType);
      continue;
    }

    const content = parts(entry.message?.content);

    // A subagent's turn is shown as cards: interleaving another agent's
    // messages as chat bubbles would read as the main thread talking to itself.
    if (entry.isSidechain) {
      for (const p of content) {
        const body =
          p.type === "text"
            ? String(p.text ?? "")
            : p.type === "thinking"
              ? String(p.thinking ?? "")
              : stringify(p);
        context("sidechain", `Subagent ${partLabel(p)}`, body);
      }
      continue;
    }

    if (kind === "user") {
      const results = content.filter((p) =>
        String(p.type ?? "").endsWith("tool_result"),
      );
      if (results.length) {
        for (const p of results) foldResult(p, timestamp);
        // Anything else riding along with a result still gets shown.
        for (const p of content) {
          if (String(p.type ?? "").endsWith("tool_result")) continue;
          context("tool result", `With result — ${partLabel(p)}`, stringify(p));
        }
        continue;
      }

      const text = bodyText(entry.message?.content);
      if (isTyped(entry)) {
        const images = imagesOf(entry.message?.content);
        out.push({
          type: "userMessage",
          id: nextId(),
          content: [{ type: "text", text }],
          ...(images.length ? { images } : {}),
        } as ThreadItem);
        continue;
      }
      // Claude speaking on the user's behalf, shown, but as a card.
      const origin = entry.origin?.kind
        ? `injected ${entry.origin.kind}`
        : "injected context";
      context(origin, firstWords(text, 62) || "Context", text);
      continue;
    }

    for (const p of content) {
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
        out.push({
          type: "reasoning",
          id: nextId(),
          summary: [String(p.thinking ?? "")].filter(Boolean),
        } as ThreadItem);
        continue;
      }
      if (pk === "redacted_thinking") {
        context("reasoning", "Thought (redacted)", stringify(p));
        continue;
      }
      if (pk.endsWith("tool_result")) {
        // `web_search_tool_result` and friends arrive inside the assistant's
        // own message rather than in a following user entry.
        foldResult(p, timestamp);
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
      if (pk === "tool_use" || pk.endsWith("_tool_use")) {
        const tool = String(p.name ?? pk);
        const { label, explored } = toolSummary(tool, p.input);
        const item: RawToolCallItem = {
          type: "rawToolCall",
          id: nextId(),
          tool,
          namespace: null,
          input: stringify(p.input),
          output: "",
          // Only the result says the work is done.
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
      context("assistant part", `Message part — ${partLabel(p)}`, stringify(p));
    }
  }

  return out;
}

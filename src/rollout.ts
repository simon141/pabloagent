import type { EmbeddedImage, RawToolCallItem, ThreadItem } from "./types";

export interface RolloutEntry {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string; image_url?: string }>;
    name?: string;
    namespace?: string;
    status?: string;
    call_id?: string;
    input?: string;
    arguments?: string;
    output?: unknown;
    summary?: Array<{ text?: string } | string>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

const OUTPUT_TYPES = new Set([
  "custom_tool_call_output",
  "function_call_output",
  "tool_search_output",
]);

const DUPLICATE_EVENTS = new Set([
  "agent_message",
  "user_message",
  "token_count",
]);

const META_ENTRIES = new Set(["session_meta", "turn_context", "world_state"]);

export function parseRolloutLines(text: string): RolloutEntry[] {
  const out: RolloutEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RolloutEntry);
    } catch {
      // A rollout being appended to as we read it can end mid-line.
    }
  }
  return out;
}

function contextLabel(text: string): string {
  const tag = text.match(/^\s*<([a-z][a-z_ -]*)>/i);
  if (tag) {
    const words = tag[1].replace(/[_-]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  const heading = text.match(/^\s*#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const first = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return first.length > 70 ? `${first.slice(0, 70)}…` : first || "Context";
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function metaLabel(kind: string, p: Record<string, unknown>): string {
  if (kind === "session_meta") {
    const model = p.originator ? ` · ${p.originator}` : "";
    return `Session start — ${String(p.cli_version ?? "")}${model}`;
  }
  if (kind === "turn_context") {
    return `Turn settings — ${String(p.model ?? "")} · ${String(
      p.approval_policy ?? "",
    )}`;
  }
  if (kind === "world_state") return "Workspace state";
  if (!META_ENTRIES.has(kind)) return `Rollout entry — ${kind}`;
  return kind;
}

function eventLabel(kind: string, p: Record<string, unknown>): string {
  switch (kind) {
    case "task_started":
      return "Turn started";
    case "task_complete": {
      const ms = Number(p.duration_ms ?? 0);
      return `Turn complete${ms ? ` — ${Math.round(ms / 1000)}s` : ""}`;
    }
    case "patch_apply_end":
      return `Patch applied — ${p.success === false ? "failed" : "ok"}`;
    case "thread_settings_applied":
      return "Thread settings applied";
    default:
      return `Event — ${kind}`;
  }
}

function bodyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === "string"
          ? part
          : String((part as { text?: string })?.text ?? ""),
      )
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const body = value as { content?: unknown; text?: unknown };
    if (body.content !== undefined) return bodyText(body.content);
    if (typeof body.text === "string") return body.text;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return "";
}

function imagesOf(value: unknown): EmbeddedImage[] {
  if (!Array.isArray(value)) return [];
  const out: EmbeddedImage[] = [];
  for (const part of value) {
    const url = String((part as { image_url?: unknown })?.image_url ?? "");
    const match = url.match(
      /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/,
    );
    if (match) out.push({ mime: match[1], data: match[2] });
  }
  return out;
}

function wallTimeMs(text: string): number | undefined {
  const match = text.match(
    /\bWall time:?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s)\b/i,
  );
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return /^m/i.test(match[2]) ? value : value * 1000;
}

function elapsedMs(
  start: string | undefined,
  end: string | undefined,
): number | undefined {
  const from = start ? Date.parse(start) : NaN;
  const to = end ? Date.parse(end) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? to - from
    : undefined;
}

export interface ExecSnippet {
  title: string | null;
  commands: string[];
  notes: string[];
}

const EXEC_PLUMBING = new Set(["yield_time_ms", "max_output_tokens"]);

export function execSnippet(input: string): ExecSnippet | null {
  let code = input;
  let title: string | null = null;
  try {
    const outer = JSON.parse(input) as { title?: unknown; code?: unknown };
    if (outer && typeof outer.code === "string") {
      code = outer.code;
      if (typeof outer.title === "string" && outer.title.trim())
        title = outer.title.trim();
    }
  } catch {
    // The common shape: the input is the snippet itself.
  }
  const commands: string[] = [];
  const notes: string[] = [];
  for (const objText of execArgObjects(code)) {
    const args = parseArgObject(objText);
    const cmd = args?.cmd;
    if (typeof cmd !== "string" || !cmd.trim()) continue;
    commands.push(cmd);
    for (const [key, value] of Object.entries(args ?? {})) {
      if (key === "cmd" || EXEC_PLUMBING.has(key)) continue;
      if (value === null || value === undefined || value === "") continue;
      const note = `${key}: ${typeof value === "string" ? value : stringify(value)}`;
      if (!notes.includes(note)) notes.push(note);
    }
  }
  return commands.length ? { title, commands, notes } : null;
}

function execArgObjects(code: string): string[] {
  const out: string[] = [];
  const call = /exec_command\s*\(\s*\{/g;
  let match: RegExpExecArray | null = call.exec(code);
  while (match) {
    const open = match.index + match[0].length - 1;
    const close = closeOfObject(code, open);
    if (close >= 0) {
      out.push(code.slice(open, close + 1));
      call.lastIndex = close;
    }
    match = call.exec(code);
  }
  return out;
}

function closeOfObject(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseArgObject(objText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(objText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // JS-style literal; fall through to the string-property scan.
  }
  const out: Record<string, unknown> = {};
  const prop =
    /["']?([A-Za-z_$][\w$]*)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let m: RegExpExecArray | null = prop.exec(objText);
  while (m) {
    out[m[1]] = jsString(m[2]);
    m = prop.exec(objText);
  }
  return Object.keys(out).length ? out : null;
}

function jsString(literal: string): string {
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return literal.slice(1, -1);
    }
  }
  return literal
    .slice(1, -1)
    .replace(/\\(.)/g, (_, ch: string) =>
      ch === "n" ? "\n" : ch === "t" ? "\t" : ch,
    );
}

export function execSummary(input: string): string | null {
  const exec = execSnippet(input);
  if (exec) return exec.title ?? exec.commands[0];
  if (/\bapply_patch\s*\(/.test(input)) {
    const file = input.match(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/);
    return file ? `apply_patch ${file[1]}` : "apply_patch";
  }
  const stdin = input.match(/write_stdin\(\s*\{\s*session_id\s*:\s*(\d+)/);
  if (stdin) return `write_stdin → session ${stdin[1]}`;
  return null;
}

export function isExploratoryCommand(command: string): boolean {
  const bare = command
    .replace(/^\/usr\/bin\/bash\s+-lc\s+/, "")
    .replace(/^bash\s+-lc\s+/, "")
    .replace(/^['"]/, "")
    .trim();
  return /^(cat|sed|head|tail|less|ls|find|tree|rg|grep|ag|fd|wc|stat|file|pwd|git\s+(status|log|diff|show|branch))\b/.test(
    bare,
  );
}

function typedMessages(entries: RolloutEntry[]): Set<string> {
  const typed = new Set<string>();
  for (const entry of entries) {
    const p = entry.payload ?? {};
    if (entry.type !== "event_msg") continue;
    let text = "";
    if (p.type === "user_message") {
      text = typeof p.message === "string" ? p.message : bodyText(p.message);
    } else if (p.type === "item_completed") {
      const item = p.item as { type?: string } | undefined;
      if (item?.type !== "UserMessage") continue;
      text = bodyText(item);
    } else {
      continue;
    }
    if (text.trim()) typed.add(normalise(text));
  }
  return typed;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function renderRollout(
  entries: RolloutEntry[],
  keyPrefix = "r",
): ThreadItem[] {
  const typed = typedMessages(entries);
  const out: ThreadItem[] = [];
  const calls = new Map<string, RawToolCallItem>();
  const callStatus = new Map<string, string>();
  const callStartedAt = new Map<string, string | undefined>();

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
    const p = entry.payload ?? {};

    // Unrecognised top-level kinds land here too, so a new rollout entry type
    // shows up as a card instead of being dropped.
    if (
      entry.type &&
      entry.type !== "response_item" &&
      entry.type !== "event_msg"
    ) {
      context(entry.type, metaLabel(entry.type, p), stringify(p));
      continue;
    }

    if (entry.type === "event_msg") {
      const kind = String(p.type ?? "event");
      if (DUPLICATE_EVENTS.has(kind)) continue;
      context(`event/${kind}`, eventLabel(kind, p), stringify(p));
      continue;
    }

    const kind = String(p.type ?? "");
    if (!kind) continue;

    if (kind === "message") {
      const parts = Array.isArray(p.content) ? p.content : [];
      const text = bodyText(p.content);
      // Shown as context cards, not chat, one card per part, since each is an
      // independent block with its own heading.
      if (p.role === "developer" || p.role === "system") {
        for (const part of parts) {
          const body = String(part?.text ?? "");
          context(String(p.role), contextLabel(body), body);
        }
        if (!parts.length) context(String(p.role), "System prompt", text);
        continue;
      }
      const images = imagesOf(p.content);
      if (p.role === "assistant") {
        out.push({
          type: "agentMessage",
          id: nextId(),
          text,
          ...(images.length ? { images } : {}),
        } as ThreadItem);
        continue;
      }
      // A user entry carrying an attached image is always something sent,
      // the injected blocks are text.
      if (typed.has(normalise(text)) || (images.length && text.trim() === "")) {
        out.push({
          type: "userMessage",
          id: nextId(),
          content: [{ type: "text", text }],
          ...(images.length ? { images } : {}),
        } as ThreadItem);
        continue;
      }
      for (const part of parts) {
        const body = String(part?.text ?? "");
        context("injected context", contextLabel(body), body);
      }
      if (!parts.length) context("injected context", contextLabel(text), text);
      continue;
    }

    if (kind === "reasoning") {
      const summary = (p.summary ?? [])
        .map((s) => (typeof s === "string" ? s : String(s?.text ?? "")))
        .filter(Boolean);
      if (summary.length) {
        out.push({
          type: "reasoning",
          id: nextId(),
          summary,
        } as ThreadItem);
        continue;
      }
      // Only `encrypted_content` survives on disk, so a marker per thinking
      // step is the honest maximum.
      context("reasoning", "Thought (encrypted)", stringify(p));
      continue;
    }

    if (OUTPUT_TYPES.has(kind)) {
      const call = p.call_id ? calls.get(p.call_id) : undefined;
      if (call) {
        call.output = bodyText(p.output);
        call.durationMs =
          wallTimeMs(call.output) ??
          elapsedMs(callStartedAt.get(String(p.call_id)), entry.timestamp);
        // The call entry's own `status` reads "completed" from the moment
        // codex writes it, so the output arriving is the only signal the work
        // is done.
        call.status = callStatus.get(String(p.call_id)) ?? "completed";
      }
      continue;
    }

    // Known call kinds and anything unrecognised both land here, so a response
    // item a future codex introduces is shown rather than skipped.
    const input = String(p.input ?? p.arguments ?? "");
    const item: RawToolCallItem = {
      type: "rawToolCall",
      id: nextId(),
      tool: String(p.name ?? kind),
      namespace: p.namespace ? String(p.namespace) : null,
      input: input || bodyText(p.content ?? p.output),
      output: "",
      status: "inProgress",
      rawType: kind,
    };
    if (p.call_id) {
      calls.set(String(p.call_id), item);
      callStartedAt.set(String(p.call_id), entry.timestamp);
      if (p.status) callStatus.set(String(p.call_id), String(p.status));
    } else {
      // No call id means no output entry will ever be paired with it, so it is
      // as done as it will ever be.
      item.status = String(p.status ?? "completed");
    }
    out.push(item as ThreadItem);
  }

  return out;
}

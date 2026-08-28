import {
  addBreakdown,
  emptyBreakdown,
  type SessionTokens,
  type TokenBreakdown,
} from "./context";
import { isExploratoryCommand } from "./rollout";
import type { RawToolCallItem, ThreadItem } from "./types";

export interface OpencodeEntry {
  kind?: string;
  type?: string;
  id?: string;
  messageId?: string;
  sessionID?: string;
  data?: Record<string, unknown>;
  part?: Record<string, unknown>;
  error?: { name?: string; data?: { message?: string }; [k: string]: unknown };
  [k: string]: unknown;
}

interface Part {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    title?: string;
    error?: string;
    time?: { start?: number; end?: number };
    [k: string]: unknown;
  };
  reason?: string;
  tokens?: { total?: number; [k: string]: unknown };
  cost?: number;
  [k: string]: unknown;
}

const READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "websearch",
  "todoread",
]);

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function firstWords(text: string, max = 48): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line || "(empty)";
}

function opencodeToolSummary(
  tool: string,
  state: Part["state"],
): { label: string; explored: boolean } {
  const input = (
    state?.input && typeof state.input === "object" ? state.input : {}
  ) as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : "";
  let label =
    typeof state?.title === "string" && state.title ? state.title : "";
  if (!label) {
    const keys = [
      "command",
      "filePath",
      "pattern",
      "url",
      "query",
      "path",
      "description",
    ];
    const pick = keys.find((k) => typeof input[k] === "string" && input[k]);
    label = pick ? String(input[pick]) : "";
  }
  const explored =
    READ_ONLY_TOOLS.has(tool) ||
    (tool === "bash" && command ? isExploratoryCommand(command) : false);
  return { label: label ? `${tool} ${label}` : tool, explored };
}

type Role = "user" | "assistant";

export function renderOpencodeSession(
  entries: OpencodeEntry[],
  keyPrefix = "o",
): ThreadItem[] {
  const order: string[] = [];
  const nodes = new Map<string, ThreadItem>();
  const roles = new Map<string, Role>();
  let synth = 0;

  const upsert = (id: string, node: ThreadItem) => {
    if (!nodes.has(id)) order.push(id);
    nodes.set(id, node);
  };

  const nextSynthetic = () => `${keyPrefix}-x-${synth++}`;

  const renderPart = (id: string, messageId: string, part: Part) => {
    const nodeId = `${keyPrefix}-${id}`;
    const kind = String(part.type ?? "");
    const role: Role = roles.get(messageId) ?? "assistant";

    if (kind === "text") {
      const text = String(part.text ?? "");
      if (role === "user") {
        upsert(nodeId, {
          type: "userMessage",
          id: nodeId,
          content: [{ type: "text", text }],
        } as ThreadItem);
      } else {
        upsert(nodeId, {
          type: "agentMessage",
          id: nodeId,
          text,
        } as ThreadItem);
      }
      return;
    }
    if (kind === "reasoning") {
      upsert(nodeId, {
        type: "reasoning",
        id: nodeId,
        summary: [String(part.text ?? "")].filter(Boolean),
      } as ThreadItem);
      return;
    }
    if (kind === "tool") {
      const tool = String(part.tool ?? "tool");
      const state = part.state ?? {};
      const { label, explored } = opencodeToolSummary(tool, state);
      const status = String(state.status ?? "");
      const start = Number(state.time?.start);
      const end = Number(state.time?.end);
      const item: RawToolCallItem = {
        type: "rawToolCall",
        id: nodeId,
        tool,
        namespace: null,
        input: stringify(state.input ?? {}),
        output: String(state.output ?? state.error ?? ""),
        status:
          status === "completed"
            ? "completed"
            : status === "error"
              ? "failed"
              : "inProgress",
        rawType: "tool",
        summary: label,
        explored,
        durationMs:
          Number.isFinite(start) && Number.isFinite(end) && end >= start
            ? end - start
            : undefined,
      };
      upsert(nodeId, item as ThreadItem);
      return;
    }
    if (kind === "step-start") {
      // {"type":"step-start"} is the entire part, nothing a card could show
      // that the step-finish does not.
      return;
    }
    if (kind === "step-finish") {
      const tokens = Number(part.tokens?.total ?? 0);
      upsert(nodeId, {
        type: "contextEntry",
        id: nodeId,
        label: `Step ${String(part.reason ?? "finished")}${
          tokens ? ` — ${tokens.toLocaleString()} tokens` : ""
        }`,
        origin: "step-finish",
        text: stringify(part),
      } as ThreadItem);
      return;
    }
    // `patch`, `file`, and any part type a newer opencode introduces: a card
    // rather than a silent drop.
    upsert(nodeId, {
      type: "contextEntry",
      id: nodeId,
      label: `Part — ${kind || "unknown"}`,
      origin: "opencode part",
      text: stringify(part),
    } as ThreadItem);
  };

  for (const entry of entries) {
    if (entry.kind === "message") {
      const role = String(
        (entry.data as { role?: string } | undefined)?.role ?? "",
      );
      if (entry.id)
        roles.set(String(entry.id), role === "user" ? "user" : "assistant");
      // The message row itself renders nothing: its parts are the content, and
      // its facts (model, tokens, cwd) feed the status line via sessionFacts.
      continue;
    }
    if (entry.kind === "part") {
      const id = String(entry.id ?? "") || nextSynthetic();
      renderPart(id, String(entry.messageId ?? ""), (entry.data ?? {}) as Part);
      continue;
    }

    if (entry.part && typeof entry.part === "object") {
      const part = entry.part as Part & { id?: string; messageID?: string };
      const id = String(part.id ?? "") || nextSynthetic();
      renderPart(id, String(part.messageID ?? ""), part);
      continue;
    }
    if (entry.type === "error" || entry.error) {
      const id = nextSynthetic();
      const message = String(entry.error?.data?.message ?? "");
      upsert(id, {
        type: "contextEntry",
        id,
        label: `Error — ${firstWords(message || String(entry.error?.name ?? "error"), 50)}`,
        origin: "opencode error",
        text: stringify(entry.error ?? entry),
      } as ThreadItem);
      continue;
    }
    // An event or line shape this build has never seen still shows up.
    const id = nextSynthetic();
    upsert(id, {
      type: "contextEntry",
      id,
      label: `Session entry — ${String(entry.type ?? entry.kind ?? "unknown")}`,
      origin: "opencode event",
      text: stringify(entry),
    } as ThreadItem);
  }

  return order.map((id) => nodes.get(id)).filter(Boolean) as ThreadItem[];
}

function opencodeBreakdown(
  tokens: Record<string, unknown> | undefined,
  cost: unknown,
): TokenBreakdown | null {
  if (!tokens) return null;
  const num = (value: unknown) => Number(value ?? 0) || 0;
  const cache = tokens.cache as Record<string, unknown> | undefined;
  const output = num(tokens.output);
  const reasoning = num(tokens.reasoning);
  const cacheRead = num(cache?.read);
  const total =
    num(tokens.total) || num(tokens.input) + output + reasoning + cacheRead;
  if (total <= 0) return null;
  return {
    input: num(tokens.input),
    cacheRead,
    cacheWrite: num(cache?.write),
    cacheWrite1h: 0,
    output: output + reasoning,
    reasoning,
    total,
    cost: typeof cost === "number" ? cost : null,
  };
}

export function opencodeFacts(entries: OpencodeEntry[]): {
  model: string;
  cwd: string;
  tokens: SessionTokens | null;
} {
  let model = "";
  let cwd = "";
  let last: TokenBreakdown | null = null;
  const steps = new Map<string, Map<string, TokenBreakdown>>();
  const rows = new Map<string, TokenBreakdown>();

  for (const entry of entries) {
    const data = (entry.kind === "message" ? entry.data : undefined) as
      | {
          model?: { providerID?: string; modelID?: string };
          modelID?: string;
          providerID?: string;
          path?: { cwd?: string };
          tokens?: Record<string, unknown>;
          cost?: unknown;
        }
      | undefined;
    const part = (entry.kind === "part" ? entry.data : entry.part) as
      | Part
      | undefined;

    if (data) {
      const provider = data.model?.providerID ?? data.providerID ?? "";
      const id = data.model?.modelID ?? data.modelID ?? "";
      if (id) model = provider ? `${provider}/${id}` : id;
      if (data.path?.cwd) cwd = String(data.path.cwd);
      const usage = opencodeBreakdown(data.tokens, data.cost);
      if (usage) {
        last = usage;
        if (entry.id) rows.set(entry.id, usage);
      }
    }
    if (part?.type === "step-finish") {
      const usage = opencodeBreakdown(part.tokens, part.cost);
      if (usage) {
        last = usage;
        const partId = String(part.id ?? entry.id ?? "");
        const messageId = String(part.messageID ?? entry.messageId ?? partId);
        const forMessage =
          steps.get(messageId) ?? new Map<string, TokenBreakdown>();
        forMessage.set(partId, usage);
        steps.set(messageId, forMessage);
      }
    }
  }

  const session = emptyBreakdown();
  for (const [messageId, row] of rows) {
    if (!steps.has(messageId)) addBreakdown(session, row);
  }
  for (const forMessage of steps.values()) {
    for (const usage of forMessage.values()) addBreakdown(session, usage);
  }

  return { model, cwd, tokens: last ? { last, session, window: 0 } : null };
}

import { type ClaudeEntry, renderClaudeSession } from "./claude-rollout";
import {
  addBreakdown,
  costOf,
  emptyBreakdown,
  type SessionTokens,
  type TokenBreakdown,
} from "./context";
import type { Harness } from "./harness";
import {
  type OpencodeEntry,
  opencodeFacts,
  renderOpencodeSession,
} from "./opencode-rollout";
import { type PiEntry, piFacts, renderPiSession } from "./pi-rollout";
import { parseRolloutLines, type RolloutEntry, renderRollout } from "./rollout";
import type { ThreadItem } from "./types";

export type SessionEntry = RolloutEntry & ClaudeEntry & OpencodeEntry & PiEntry;

export function parseSessionLines(text: string): SessionEntry[] {
  return parseRolloutLines(text) as SessionEntry[];
}

const encoder = new TextEncoder();

export function wholeLineBytes(text: string): number {
  const end = text.lastIndexOf("\n");
  return end < 0 ? 0 : encoder.encode(text.slice(0, end + 1)).length;
}

export function renderSession(
  harness: Harness,
  entries: SessionEntry[],
  keyPrefix = "s",
): ThreadItem[] {
  if (harness === "claude")
    return renderClaudeSession(entries as ClaudeEntry[], keyPrefix);
  if (harness === "opencode") {
    return renderOpencodeSession(entries as OpencodeEntry[], keyPrefix);
  }
  if (harness === "pi") return renderPiSession(entries as PiEntry[], keyPrefix);
  return renderRollout(entries as RolloutEntry[], keyPrefix);
}

export interface SessionFacts {
  model: string;
  effort: string;
  cwd: string;
  tokens: SessionTokens | null;
  rateLimits: CodexRateLimits | null;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
}

export interface CodexRateLimits {
  planType: string;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export function sessionFacts(
  harness: Harness,
  entries: SessionEntry[],
): SessionFacts {
  if (harness === "claude")
    return { ...claudeFacts(entries), rateLimits: null };
  if (harness === "opencode") {
    // No effort is recorded anywhere, `--variant` is sent and forgotten.
    const facts = opencodeFacts(entries as OpencodeEntry[]);
    return {
      model: facts.model,
      effort: "",
      cwd: facts.cwd,
      tokens: facts.tokens,
      rateLimits: null,
    };
  }
  if (harness === "pi")
    return { ...piFacts(entries as PiEntry[]), rateLimits: null };
  return codexFacts(entries);
}

function codexRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  if (!value || typeof value !== "object") return null;
  const window = value as Record<string, unknown>;
  if (
    typeof window.used_percent !== "number" ||
    !Number.isFinite(window.used_percent)
  ) {
    return null;
  }
  const windowMinutes =
    typeof window.window_minutes === "number" &&
    Number.isFinite(window.window_minutes)
      ? window.window_minutes
      : 0;
  const resetsAt =
    typeof window.resets_at === "number" && Number.isFinite(window.resets_at)
      ? window.resets_at
      : null;
  return { usedPercent: window.used_percent, windowMinutes, resetsAt };
}

function codexRateLimits(value: unknown): CodexRateLimits | null {
  if (!value || typeof value !== "object") return null;
  const limits = value as Record<string, unknown>;
  const planType = typeof limits.plan_type === "string" ? limits.plan_type : "";
  const primary = codexRateLimitWindow(limits.primary);
  const secondary = codexRateLimitWindow(limits.secondary);
  return planType || primary || secondary
    ? { planType, primary, secondary }
    : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function codexBreakdown(
  usage: Record<string, unknown> | undefined,
): TokenBreakdown | null {
  if (!usage || typeof usage.total_tokens !== "number") return null;
  const num = (key: string) => Number(usage[key] ?? 0) || 0;
  const cacheRead = num("cached_input_tokens");
  const cacheWrite = num("cache_write_input_tokens");
  return {
    input: Math.max(num("input_tokens") - cacheRead - cacheWrite, 0),
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
    output: num("output_tokens"),
    reasoning: num("reasoning_output_tokens"),
    total: usage.total_tokens,
    cost: null,
  };
}

function codexFacts(entries: SessionEntry[]): SessionFacts {
  const fromTurnContext = (field: string): string => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.type !== "turn_context") continue;
      const value = (entry.payload as Record<string, unknown> | undefined)?.[
        field
      ];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };

  let tokens: SessionFacts["tokens"] = null;
  let rateLimits: CodexRateLimits | null = null;
  for (let i = entries.length - 1; i >= 0 && (!tokens || !rateLimits); i -= 1) {
    const p = entries[i].payload as Record<string, unknown> | undefined;
    if (p?.type !== "token_count") continue;
    if (!rateLimits) rateLimits = codexRateLimits(p.rate_limits);
    const info = record(p.info);
    const last = codexBreakdown(record(info?.last_token_usage));
    if (!tokens && last) {
      tokens = {
        last,
        session: codexBreakdown(record(info?.total_token_usage)) ?? last,
        window: Number(info?.model_context_window ?? 0),
      };
    }
  }

  let model = "";
  let estimatedSessionCost = 0;
  let pricedRequests = 0;
  const countedTotals = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "turn_context") {
      const value = (entry.payload as Record<string, unknown> | undefined)
        ?.model;
      if (typeof value === "string" && value) model = value;
      continue;
    }
    const p = entry.payload as Record<string, unknown> | undefined;
    if (p?.type !== "token_count") continue;
    const info = record(p.info);
    const total = record(info?.total_token_usage);
    const request = codexBreakdown(record(info?.last_token_usage));
    if (!total || !request) continue;
    const key = [
      total.input_tokens,
      total.cached_input_tokens,
      total.cache_write_input_tokens,
      total.output_tokens,
      total.reasoning_output_tokens,
      total.total_tokens,
    ].join(":");
    if (countedTotals.has(key)) continue;
    countedTotals.add(key);
    const cost = costOf(request, model);
    if (!cost) {
      pricedRequests = -1;
      break;
    }
    estimatedSessionCost += cost.dollars;
    pricedRequests += 1;
  }
  if (tokens && pricedRequests > 0)
    tokens.estimatedSessionCost = estimatedSessionCost;

  return {
    model: fromTurnContext("model"),
    effort: fromTurnContext("effort"),
    cwd: fromTurnContext("cwd"),
    tokens,
    rateLimits,
  };
}

function claudeBreakdown(
  usage: Record<string, unknown>,
): TokenBreakdown | null {
  const num = (key: string) => Number(usage[key] ?? 0) || 0;
  const cacheWrite = num("cache_creation_input_tokens");
  const ttl = (usage.cache_creation ?? {}) as Record<string, unknown>;
  const total =
    num("input_tokens") +
    cacheWrite +
    num("cache_read_input_tokens") +
    num("output_tokens");
  if (total <= 0) return null;
  return {
    input: num("input_tokens"),
    cacheRead: num("cache_read_input_tokens"),
    cacheWrite,
    cacheWrite1h: Math.min(
      Number(ttl.ephemeral_1h_input_tokens ?? 0) || 0,
      cacheWrite,
    ),
    output: num("output_tokens"),
    reasoning: 0,
    total,
    cost: null,
  };
}

function claudeFacts(entries: SessionEntry[]): SessionFacts {
  let model = "";
  let cwd = "";
  let last: TokenBreakdown | null = null;
  const session = emptyBreakdown();
  const counted = new Set<string>();

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!cwd && typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
    if (entry.type !== "assistant") continue;
    const message = entry.message as
      | { id?: string; model?: string; usage?: Record<string, unknown> }
      | undefined;
    if (!model && typeof message?.model === "string") model = message.model;
    if (!message?.usage) continue;
    const usage = claudeBreakdown(message.usage);
    if (!usage) continue;
    if (!last) last = usage;
    // A line with no id of any kind cannot be deduplicated, so it is counted:
    // missing a request is a worse failure than counting a rare one twice.
    const key = message.id || (entry.requestId as string | undefined) || "";
    if (key && counted.has(key)) continue;
    if (key) counted.add(key);
    addBreakdown(session, usage);
  }

  return {
    model,
    effort: "",
    cwd,
    tokens: last ? { last, session, window: 0 } : null,
    rateLimits: null,
  };
}

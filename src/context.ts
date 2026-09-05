export interface TokenBreakdown {
  input: number;
  cacheRead: number;
  cacheWrite: number;

  cacheWrite1h: number;
  output: number;

  reasoning: number;

  total: number;

  cost: number | null;
}

export interface SessionTokens {
  last: TokenBreakdown;
  session: TokenBreakdown;

  window: number;
  estimatedSessionCost?: number;
}

export function emptyBreakdown(): TokenBreakdown {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    cost: null,
  };
}

export function addBreakdown(into: TokenBreakdown, add: TokenBreakdown): void {
  into.input += add.input;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
  into.cacheWrite1h += add.cacheWrite1h;
  into.output += add.output;
  into.reasoning += add.reasoning;
  into.total += add.total;
  if (add.cost !== null) into.cost = (into.cost ?? 0) + add.cost;
}

export interface ContextUsage {
  used: number;

  window: number;

  assumed: boolean;
  percent: number | null;
  last: TokenBreakdown;
  session: TokenBreakdown;

  lastCost: CostFigure | null;

  sessionCost: CostFigure | null;
}

function knownWindow(model: string): number {
  const id = model.toLowerCase();
  if (!id) return 0;
  if (id.includes("haiku")) return 200_000;
  if (/opus|sonnet|fable|mythos|claude/.test(id)) return 1_000_000;
  return 0;
}

interface ModelPrice {
  input: number;
  output: number;
  cacheReadMultiplier?: number;
  longContext?: boolean;
}

function knownPrice(model: string): ModelPrice | null {
  const id = model.toLowerCase();
  if (!id) return null;
  if (id.includes("haiku")) return { input: 1, output: 5 };
  if (/fable-5-1|mythos-5-1/.test(id))
    return { input: 10, output: 50, cacheReadMultiplier: 0.025 };
  if (/fable|mythos/.test(id)) return { input: 10, output: 50 };
  if (id.includes("opus")) return { input: 5, output: 25 };
  if (id.includes("sonnet-5") || /^sonnet(?:\[1m\])?$/.test(id))
    return { input: 2, output: 10 };
  if (id.includes("sonnet")) return { input: 3, output: 15 };
  if (id.includes("gpt-6-astra"))
    return { input: 10, output: 50, longContext: true };
  if (id.includes("gpt-5.6-sol") || /(^|\/)gpt-5\.6$/.test(id))
    return { input: 4, output: 20, longContext: true };
  if (id.includes("gpt-5.6-terra"))
    return { input: 2, output: 12, longContext: true };
  if (id.includes("gpt-5.6-luna"))
    return { input: 0.2, output: 1.2, longContext: true };
  if (id.includes("gpt-5.5"))
    return { input: 5, output: 30, longContext: true };
  if (id.includes("gpt-5.4-mini")) return { input: 0.75, output: 4.5 };
  if (id.includes("gpt-5.4"))
    return { input: 2.5, output: 15, longContext: true };
  return null;
}

export interface CostFigure {
  dollars: number;
  estimated: boolean;
}

export function costOf(
  tokens: TokenBreakdown,
  model: string,
  applyLongContextPricing = true,
): CostFigure | null {
  if (tokens.cost !== null) return { dollars: tokens.cost, estimated: false };
  const price = knownPrice(model);
  if (!price) return null;
  const write5m = Math.max(tokens.cacheWrite - tokens.cacheWrite1h, 0);
  const inputUnits =
    tokens.input +
    tokens.cacheRead * (price.cacheReadMultiplier ?? 0.1) +
    write5m * 1.25 +
    tokens.cacheWrite1h * 2;
  const longContext =
    applyLongContextPricing &&
    price.longContext === true &&
    tokens.input + tokens.cacheRead + tokens.cacheWrite > 272_000;
  const dollars =
    (inputUnits * price.input * (longContext ? 2 : 1) +
      tokens.output * price.output * (longContext ? 1.5 : 1)) /
    1_000_000;
  return { dollars, estimated: true };
}

export function contextUsage(
  tokens: SessionTokens | null,
  model: string,
): ContextUsage | null {
  if (!tokens || tokens.last.total <= 0) return null;
  const reported = tokens.window > 0;
  const window = reported ? tokens.window : knownWindow(model);
  return {
    used: tokens.last.total,
    window,
    assumed: !reported && window > 0,
    percent: window > 0 ? (tokens.last.total / window) * 100 : null,
    last: tokens.last,
    session: tokens.session,
    lastCost: costOf(tokens.last, model),
    sessionCost:
      tokens.estimatedSessionCost === undefined
        ? costOf(
            tokens.session,
            model,
            tokens.session.total === tokens.last.total,
          )
        : { dollars: tokens.estimatedSessionCost, estimated: true },
  };
}

export type ContextLevel = "low" | "mid" | "high";

export function contextLevel(percent: number): ContextLevel {
  if (percent >= 90) return "high";
  if (percent >= 50) return "mid";
  return "low";
}

export function formatPercent(percent: number): string {
  const rounded = Math.round(percent);
  return `${rounded === 0 && percent > 0 ? 1 : rounded}%`;
}

export function formatTokens(count: number): string {
  return count.toLocaleString();
}

export function formatCost(dollars: number): string {
  const places = dollars > 0 && dollars < 0.01 ? 4 : 2;
  return `$${dollars.toFixed(places)}`;
}

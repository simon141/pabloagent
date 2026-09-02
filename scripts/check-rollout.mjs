#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

// `session.ts` imports no Tauri plugins, so it bundles with no stubbing.
const work = mkdtempSync(join(tmpdir(), "pt-rollout-check-"));
const bundle = join(work, "session.cjs");
execFileSync(
  join(repo, "node_modules/.bin/esbuild"),
  [
    join(repo, "src/session.ts"),
    "--bundle",
    "--format=cjs",
    // The harness table inlines the CLI logos with Vite's `?raw`; esbuild
    // needs telling that an SVG is text.
    "--loader:.svg=text",
    "--log-level=error",
    `--outfile=${bundle}`,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
// A CommonJS bundle imported from ESM arrives under `default`.
const loaded = await import(bundle);
const { parseSessionLines, renderSession, sessionFacts, wholeLineBytes } =
  loaded.default ?? loaded;

const ctxBundle = join(work, "context.cjs");
execFileSync(
  join(repo, "node_modules/.bin/esbuild"),
  [
    join(repo, "src/context.ts"),
    "--bundle",
    "--format=cjs",
    "--loader:.svg=text",
    "--log-level=error",
    `--outfile=${ctxBundle}`,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
const ctxLoaded = await import(ctxBundle);
const {
  contextUsage,
  contextLevel,
  costOf,
  emptyBreakdown,
  formatCost,
  formatPercent,
} = ctxLoaded.default ?? ctxLoaded;

const filtersBundle = join(work, "filters.cjs");
execFileSync(
  join(repo, "node_modules/.bin/esbuild"),
  [
    join(repo, "src/filters.ts"),
    "--bundle",
    "--format=cjs",
    "--log-level=error",
    `--outfile=${filtersBundle}`,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
const filtersLoaded = await import(filtersBundle);
const { categoriesOf, filtersFor, isHidden } =
  filtersLoaded.default ?? filtersLoaded;

const piBundle = join(work, "pi-rollout.cjs");
execFileSync(
  join(repo, "node_modules/.bin/esbuild"),
  [
    join(repo, "src/pi-rollout.ts"),
    "--bundle",
    "--format=cjs",
    "--log-level=error",
    `--outfile=${piBundle}`,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
const piLoaded = await import(piBundle);
const { piSessionName } = piLoaded.default ?? piLoaded;

const failures = [];
const check = (ok, what, detail = "") => {
  if (!ok) failures.push(`${what}${detail ? `\n    ${detail}` : ""}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};

const fixture = (name) =>
  parseSessionLines(
    readFileSync(join(repo, "src-tauri/tests/fixtures", name), "utf8"),
  );

const countTypes = (items) => {
  const counts = {};
  for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  return counts;
};

function replay(harness, entries) {
  const dom = new Map();
  let corrected = 0;
  let sawInProgress = false;
  for (let n = 1; n <= entries.length; n += 1) {
    const partial = renderSession(harness, entries.slice(0, n), "s");
    if (
      partial.some((i) => i.type === "rawToolCall" && i.status === "inProgress")
    ) {
      sawInProgress = true;
    }
    for (const item of partial) {
      const previous = dom.get(item.id);
      if (previous && previous.type !== item.type) corrected += 1;
      dom.set(item.id, item);
    }
  }
  return { dom, corrected, sawInProgress };
}

// ===========================================================================
// codex
// ===========================================================================

console.log("\n# codex rollout\n");

const codexEntries = fixture("rollout-two-commands.jsonl");
check(
  codexEntries.length === 21,
  `the codex fixture parses to 21 entries`,
  `got ${codexEntries.length}`,
);

const codexItems = renderSession("codex", codexEntries, "s");
const codexCounts = countTypes(codexItems);

check(
  codexCounts.userMessage === 1,
  "the typed prompt is the only chat bubble from the user",
  `saw ${JSON.stringify(codexCounts)}`,
);
const typed = codexItems.find((i) => i.type === "userMessage");
check(
  typed?.content?.[0]?.text?.includes("sleep 5"),
  "and it is what the user actually typed",
  JSON.stringify(typed?.content?.[0]?.text?.slice(0, 60)),
);
check(
  codexCounts.contextEntry >= 6,
  "injected context, metadata and lifecycle events become cards, not chat",
  `saw ${codexCounts.contextEntry} context cards`,
);
check(
  codexCounts.agentMessage === 2,
  "both agent replies render",
  `saw ${codexCounts.agentMessage}`,
);
check(
  codexCounts.rawToolCall === 2,
  "both exec calls render",
  `saw ${codexCounts.rawToolCall}`,
);
check(
  codexItems
    .filter((i) => i.type === "rawToolCall")
    .every((c) => c.status === "completed" && c.output),
  "a finished call has its output folded in",
);
check(
  JSON.stringify(
    codexItems.filter((i) => i.type === "rawToolCall").map((c) => c.durationMs),
  ) === JSON.stringify([5100, 5000]),
  "Codex tool calls use the measured Wall time from their outputs",
);
check(
  !codexItems.some(
    (i) =>
      i.type === "userMessage" &&
      i.content?.[0]?.text?.includes("environment_context"),
  ),
  "the injected environment block is never mistaken for something the user typed",
);

const codexReplay = replay("codex", codexEntries);
check(
  codexReplay.dom.size === codexItems.length,
  "following the turn line by line leaves exactly the finished transcript",
  `live loop ended with ${codexReplay.dom.size} nodes, the finished file renders ${codexItems.length}`,
);
check(
  codexItems.every(
    (i) => JSON.stringify(codexReplay.dom.get(i.id)) === JSON.stringify(i),
  ),
  "and every node matches what the finished file renders",
);
check(
  codexReplay.corrected === 1,
  "exactly one node corrects its kind in place: the prompt, once its event arrives",
  `${codexReplay.corrected} nodes changed kind`,
);
check(
  codexReplay.sawInProgress,
  "a command shows as running while its output is still missing",
);

const codexFactsRead = sessionFacts("codex", codexEntries);
check(
  codexFactsRead.model === "gpt-5.6-luna" &&
    codexFactsRead.effort === "high" &&
    codexFactsRead.cwd === "/home/you/project",
  "the status line reads the model, effort and workspace out of the rollout",
  JSON.stringify(codexFactsRead),
);
// The last `token_count` reports both a per-request and a cumulative figure,
// and they must not be mixed up: the request drives the percentage (the
// cumulative figure passes any window eventually), the session drives the cost.
check(
  codexFactsRead.tokens?.last.total === 11483 &&
    codexFactsRead.tokens?.session.total === 34275 &&
    codexFactsRead.tokens?.window === 258400,
  "and both token figures: the last request for the percentage, the session total for the spend",
  JSON.stringify(codexFactsRead.tokens),
);
// codex counts input inclusively, so fresh input is what is left once the
// cache figures come out: 469 + 11,008 read, plus 6 output, is 11,483.
check(
  codexFactsRead.tokens?.last.input === 469 &&
    codexFactsRead.tokens?.last.cacheRead === 11008 &&
    codexFactsRead.tokens?.last.output === 6 &&
    codexFactsRead.tokens?.last.cost === null,
  "the request breaks down into fresh input, cache reads and output, with no cost reported",
  JSON.stringify(codexFactsRead.tokens?.last),
);
// Reasoning is a subset of output, not a fifth class.
check(
  codexFactsRead.tokens?.session.reasoning === 44 &&
    codexFactsRead.tokens?.session.output === 240,
  "and reasoning is counted inside output rather than beside it",
  JSON.stringify(codexFactsRead.tokens?.session),
);
check(
  codexFactsRead.rateLimits?.planType === "team" &&
    codexFactsRead.rateLimits.primary?.usedPercent === 1 &&
    codexFactsRead.rateLimits.primary?.windowMinutes === 10080 &&
    codexFactsRead.rateLimits.primary?.resetsAt === 1785904991 &&
    codexFactsRead.rateLimits.secondary === null,
  "the Codex subscription limit is read from the same rollout snapshot",
  JSON.stringify(codexFactsRead.rateLimits),
);

const dualLimitFacts = sessionFacts(
  "codex",
  parseSessionLines(
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          plan_type: "plus",
          primary: {
            used_percent: 23,
            window_minutes: 300,
            resets_at: 1785900000,
          },
          secondary: {
            used_percent: 45,
            window_minutes: 10080,
            resets_at: 1786000000,
          },
        },
      },
    }),
  ),
);
check(
  dualLimitFacts.rateLimits?.primary?.windowMinutes === 300 &&
    dualLimitFacts.rateLimits.secondary?.windowMinutes === 10080,
  "both Codex rate-limit windows are retained when the rollout reports them",
  JSON.stringify(dualLimitFacts.rateLimits),
);

// ===========================================================================
// claude
// ===========================================================================

console.log("\n# claude session\n");

const claudeEntries = fixture("claude-session.jsonl");
check(
  claudeEntries.length === 29,
  "the claude fixture parses to 29 entries",
  `got ${claudeEntries.length}`,
);

const claudeItems = renderSession("claude", claudeEntries, "s");
const claudeCounts = countTypes(claudeItems);

check(
  claudeCounts.userMessage === 1,
  "the typed prompt is the only chat bubble from the user",
  `saw ${JSON.stringify(claudeCounts)}`,
);
const claudeTyped = claudeItems.find((i) => i.type === "userMessage");
check(
  claudeTyped?.content?.[0]?.text?.includes("echo hello from bash"),
  "and it is what the user actually typed",
  JSON.stringify(claudeTyped?.content?.[0]?.text?.slice(0, 60)),
);
// A finished background agent is announced by submitting a prompt, complete
// with a `promptSource`. It is not a chat message.
check(
  !claudeItems.some(
    (i) =>
      i.type === "userMessage" &&
      i.content?.[0]?.text?.includes("task-notification"),
  ),
  "a background agent's completion is never mistaken for something the user typed",
);
check(
  claudeItems.some(
    (i) =>
      i.type === "contextEntry" && i.origin === "injected task-notification",
  ),
  "and it is still shown, as a card naming where it came from",
);
check(
  claudeCounts.agentMessage === 4,
  "every assistant reply renders",
  `saw ${claudeCounts.agentMessage}`,
);
const reasoning = claudeItems.filter((i) => i.type === "reasoning");
check(
  reasoning.length === 4 &&
    reasoning.every((r) => r.summary.join("").length > 40),
  "thinking is recovered as quotable text, not a marker",
  `${reasoning.length} reasoning nodes, shortest ${Math.min(
    ...reasoning.map((r) => r.summary.join("").length),
  )} chars`,
);
const calls = claudeItems.filter((i) => i.type === "rawToolCall");
check(calls.length === 3, "every tool call renders", `saw ${calls.length}`);
check(
  calls.every((c) => c.status === "completed" && c.output),
  "each one has its result folded in",
  JSON.stringify(calls.map((c) => [c.tool, c.status, c.output.length])),
);
check(
  calls.every((c) => typeof c.durationMs === "number" && c.durationMs >= 0),
  "Claude tool calls derive their runtime from matching session timestamps",
  JSON.stringify(calls.map((c) => c.durationMs)),
);
// The fixture's Bash call carries both a `command` and a `description`, so it
// can tell the two apart.
const bash = calls.find((c) => c.tool === "Bash");
check(
  bash?.summary === "Run the echo command",
  "a shell call is headed by the description the model wrote, not by the raw command",
  JSON.stringify(calls.map((c) => c.summary)),
);
check(
  !bash?.summary.startsWith("Bash "),
  "and without the tool's name in front: the $ already identifies the shell",
  JSON.stringify(bash?.summary),
);
check(
  bash?.input.includes("echo hello from bash"),
  "the command itself is not lost, it is the first thing in the card's body",
  JSON.stringify(bash?.input),
);
check(
  calls.some((c) => c.tool === "ToolSearch" && c.explored === true),
  "a read-only tool is marked as exploratory rather than as a change",
);
check(
  claudeCounts.contextEntry >= 5,
  "attachments and session bookkeeping become cards, not chat",
  `saw ${claudeCounts.contextEntry} context cards`,
);

const claudeReplay = replay("claude", claudeEntries);
check(
  claudeReplay.dom.size === claudeItems.length,
  "following the turn line by line leaves exactly the finished transcript",
  `live loop ended with ${claudeReplay.dom.size} nodes, the finished file renders ${claudeItems.length}`,
);
check(
  claudeItems.every(
    (i) => JSON.stringify(claudeReplay.dom.get(i.id)) === JSON.stringify(i),
  ),
  "and every node matches what the finished file renders",
);
check(
  claudeReplay.corrected === 0,
  "no node ever has to change kind: a claude prompt says so on arrival",
  `${claudeReplay.corrected} nodes changed kind`,
);
check(
  claudeReplay.sawInProgress,
  "a tool shows as running while its result is still missing",
);

// The status line reads from the file, not from what the app asked for.
const facts = sessionFacts("claude", claudeEntries);
check(
  facts.model.startsWith("claude-") && facts.cwd === "/home/me/project",
  "the status line reads the model and workspace out of the session",
  JSON.stringify(facts),
);
// claude keeps cache outside `input_tokens`, so the four classes are disjoint
// and add up to the request.
check(
  facts.tokens?.last.input === 10 &&
    facts.tokens?.last.cacheWrite === 577 &&
    facts.tokens?.last.cacheRead === 23521 &&
    facts.tokens?.last.output === 158 &&
    facts.tokens?.last.total === 24266,
  "and the token usage of the last request, broken out by class",
  JSON.stringify(facts.tokens?.last),
);
// claude splits a reply into a line per content block, each stamped with the
// same `message.id` and `usage`, summing lines would bill the same request
// several times over, so the total is per message id.
check(
  facts.tokens?.session.output === 1220 &&
    facts.tokens?.session.cacheRead === 82548 &&
    facts.tokens?.session.total === 91470,
  "and the session total counts each request once, not once per line it was written across",
  JSON.stringify(facts.tokens?.session),
);
// The 1h/5m split matters for the price: a one-hour write costs 2× input
// against 1.25×, and Claude Code writes 1h entries by default.
check(
  facts.tokens?.last.cacheWrite1h === 577 &&
    facts.tokens?.session.cacheWrite1h === 7663,
  "and the one-hour part of the cache writes, which is priced at 2× input rather than 1.25×",
  JSON.stringify([
    facts.tokens?.last.cacheWrite1h,
    facts.tokens?.session.cacheWrite1h,
  ]),
);
check(
  facts.tokens?.last.cost === null && facts.tokens?.session.cost === null,
  "claude reports no cost of its own, so nothing is passed off as one",
  JSON.stringify([facts.tokens?.last.cost, facts.tokens?.session.cost]),
);
check(
  facts.rateLimits === null,
  "Codex subscription limits stay hidden for Claude chats",
);

// ===========================================================================
// opencode
// ===========================================================================

console.log("\n# opencode session\n");

const opencodeEntries = fixture("opencode-session.jsonl");
check(
  opencodeEntries.length === 19,
  "the opencode fixture parses to 19 entries",
  `got ${opencodeEntries.length}`,
);

const opencodeItems = renderSession("opencode", opencodeEntries, "s");
const opencodeCounts = countTypes(opencodeItems);

check(
  opencodeCounts.userMessage === 1,
  "the typed prompt is the only chat bubble from the user",
  `saw ${JSON.stringify(opencodeCounts)}`,
);
const opencodeTyped = opencodeItems.find((i) => i.type === "userMessage");
check(
  opencodeTyped?.content?.[0]?.text?.includes("pablo-probe"),
  "and it is what the user actually typed",
  JSON.stringify(opencodeTyped?.content?.[0]?.text?.slice(0, 60)),
);
check(
  opencodeCounts.agentMessage === 2,
  "the reply from each feed renders, one out of the database, one off the event stream",
  `saw ${opencodeCounts.agentMessage}`,
);
// The resumed turn's events carry no reasoning: that run predates `--thinking`.
const opencodeReasoning = opencodeItems.filter((i) => i.type === "reasoning");
check(
  opencodeReasoning.length === 2 &&
    opencodeReasoning.every((r) => r.summary.join("").length > 40),
  "thinking is recovered as quotable text, not a marker",
  `${opencodeReasoning.length} reasoning nodes`,
);
const opencodeCalls = opencodeItems.filter((i) => i.type === "rawToolCall");
check(
  opencodeCalls.length === 2 &&
    opencodeCalls.every((c) => c.status === "completed" && c.output),
  "both bash calls render with their output, from either feed",
  JSON.stringify(opencodeCalls.map((c) => [c.tool, c.status, c.output.length])),
);
check(
  JSON.stringify(opencodeCalls.map((c) => c.durationMs)) ===
    JSON.stringify([11, 8]),
  "OpenCode tool calls use their native start and end times",
  JSON.stringify(opencodeCalls.map((c) => c.durationMs)),
);
check(
  opencodeCalls.some((c) => c.summary === "bash echo pablo-probe"),
  "a shell call is labelled with opencode's own title for it",
  JSON.stringify(opencodeCalls.map((c) => c.summary)),
);
check(
  opencodeItems.filter(
    (i) => i.type === "contextEntry" && i.origin === "step-finish",
  ).length === 4,
  "each step's token count becomes a card; the step-start boundaries do not",
  `saw ${JSON.stringify(opencodeCounts)}`,
);

const opencodeReplay = replay("opencode", opencodeEntries);
check(
  opencodeReplay.dom.size === opencodeItems.length,
  "following the turn line by line leaves exactly the finished transcript",
  `live loop ended with ${opencodeReplay.dom.size} nodes, the finished render has ${opencodeItems.length}`,
);
check(
  opencodeItems.every(
    (i) => JSON.stringify(opencodeReplay.dom.get(i.id)) === JSON.stringify(i),
  ),
  "and every node matches what the finished render produces",
);
check(
  opencodeReplay.corrected === 0,
  "no node ever has to change kind: a part says what it is on arrival",
  `${opencodeReplay.corrected} nodes changed kind`,
);
// opencode emits a part when it *completes*, so a running tool is never
// visible mid-command.
check(
  !opencodeReplay.sawInProgress,
  "no call ever shows as running, opencode's feeds only carry finished parts",
);

// The dedupe the part-id keying exists for: the same part arriving again must
// update its node in place, not append a copy.
const duplicated = renderSession(
  "opencode",
  [...opencodeEntries, opencodeEntries[17], opencodeEntries[5]],
  "s",
);
check(
  duplicated.length === opencodeItems.length,
  "a part seen twice updates its node in place instead of duplicating it",
  `render grew from ${opencodeItems.length} to ${duplicated.length} nodes`,
);

const opencodeFactsRead = sessionFacts("opencode", opencodeEntries);
check(
  opencodeFactsRead.model === "opencode/big-pickle" &&
    opencodeFactsRead.cwd === "/home/me/project",
  "the status line reads the model and workspace out of the session",
  JSON.stringify(opencodeFactsRead),
);
// opencode is the one reader whose reasoning sits *beside* output rather than
// inside it, so it is folded in to match the others.
check(
  opencodeFactsRead.tokens?.last.total === 10383 &&
    opencodeFactsRead.tokens?.last.input === 125 &&
    opencodeFactsRead.tokens?.last.cacheRead === 10240 &&
    opencodeFactsRead.tokens?.last.output === 18 &&
    opencodeFactsRead.tokens?.last.reasoning === 13,
  "and the token usage of the last step, with reasoning folded into output",
  JSON.stringify(opencodeFactsRead.tokens?.last),
);
// Steps rather than message rows: opencode's writer *replaces* a message's
// tokens on every step, so a multi-step message's row under-reports what it
// read, and adding both would count the same requests twice.
check(
  opencodeFactsRead.tokens?.session.total === 41191,
  "the session total sums the steps, from both feeds, without also adding the message rows",
  JSON.stringify(opencodeFactsRead.tokens?.session),
);
// The same dedupe the transcript needs, for money: a part seen twice must not
// be paid for twice.
const opencodeDoubled = sessionFacts("opencode", [
  ...opencodeEntries,
  opencodeEntries[17],
  opencodeEntries[5],
]);
check(
  opencodeDoubled.tokens?.session.total === 41191,
  "and a step seen twice is counted once",
  JSON.stringify(opencodeDoubled.tokens?.session),
);
// opencode prices every request itself; 0 is a real answer, not missing.
check(
  opencodeFactsRead.tokens?.last.cost === 0 &&
    opencodeFactsRead.tokens?.session.cost === 0,
  "opencode's own cost is carried through, zero included",
  JSON.stringify([
    opencodeFactsRead.tokens?.last.cost,
    opencodeFactsRead.tokens?.session.cost,
  ]),
);

// ===========================================================================
// pi
// ===========================================================================

console.log("\n# pi session\n");

const piEntries = fixture("pi-session.jsonl");
check(
  piEntries.length === 10,
  "the pi fixture parses to 10 entries",
  `got ${piEntries.length}`,
);

const piItems = renderSession("pi", piEntries, "s");
const piCounts = countTypes(piItems);

check(
  piCounts.userMessage === 2,
  "both typed prompts are chat bubbles, pi injects nothing as a user message",
  `saw ${JSON.stringify(piCounts)}`,
);
const piTyped = piItems.find((i) => i.type === "userMessage");
check(
  piTyped?.content?.[0]?.text?.includes("hello pablo"),
  "and the first is what the user actually typed",
  JSON.stringify(piTyped?.content?.[0]?.text?.slice(0, 60)),
);
check(
  piCounts.agentMessage === 2,
  "both agent replies render",
  `saw ${piCounts.agentMessage}`,
);
// This session's openai-codex provider leaves thinking as an encrypted
// signature only, so it gets the marker treatment.
const encryptedThoughts = piItems.filter(
  (i) => i.type === "contextEntry" && i.label === "Thought (encrypted)",
);
check(
  encryptedThoughts.length === 2,
  "encrypted thinking becomes a marker card, never a quote",
  `saw ${JSON.stringify(piCounts)}`,
);
const encryptedThought = encryptedThoughts[0] ?? {
  type: "contextEntry",
  id: "encrypted",
  origin: "reasoning",
  label: "Thought (encrypted)",
  text: "{}",
};
const plaintextThought = {
  type: "reasoning",
  id: "plaintext",
  summary: ["visible thought"],
};
check(
  ["codex", "pi"].every(
    (harness) =>
      filtersFor(harness).some((filter) => filter.id === "thought-encrypted") &&
      categoriesOf(harness, encryptedThought).includes("thought-encrypted"),
  ),
  "codex and pi encrypted thought markers have their own filter",
);
check(
  isHidden("pi", ["thought-encrypted"], encryptedThought) &&
    !isHidden("pi", ["thought-encrypted"], plaintextThought),
  "the encrypted-thought filter leaves plaintext reasoning visible",
);
check(
  isHidden("pi", ["reasoning"], encryptedThought) &&
    isHidden("pi", ["reasoning"], plaintextThought),
  "the broad reasoning filter still covers both thought forms",
);
// The name `pi --name` writes, which the picker and the chat pill both show.
check(
  piSessionName(piEntries) === "Preview versions",
  "the session name is the last one pi recorded",
  JSON.stringify(piSessionName(piEntries)),
);
check(
  piSessionName(piEntries.filter((e) => e.type !== "session_info")) === "" &&
    piSessionName([{ type: "session_info", name: "  " }]) === "",
  "a session pi never named, or named blank, has no name",
);
check(
  piSessionName([
    { type: "session_info", name: "first" },
    { type: "session_info", name: "second" },
  ]) === "second",
  "and a renamed session keeps the newest entry, not the first",
);
check(
  ["session", "model_change", "thinking_level_change", "session_info"].every(
    (kind) =>
      piItems.some((i) => i.type === "contextEntry" && i.origin === kind),
  ),
  "the header, model change and thinking-level change become cards",
  JSON.stringify(
    piItems.filter((i) => i.type === "contextEntry").map((i) => i.origin),
  ),
);
const piCalls = piItems.filter((i) => i.type === "rawToolCall");
check(piCalls.length === 1, "the bash call renders", `saw ${piCalls.length}`);
check(
  piCalls.every(
    (c) => c.status === "completed" && c.output.includes("pablo-test-123"),
  ),
  "with its result folded in",
  JSON.stringify(piCalls.map((c) => [c.tool, c.status, c.output.length])),
);
check(
  piCalls[0]?.durationMs === 4019,
  "Pi tool calls derive their runtime from matching session timestamps",
  JSON.stringify(piCalls.map((c) => c.durationMs)),
);
check(
  piCalls[0]?.summary === "bash sleep 4 && echo pablo-test-123",
  "a shell call is labelled with the command, dug out of its arguments object",
  JSON.stringify(piCalls.map((c) => c.summary)),
);

const piReplay = replay("pi", piEntries);
check(
  piReplay.dom.size === piItems.length,
  "following the turn line by line leaves exactly the finished transcript",
  `live loop ended with ${piReplay.dom.size} nodes, the finished file renders ${piItems.length}`,
);
check(
  piItems.every(
    (i) => JSON.stringify(piReplay.dom.get(i.id)) === JSON.stringify(i),
  ),
  "and every node matches what the finished file renders",
);
check(
  piReplay.corrected === 0,
  "no node ever has to change kind: a pi prompt says so on arrival",
  `${piReplay.corrected} nodes changed kind`,
);
check(
  piReplay.sawInProgress,
  "a tool shows as running while its result is still missing",
);

const piFactsRead = sessionFacts("pi", piEntries);
check(
  piFactsRead.model === "openai-codex/gpt-5.4-mini" &&
    piFactsRead.effort === "low" &&
    piFactsRead.cwd === "/home/me/project",
  "the status line reads the model, thinking level and workspace out of the session",
  JSON.stringify(piFactsRead),
);
check(
  piFactsRead.tokens?.last.total === 1992 &&
    piFactsRead.tokens?.last.input === 447 &&
    piFactsRead.tokens?.last.cacheRead === 1536 &&
    piFactsRead.tokens?.last.output === 9,
  "and the token usage of the last request",
  JSON.stringify(piFactsRead.tokens?.last),
);
// Three requests' tokens, and pi's own per-request prices, summed.
check(
  piFactsRead.tokens?.session.total === 5866 &&
    Math.abs((piFactsRead.tokens?.session.cost ?? 0) - 0.00256965) < 1e-9,
  "and the session sums both the tokens and pi's own per-request cost",
  JSON.stringify(piFactsRead.tokens?.session),
);

// ===========================================================================
// context usage
// ===========================================================================

console.log("\n# context usage\n");

const codexUsage = contextUsage(codexFactsRead.tokens, codexFactsRead.model);
check(
  codexUsage.window === 258400 && codexUsage.assumed === false,
  "a window the session reported is used as-is and not flagged as an assumption",
  JSON.stringify(codexUsage),
);
check(
  Math.round(codexUsage.percent) === 4,
  "and the percentage is the last request against it",
  `${codexUsage.percent}`,
);

const claudeUsage = contextUsage(facts.tokens, facts.model);
check(
  facts.model === "claude-haiku-4-5-20251001" &&
    claudeUsage.window === 200000 &&
    claudeUsage.assumed === true,
  "a claude session gets the published window for its model, flagged as assumed",
  `${facts.model} → ${JSON.stringify(claudeUsage)}`,
);

const someTokens = (total, window, over = {}) => {
  const one = { ...emptyBreakdown(), total, ...over };
  return { last: one, session: one, window };
};
check(
  contextUsage(someTokens(500, 0), "opus").window === 1000000 &&
    contextUsage(someTokens(500, 0), "anthropic/claude-sonnet-5").window ===
      1000000,
  "the aliases the dialog offers and an opencode/pi provider prefix resolve too",
);
// A wrong denominator is worse than none.
const unknown = contextUsage(someTokens(1908, 0), "openai-codex/gpt-5.4-mini");
check(
  unknown.percent === null && unknown.window === 0,
  "a model with no known window gets no percentage rather than a guessed one",
  JSON.stringify(unknown),
);
check(
  contextUsage(null, "opus") === null &&
    contextUsage(someTokens(0, 100), "opus") === null,
  "a session that has not reported any usage shows nothing at all",
);
check(
  contextLevel(49.9) === "low" &&
    contextLevel(50) === "mid" &&
    contextLevel(89.9) === "mid" &&
    contextLevel(90) === "high" &&
    contextLevel(140) === "high",
  "green under half, amber from half, red from 90% and above",
);
check(
  formatPercent(0.2) === "1%" &&
    formatPercent(0) === "0%" &&
    formatPercent(104.4) === "104%",
  "a percentage never rounds down to 0% while context is in use, and is never capped",
  `${formatPercent(0.2)} / ${formatPercent(0)} / ${formatPercent(104.4)}`,
);

// ===========================================================================
// cost
// ===========================================================================

console.log("\n# cost\n");

// A figure the session priced itself wins outright, including opencode's zero.
check(
  costOf({ ...emptyBreakdown(), total: 10, cost: 0.25 }, "opus").estimated ===
    false &&
    costOf({ ...emptyBreakdown(), total: 10, cost: 0 }, "big-pickle")
      ?.dollars === 0,
  "a cost the session reported is used as-is, zero included",
);
check(
  costOf({ ...emptyBreakdown(), input: 1_000_000 }, "opus").dollars === 5 &&
    costOf({ ...emptyBreakdown(), output: 1_000_000 }, "claude-opus-5")
      .dollars === 25,
  "an unpriced request is costed from the published rates for its model",
);
const cached = costOf(
  {
    ...emptyBreakdown(),
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    cacheWrite1h: 400_000,
  },
  "claude-sonnet-5",
);
check(
  Math.abs(cached.dollars - (0.1 + 0.6 * 1.25 + 0.4 * 2) * 2) < 1e-9 &&
    cached.estimated === true,
  "cache reads cost a tenth of input, and writes 1.25× or 2× by TTL, all flagged as estimated",
  JSON.stringify(cached),
);
check(
  costOf({ ...emptyBreakdown(), input: 1_000_000 }, "claude-haiku-4-5")
    .dollars === 1 &&
    costOf({ ...emptyBreakdown(), input: 1_000_000 }, "fable").dollars === 10,
  "each Anthropic tier gets its own rate, Haiku matched before the family patterns",
);
check(
  costOf({ ...emptyBreakdown(), input: 100_000 }, "gpt-5.6-sol").dollars ===
    0.4 &&
    costOf({ ...emptyBreakdown(), output: 1_000_000 }, "gpt-5.6").dollars ===
      20 &&
    costOf({ ...emptyBreakdown(), output: 1_000_000 }, "gpt-5.6-terra")
      .dollars === 12 &&
    costOf({ ...emptyBreakdown(), input: 1_000_000 }, "gpt-5.4-mini")
      .dollars === 0.75,
  "each codex model gets its own rate, including the Sol alias, with -mini matched before its parent",
);
const atLongContextBoundary = costOf(
  { ...emptyBreakdown(), input: 272_000, output: 1_000 },
  "gpt-5.6",
);
const aboveLongContextBoundary = costOf(
  { ...emptyBreakdown(), input: 272_001, output: 1_000 },
  "gpt-5.6",
);
const cachedLongContext = costOf(
  { ...emptyBreakdown(), cacheRead: 272_001, output: 1_000 },
  "gpt-5.6",
);
check(
  atLongContextBoundary.dollars === (272_000 * 4 + 1_000 * 20) / 1_000_000 &&
    aboveLongContextBoundary.dollars ===
      (272_001 * 4 * 2 + 1_000 * 20 * 1.5) / 1_000_000 &&
    cachedLongContext.dollars ===
      (272_001 * 0.1 * 4 * 2 + 1_000 * 20 * 1.5) / 1_000_000,
  "long-context pricing starts above 272K input, includes cached tokens, and surcharges the full request",
);
// Stricter than the window table: an unrecognised `claude-…` or `gpt-…` could
// be any tier, and a wrong price looks exactly as authoritative as a right one.
check(
  costOf({ ...emptyBreakdown(), input: 500 }, "gpt-6-something-new") === null &&
    costOf({ ...emptyBreakdown(), input: 500 }, "claude-something-new") ===
      null &&
    costOf({ ...emptyBreakdown(), input: 500 }, "") === null,
  "a model with no published price gets no cost rather than a guessed one",
);
check(
  formatCost(0) === "$0.00" &&
    formatCost(0.0043) === "$0.0043" &&
    formatCost(0.03) === "$0.03" &&
    formatCost(12.5) === "$12.50",
  "a fraction of a cent keeps four places so real spend never reads as $0.00",
  `${formatCost(0)} / ${formatCost(0.0043)} / ${formatCost(0.03)} / ${formatCost(12.5)}`,
);
// End to end: the claude fixture's requests at published rates.
const claudeCost = contextUsage(facts.tokens, facts.model);
check(
  claudeCost.sessionCost.estimated === true &&
    formatCost(claudeCost.sessionCost.dollars) === "$0.03" &&
    formatCost(claudeCost.lastCost.dollars) === "$0.0043",
  "a claude session is priced from its own token counts, and says the figure is an estimate",
  JSON.stringify([claudeCost.lastCost, claudeCost.sessionCost]),
);
// codex reports no cost of its own, so both figures are priced here.
const codexCost = contextUsage(codexFactsRead.tokens, codexFactsRead.model);
check(
  codexCost.sessionCost.estimated === true &&
    formatCost(codexCost.sessionCost.dollars) === "$0.0026" &&
    formatCost(codexCost.lastCost.dollars) === "$0.0003",
  "a codex session is priced from its own token counts, and says the figure is an estimate",
  JSON.stringify([codexCost.lastCost, codexCost.sessionCost]),
);
const codexLongContextFacts = sessionFacts(
  "codex",
  parseSessionLines(
    [
      {
        type: "turn_context",
        payload: { model: "gpt-5.6" },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200_000,
              output_tokens: 1_000,
              total_tokens: 201_000,
            },
            last_token_usage: {
              input_tokens: 200_000,
              output_tokens: 1_000,
              total_tokens: 201_000,
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 400_000,
              output_tokens: 2_000,
              total_tokens: 402_000,
            },
            last_token_usage: {
              input_tokens: 200_000,
              output_tokens: 1_000,
              total_tokens: 201_000,
            },
          },
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  ),
);
const codexLongContextCost = contextUsage(
  codexLongContextFacts.tokens,
  codexLongContextFacts.model,
);
check(
  codexLongContextCost.sessionCost.dollars ===
    2 * ((200_000 * 4 + 1_000 * 20) / 1_000_000),
  "separate sub-272K Codex requests are not surcharged when their session total crosses 272K",
  JSON.stringify(codexLongContextCost.sessionCost),
);

// ===========================================================================
// inline images
// ===========================================================================
//
// Synthetic lines rather than a fixture: they state each CLI's image shape
// more legibly than a megabyte of real base64 would.

console.log("\n# inline images\n");

const png = "iVBORw0KGgoAAAANSUhEUg==";

const claudeImageItems = renderSession(
  "claude",
  parseSessionLines(
    [
      JSON.stringify({
        type: "user",
        promptSource: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/tmp/shot.png" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: png,
                  },
                },
              ],
            },
          ],
        },
      }),
    ].join("\n"),
  ),
  "s",
);
const claudePrompt = claudeImageItems.find((i) => i.type === "userMessage");
check(
  claudePrompt?.images?.length === 1 && claudePrompt.images[0].data === png,
  "a pasted image rides on the claude prompt bubble",
  JSON.stringify(claudePrompt?.images),
);
const claudeCall = claudeImageItems.find((i) => i.type === "rawToolCall");
check(
  claudeCall?.images?.length === 1 && claudeCall.images[0].mime === "image/png",
  "a claude tool result's image folds into its call as an image",
  JSON.stringify(claudeCall?.images),
);
check(
  !String(claudeCall?.output ?? "").includes(png),
  "and its base64 never lands in the card text",
  String(claudeCall?.output ?? ""),
);

const piImageItems = renderSession(
  "pi",
  parseSessionLines(
    [
      JSON.stringify({
        type: "message",
        id: "aa",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "screenshot", arguments: {} },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "ab",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          content: [{ type: "image", mimeType: "image/jpeg", data: png }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "ac",
        message: {
          role: "user",
          content: [{ type: "image", mimeType: "image/png" }],
        },
      }),
    ].join("\n"),
  ),
  "s",
);
const piCall = piImageItems.find((i) => i.type === "rawToolCall");
check(
  piCall?.images?.length === 1 &&
    piCall.images[0].mime === "image/jpeg" &&
    !String(piCall.output ?? "").includes(png),
  "a pi image part folds into its tool call as an image, not as base64 text",
  JSON.stringify(piCall?.images),
);
const piBytesless = piImageItems.find((i) => i.type === "userMessage");
check(
  (piBytesless?.content?.[0]?.text ?? "").includes("[image image/png]"),
  "a pi image part without bytes keeps its placeholder line",
  JSON.stringify(piBytesless),
);

const codexImageItems = renderSession(
  "codex",
  parseSessionLines(
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${png}` },
        ],
      },
    }),
  ),
  "s",
);
const codexPrompt = codexImageItems.find((i) => i.type === "userMessage");
check(
  codexPrompt?.images?.length === 1 && codexPrompt.images[0].data === png,
  "a codex input_image data URL becomes an image on the prompt bubble",
  JSON.stringify(codexImageItems),
);

// ===========================================================================
// The session file's own size
// ===========================================================================

console.log("\n# session file size\n");

// The "Session file" row is a running total of bytes already handed to the
// app, so it must agree with the file on disk and a live turn must not make
// it drift.
for (const name of [
  "rollout-two-commands.jsonl",
  "claude-session.jsonl",
  "pi-session.jsonl",
]) {
  const text = readFileSync(
    join(repo, "src-tauri/tests/fixtures", name),
    "utf8",
  );
  const onDisk = statSync(join(repo, "src-tauri/tests/fixtures", name)).size;
  check(
    wholeLineBytes(text) === onDisk,
    `${name} measures its own size on disk`,
    `counted ${wholeLineBytes(text)}, file is ${onDisk}`,
  );

  // A file being appended to can end mid-line, and the cursor only advances
  // past whole lines, counting the partial tail would pay for it twice.
  const cut = Math.floor(text.length * 0.6);
  const head = text.slice(0, cut);
  const resumeAt = head.lastIndexOf("\n") + 1;
  check(
    wholeLineBytes(head) + wholeLineBytes(text.slice(resumeAt)) === onDisk,
    `${name} read as two overlapping slices still totals its size`,
    `counted ${wholeLineBytes(head) + wholeLineBytes(text.slice(resumeAt))}, file is ${onDisk}`,
  );
}

// UTF-16 length is not a byte count.
const wide = '{"t":"é→漢"}\n';
check(
  wholeLineBytes(wide) === Buffer.byteLength(wide, "utf8") &&
    wholeLineBytes(wide) > wide.length,
  "a line of non-ASCII counts its UTF-8 bytes, not its characters",
  `counted ${wholeLineBytes(wide)} for ${wide.length} characters`,
);

if (failures.length) {
  console.error(
    `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
  );
  process.exit(1);
}
console.log("\nall session reader checks passed");

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

// `drafts.ts` imports nothing at all, so it bundles with no stubbing.
const work = mkdtempSync(join(tmpdir(), "pt-drafts-check-"));
const bundle = join(work, "drafts.cjs");
execFileSync(
  join(repo, "node_modules/.bin/esbuild"),
  [
    join(repo, "src/drafts.ts"),
    "--bundle",
    "--format=cjs",
    "--platform=node",
    `--outfile=${bundle}`,
  ],
  { stdio: "inherit" },
);
const { formatDraft, parseDraft, parseTextDraft } = (await import(bundle))
  .default;

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failures += 1;
  console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
};

// --- a round trip through every field, with the values that need quoting -----

const awkward = {
  prompt: "line one\n\n\nline two",
  harness: "codex",
  model: "gpt-5.6-luna",
  effort: "medium",
  cwd: "/home/user/my project",
  permissionMode: "on-request",
  createdAt: "2026-08-20T18:51:43.000Z",
};
const file = formatDraft(awkward);
check("round trip", parseDraft("project1/tasks/fix-bug", file), {
  id: "project1/tasks/fix-bug",
  ...awkward,
});
// The body must keep the blank lines that separate the prompts the draft was
// gathered from.
if (!file.includes("line one\n\n\nline two")) {
  failures += 1;
  console.error(`FAIL blank lines survive formatting\n${file}`);
}

// A `: ` or a leading `#` in a value would otherwise read as a nested key or a
// comment, so the writer has to quote them and the reader has to unquote.
for (const value of [
  "plain words",
  "trailing space ",
  " leading space",
  "",
  "#hash",
  '"quoted"',
  "'single'",
  "back\\slash",
  "- dash",
  "{brace}",
  "[bracket]",
  "colon:no-space",
  "ends with colon:",
  "with: colon-space",
  "%percent",
  "@at",
]) {
  const parsed = parseDraft("x", formatDraft({ ...awkward, cwd: value }));
  // A blank field is left out of the file, so it comes back as "".
  check(`cwd round trip ${JSON.stringify(value)}`, parsed.cwd, value);
}

// --- the body is verbatim ---------------------------------------------------

check(
  "a body may hold its own --- rules",
  parseDraft("x", "---\ncwd: /a\n---\n\nabove\n\n---\n\nbelow\n").prompt,
  "above\n\n---\n\nbelow",
);
check(
  "a body may hold front-matter-looking lines",
  parseDraft("x", "---\ncwd: /a\n---\n\nmodel: not a field\n").prompt,
  "model: not a field",
);

// --- hand-written and hand-edited files ------------------------------------

check("no front matter at all", parseDraft("notes", "just do the thing\n"), {
  id: "notes",
  prompt: "just do the thing",
  harness: "",
  model: "",
  effort: "",
  cwd: "",
  permissionMode: "",
  createdAt: "",
});
check(
  "keys in another order, with unknown keys and comments",
  parseDraft(
    "x",
    "---\n# mine\ncwd: /srv/app\nnotAField: whatever\ntitle: From an older build\n---\ngo\n",
  ),
  {
    id: "x",
    prompt: "go",
    harness: "",
    model: "",
    effort: "",
    cwd: "/srv/app",
    permissionMode: "",
    createdAt: "",
  },
);
check(
  "CRLF from a Windows editor",
  parseDraft("x", "---\r\nmodel: m\r\ncwd: /a\r\n---\r\n\r\nbody\r\n"),
  {
    id: "x",
    prompt: "body",
    harness: "",
    model: "m",
    effort: "",
    cwd: "/a",
    permissionMode: "",
    createdAt: "",
  },
);
check(
  "no trailing newline",
  parseDraft("x", "---\ncwd: /a\n---\nbody").prompt,
  "body",
);
check(
  "single quotes, the other YAML spelling",
  parseDraft("x", "---\ncwd: 'it''s here: yes'\n---\nb").cwd,
  "it's here: yes",
);
check("an empty file", parseDraft("x", ""), {
  id: "x",
  prompt: "",
  harness: "",
  model: "",
  effort: "",
  cwd: "",
  permissionMode: "",
  createdAt: "",
});
check(
  "front matter nobody closed is a prompt, not a silent loss",
  parseDraft("x", "---\ncwd: /a\nstill going\n").prompt,
  "---\ncwd: /a\nstill going",
);
check(
  "text files are only prompts",
  parseTextDraft("plain", "---\r\nmodel: not-metadata\r\n---\r\ndo it\r\n"),
  {
    id: "plain",
    prompt: "---\nmodel: not-metadata\n---\ndo it",
    harness: "",
    model: "",
    effort: "",
    cwd: "",
    permissionMode: "",
    createdAt: "",
  },
);

if (failures) {
  console.error(`\n${failures} draft format check(s) failed`);
  process.exit(1);
}
console.log("draft prompt format: all checks passed");

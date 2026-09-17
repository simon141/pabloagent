#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pt-composer-check-"));
try {
  const bundle = join(work, "composer.cjs");
  execFileSync(
    join(repo, "node_modules/.bin/esbuild"),
    [
      join(repo, "src/composer.ts"),
      "--bundle",
      "--format=cjs",
      "--log-level=error",
      `--outfile=${bundle}`,
    ],
    { stdio: "inherit" },
  );
  const { composerDraft, enterSends } = (await import(bundle)).default;
  for (const multiline of [false, true]) {
    assert.equal(enterSends("send", multiline), true);
    assert.equal(enterSends("newline", multiline), false);
    assert.equal(enterSends("auto", multiline), !multiline);
  }
  let draft = composerDraft("Hello");
  assert.equal(draft.multiline, false);
  draft = composerDraft("Hello\n", draft);
  assert.equal(draft.multiline, true);
  draft = composerDraft("Hello again", draft);
  assert.equal(
    draft.multiline,
    true,
    "deleting the newline keeps multiline mode",
  );
  draft = composerDraft("", draft);
  assert.equal(draft.multiline, false, "clearing or sending resets Auto");
  assert.equal(composerDraft("Next message", draft).multiline, false);
  for (const text of ["pasted\ntext", "pasted\r\ntext", "pasted\rtext", "\n"]) {
    assert.equal(composerDraft(text).multiline, true);
  }
  const drafts = new Map([
    ["first", composerDraft("line\nbreak")],
    ["second", composerDraft("single line")],
  ]);
  assert.equal(enterSends("auto", drafts.get("first").multiline), false);
  assert.equal(enterSends("auto", drafts.get("second").multiline), true);
  assert.equal(composerDraft("retry", drafts.get("first")).multiline, true);
  console.log("Composer checks passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}

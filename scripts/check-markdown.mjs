#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pt-markdown-check-"));
try {
  const bundle = join(work, "transcript.cjs");
  execFileSync(
    join(repo, "node_modules/.bin/esbuild"),
    [
      join(repo, "src/transcript.ts"),
      "--bundle",
      "--format=cjs",
      "--platform=node",
      "--loader:.svg=text",
      "--log-level=error",
      `--outfile=${bundle}`,
    ],
    { stdio: "inherit" },
  );
  const { formatMarkdown } = (await import(bundle)).default;
  const alts = (html) =>
    [...html.matchAll(/(?:data-img-alt|alt)="([^"]*)"/g)].map((m) => m[1]);

  const linked = formatMarkdown(
    "[`https://x.com/a/onclick=alert`](/tmp/a.png)",
  );
  assert.deepEqual(alts(linked), ["https://x.com/a/onclick=alert"], linked);
  assert.equal((linked.match(/</g) ?? []).length, 4, linked);
  assert.deepEqual(alts(formatMarkdown("![`/a/b.ts` shot](/tmp/pic.png)")), [
    "/a/b.ts shot",
  ]);
  assert.deepEqual(
    alts(formatMarkdown("![`x` y](data:image/png;base64,AAAA)")),
    ["x y"],
  );
  assert.deepEqual(alts(formatMarkdown('![a "q"](/tmp/b.png)')), [
    "a &quot;q&quot;",
  ]);
  console.log("Markdown checks passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}

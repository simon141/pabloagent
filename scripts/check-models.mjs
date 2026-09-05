#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pt-models-check-"));
try {
  const bundle = join(work, "models.cjs");
  execFileSync(
    join(repo, "node_modules/.bin/esbuild"),
    [
      join(repo, "src/models.ts"),
      "--bundle",
      "--format=cjs",
      "--loader:.svg=text",
      "--log-level=error",
      `--outfile=${bundle}`,
    ],
    { stdio: "inherit" },
  );
  const { modelsFor, modelById } = (await import(bundle)).default;
  assert.deepEqual(modelById("codex", "gpt-6-astra"), {
    id: "gpt-6-astra",
    label: "GPT-6-Astra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
  });
  assert.equal(modelsFor("codex")[0].id, "");
  assert.equal(modelById("codex", "gpt-5.6-sol").id, "gpt-5.6-sol");
  for (const harness of ["claude", "opencode", "pi"])
    assert.ok(!modelsFor(harness).some((model) => model.id === "gpt-6-astra"));
  console.log("Model checks passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const sha = "a".repeat(40),
  entry = fileURLToPath(new URL("./manual-entry.mjs", import.meta.url));
function run(config, { copiedEntry = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "manual-preflight-contract-"));
  let program = entry;
  try {
    if (copiedEntry) {
      program = join(root, "manual-entry.mjs");
      copyFileSync(entry, program);
      copyFileSync(
        fileURLToPath(new URL("./preflight-state.mjs", import.meta.url)),
        join(root, "preflight-state.mjs"),
      );
    }
    const configPath = join(root, "config.json"),
      summary = join(root, "summary.json");
    writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
    const result = spawnSync(process.execPath, [program, configPath, summary, "source", sha], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    const value = JSON.parse(readFileSync(summary, "utf8"));
    assert.equal(value.passed, false);
    assert.equal(value.realCollectorCli, false);
    assert.equal(value.functionalStepsCompleted, false);
    const publicBytes = JSON.stringify(value) + result.stdout + result.stderr;
    assert.equal(publicBytes.includes(root), false);
    assert.equal(publicBytes.includes("invented-secret-never-log"), false);
    return value.preflightFailure;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("a configuration parse failure before lifecycle try produces a sanitized false summary", () => {
  const result = run('{"private":"invented-secret-never-log"');
  assert.equal(result.phase, "configuration");
  assert.equal(result.assertionId, null);
});
test("a provenance assertion identifies its fixed check without actual or expected data", () => {
  const result = run({
    sourceCommit: sha,
    mode: "source",
    sourceManifest: "invented-source.json",
    sourceManifestSha256: "invented-secret-never-log",
  });
  assert.equal(result.phase, "provenance");
  assert.equal(result.errorCode, "ERR_ASSERTION");
  assert.equal(result.assertionId, "provenance-assert-001");
});
test("a missing module is captured before any manual-smoke top-level code runs", () => {
  const result = run({}, { copiedEntry: true });
  assert.equal(result.phase, "module-import");
  assert.equal(result.errorCode, "ERR_MODULE_NOT_FOUND");
  assert.equal(result.assertionId, null);
});

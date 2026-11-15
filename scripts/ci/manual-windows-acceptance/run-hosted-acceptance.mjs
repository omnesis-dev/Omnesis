// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { acceptedManualMode } from "./result-acceptance.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
async function main() {
  const [checkoutArg, workArg] = process.argv.slice(2),
    checkout = resolve(checkoutArg),
    work = resolve(workArg);
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  const dir = dirname(fileURLToPath(import.meta.url));
  const { runWindowsJob } = await import(
    pathToFileURL(join(checkout, "packages/platform/dist/windows-job.js")).href
  );
  const publicDir = join(work, "public");
  mkdirSync(publicDir);
  const details = [];
  let failed = false,
    uncertain = false;
  function save() {
    writeFileSync(
      join(publicDir, "acceptance-summary.json"),
      JSON.stringify(
        {
          complete: details.length === 2,
          passed: details.length === 2 && !failed && !uncertain,
          readinessBudgetMs: 90000,
          gracefulBudgetMs: 35000,
          modes: details,
        },
        null,
        2,
      ),
    );
  }
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.toUpperCase().startsWith("OMNESIS_")) delete env[name];
  function boolean(value) {
    assert.equal(typeof value, "boolean");
    return value;
  }
  function count(value) {
    assert.ok(Number.isFinite(value) && value >= 0);
    return value;
  }
  function label(value) {
    assert.match(value, /^[a-z0-9-]{1,90}$/);
    return value;
  }
  for (const mode of ["source", "compiled"]) {
    const configPath = join(work, mode + "-config.json"),
      config = JSON.parse(readFileSync(configPath, "utf8"));
    if (uncertain) {
      details.push({ mode, passed: false, skippedForUnconfirmedCleanup: true });
      failed = true;
      save();
      continue;
    }
    const result = await runWindowsJob(
      process.execPath,
      [...config.nodeArgs, join(dir, "manual-smoke.mjs"), configPath],
      { cwd: checkout, env, timeoutMs: 15 * 60 * 1000 },
    );
    // Child diagnostics can contain synthetic credentials. Keep all bytes in the
    // ephemeral runner's private workspace, never the artifact upload directory.
    writeFileSync(join(work, mode + "-private.stdout.log"), result.stdout);
    writeFileSync(join(work, mode + "-private.stderr.log"), result.stderr);
    const joined = !Object.hasOwn(result, "cleanupFailure");
    uncertain = !joined;
    let entry = {
      mode,
      passed: false,
      canonicalJobJoined: joined,
      applicationExitCode: result.exitCode,
      operationFailed: result.failure !== undefined,
    };
    if (existsSync(config.publicSummaryFile)) {
      const r = JSON.parse(readFileSync(config.publicSummaryFile, "utf8"));
      assert.equal(r.sourceCommit, config.sourceCommit);
      assert.equal(r.mode, mode);
      entry = {
        ...entry,
        passed: acceptedManualMode(
          boolean(r.passed) &&
            boolean(r.sqliteWithoutKeyRefused) &&
            boolean(r.sqlitePlainControlRead) &&
            boolean(r.duckdbWithoutKeyRefused),
          result,
        ),
        sqliteWithoutKeyRefused: boolean(r.sqliteWithoutKeyRefused),
        sqlitePlainControlRead: boolean(r.sqlitePlainControlRead),
        duckdbWithoutKeyRefused: boolean(r.duckdbWithoutKeyRefused),
        realCollectorCli: boolean(r.realCollectorCli),
        modelInference: boolean(r.modelInference),
        documents: count(r.documents),
        encryptedAnalyticsKeyPresent: boolean(r.encryptedAnalyticsKeyPresent),
        functionalStepsCompleted: boolean(r.functionalStepsCompleted),
        readinessAcceptanceFailed: boolean(r.readinessAcceptanceFailed),
        gracefulAcceptanceFailed: boolean(r.gracefulAcceptanceFailed),
        cleanupUnconfirmed: boolean(r.cleanupUnconfirmed) || !joined,
        ungracefulFallback: boolean(r.ungracefulFallback),
        failedPhase: r.failedPhase === null ? null : label(r.failedPhase),
        readiness: r.readinessObservations.map((x) => {
          assert.ok(["gateway", "collector"].includes(x.component));
          return {
            component: x.component,
            elapsedMs: count(x.elapsedMs),
            budgetMs: count(x.sourceTestBudgetMs),
            withinBudget: boolean(x.withinSourceTestBudget),
          };
        }),
        phases: r.phaseResults.map((x) => ({
          name: label(x.name),
          passed: boolean(x.passed),
          elapsedMs: count(x.elapsedMs),
        })),
        resolutionHashes: r.resolutionHashes.map((x) => {
          assert.match(x.from, /^(runtime-root|omnesis|@omnesis\/[a-z0-9-]+)$/);
          assert.match(x.name, /^@omnesis\/[a-z0-9-]+$/);
          assert.match(x.sha256, /^[a-f0-9]{64}$/);
          return { from: x.from, name: x.name, sha256: x.sha256 };
        }),
      };
      uncertain ||= r.cleanupUnconfirmed;
    }
    failed ||= !entry.passed;
    details.push(entry);
    console.log(
      JSON.stringify({
        phase: "hosted-manual-mode-complete",
        mode,
        passed: entry.passed,
        canonicalJobJoined: joined,
      }),
    );
    save();
  }
  const provenance = JSON.parse(readFileSync(join(work, "provenance-summary.json"), "utf8"));
  for (const key of ["sourceCommit", "sourceManifestSha256", "buildManifestSha256"])
    assert.match(provenance[key], key === "sourceCommit" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/);
  writeFileSync(
    join(publicDir, "provenance-summary.json"),
    JSON.stringify(
      {
        sourceCommit: provenance.sourceCommit,
        sourceManifestSha256: provenance.sourceManifestSha256,
        buildManifestSha256: provenance.buildManifestSha256,
        sourceFiles: count(provenance.sourceFiles),
        stagedFiles: count(provenance.stagedFiles),
        packages: count(provenance.packages),
      },
      null,
      2,
    ),
  );
  if (failed || uncertain) process.exitCode = 1;
}
await main().catch(() => {
  try {
    const out = resolve(process.argv[3], "public", "acceptance-summary.json");
    if (existsSync(dirname(out)))
      writeFileSync(
        out,
        JSON.stringify({
          complete: false,
          passed: false,
          controllerFailure: true,
          scratchRetained: true,
        }),
      );
  } catch {}
  console.error(
    JSON.stringify({
      phase: "hosted-manual-controller-failed",
      passed: false,
      scratchRetained: true,
    }),
  );
  process.exitCode = 1;
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
async function main() {
  const [checkoutArg, workArg, sourceCommit] = process.argv.slice(2),
    checkout = resolve(checkoutArg),
    work = resolve(workArg);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(process.platform, "win32");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  });
  assert.equal(revision.status, 0);
  assert.equal(revision.stdout.trim(), sourceCommit);
  mkdirSync(work);
  const deployed = join(work, "canonical-runtime");
  mkdirSync(deployed);
  const { prepareHermesRuntimeAssets } = await import(
    pathToFileURL(join(checkout, "packages/cli/src/commands/integration-runtime.ts")).href
  );
  const packageRoot = join(checkout, "packages/agent-integration");
  const runtime = prepareHermesRuntimeAssets(
    { packageRoot, entry: join(packageRoot, "src/index.ts") },
    "win32",
  );
  const sha = (data) => createHash("sha256").update(data).digest("hex");
  const graph = [];
  for (const { file, content } of runtime.files) {
    const path = join(deployed, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    graph.push({ path: file.split("\\").join("/"), sha256: sha(content) });
  }
  runtime.cleanup();
  const bridge = join(deployed, "windows-files.mjs"),
    original = readFileSync(bridge, "utf8");
  const diagnostics = `function diagnosticFields(error){
 const result={};
 const stages=new Set(['bootstrap','resolve','parent','create','validate','write','commit','flush','rename','read','inspect','repair','unsafe-file','seal-private','cleanup','storage-ancestor','storage-create','storage-inheritance','storage-open','storage-resolve','storage-root']);
 if(stages.has(error?.stage))result.nativeStage=error.stage;
 if(Number.isInteger(error?.nativeCode)&&error.nativeCode>=0&&error.nativeCode<=4294967295)result.nativeCode=error.nativeCode;
 const fixed=new Map([['Windows file access is unsafe and cannot be repaired online. Stop related processes, review the owner and access rules, and recreate the file privately before retrying.','unsafe-file'],['Private directory requires a trusted Windows owner and safe ACL','unsafe-directory'],['Cannot verify Windows native worker owner','cache-owner'],['Windows local application directory is unavailable','cache-root']]);
 if(fixed.has(error?.message))result.refusal=fixed.get(error.message);
 const bootstrap=typeof error?.message==='string'&&error.message.startsWith('Cannot initialize the protected Windows native worker')?/\\bEPRIVATE:([a-z-]{1,60}):([0-9]{1,10})\\b/u.exec(error.message):null;
 if(bootstrap&&stages.has(bootstrap[1])){result.bootstrapStage=bootstrap[1];result.bootstrapNativeCode=Number(bootstrap[2]);}
 if(error!==null&&(typeof error==='object'||typeof error==='function')&&Object.hasOwn(error,'cleanupFailure'))result.cleanupUnconfirmed=true;
 return result;
}\n`;
  const needle = "      code,\n      message:";
  assert.equal(original.split(needle).length, 2, "Unexpected bridge diagnostic insertion boundary");
  const instrumented =
    diagnostics +
    original.replace(needle, "      code,\n      ...diagnosticFields(error),\n      message:");
  writeFileSync(bridge, instrumented);
  cpSync(join(packageRoot, "hermes/test_adapter.py"), join(deployed, "test_adapter.py"));
  const scripts = dirname(fileURLToPath(import.meta.url));
  for (const name of ["temp-diagnostic.py", "path-metadata.mjs"])
    cpSync(join(scripts, name), join(deployed, name));
  const commonParent = mkdtempSync(join(tmpdir(), "hermes-temp-comparison-"));
  const nodeRoot = mkdtempSync(join(commonParent, "node-created-"));
  mkdirSync(join(nodeRoot, "state-case"));
  mkdirSync(join(nodeRoot, "write-case"));
  const { bootstrapWindowsPlatform } = await import(
    pathToFileURL(join(checkout, "scripts/lib/bootstrap-platform.mjs")).href
  );
  const { runWindowsJob } = await bootstrapWindowsPlatform();
  const result = await runWindowsJob(
    "python",
    ["-B", join(deployed, "temp-diagnostic.py"), nodeRoot, process.execPath, commonParent],
    { cwd: deployed, env: { ...process.env }, timeoutMs: 5 * 60 * 1000 },
  );
  writeFileSync(join(work, "private.stdout.log"), result.stdout);
  writeFileSync(join(work, "private.stderr.log"), result.stderr);
  const provenance = {
    sourceCommit,
    originalBridgeSha256: sha(original),
    instrumentedBridgeSha256: sha(instrumented),
    generatedGraph: graph,
  };
  writeFileSync(join(work, "provenance.json"), JSON.stringify(provenance, null, 2));
  const joined = !Object.hasOwn(result, "cleanupFailure");
  let diagnostic;
  try {
    diagnostic = JSON.parse(result.stdout.toString().trim());
    assert.equal(diagnostic.phase, "hermes-temp-privacy-diagnostic");
  } catch {
    diagnostic = {
      phase: "hermes-temp-privacy-diagnostic",
      diagnosticCollected: false,
      allRequestedCasesPassed: false,
      cleanupUnconfirmed: !joined,
    };
  }
  // Every leaf of this structured diagnostic is produced by the fixed scripts;
  // reject unexpected fields or strings before copying into the public record.
  const origins = new Set(["node-created", "python-default", "python-explicit-0700", "controller"]);
  const allowedKeys = new Set([
    "phase",
    "diagnosticCollected",
    "allRequestedCasesPassed",
    "cleanupUnconfirmed",
    "rows",
    "origin",
    "stage",
    "skippedForUnconfirmedCleanup",
    "metadata",
    "metadataProcessFailed",
    "metadataReturned",
    "ownerIsCurrent",
    "ownerIsSystem",
    "ownerIsAdministrators",
    "protected",
    "inheritedAceCount",
    "explicitAceCount",
    "broadReadAllowCount",
    "currentReadDenyCount",
    "nativeInspectReturned",
    "private",
    "fixed",
    "code",
    "nativeCode",
    "passed",
    "errorType",
    "native",
    "nativeStage",
    "bootstrapStage",
    "bootstrapNativeCode",
    "refusal",
    "pythonVersion",
    "sameParentIdentity",
    "setupInvalid",
  ]);
  function check(value, key) {
    if (value === null) return;
    if (Array.isArray(value)) {
      assert.ok(value.length <= 50);
      for (const x of value) check(x);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        assert.ok(allowedKeys.has(k));
        check(v, k);
      }
      return;
    }
    if (typeof value === "boolean") return;
    if (typeof value === "number") {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 4294967295);
      return;
    }
    assert.equal(typeof value, "string");
    assert.ok(value.length <= 90);
    assert.match(value, /^[A-Za-z0-9-]+$/);
    if (key === "origin") assert.ok(origins.has(value));
  }
  check(diagnostic);
  diagnostic.canonicalJobJoined = joined;
  diagnostic.operationFailed = result.failure !== undefined;
  diagnostic.sourceCommit = sourceCommit;
  diagnostic.provenanceSha256 = sha(JSON.stringify(provenance));
  if (!joined || result.failure !== undefined || result.exitCode !== 0)
    diagnostic.diagnosticCollected = false;
  writeFileSync(join(work, "public-diagnostic.json"), JSON.stringify(diagnostic, null, 2));
  console.log(JSON.stringify(diagnostic));
  if (!diagnostic.diagnosticCollected) process.exitCode = 1;
}
await main().catch(() => {
  console.log(
    JSON.stringify({
      phase: "hermes-temp-diagnostic-controller-failed",
      diagnosticCollected: false,
      scratchRetained: true,
    }),
  );
  process.exitCode = 1;
});

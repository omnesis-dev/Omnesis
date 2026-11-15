// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { setPreflightPhase, taggedAssert } from "./preflight-state.mjs";

import assert from "node:assert/strict";
import { recordReadiness, manualAcceptance } from "./readiness-acceptance.mjs";
import { verifyRuntimeProvenance } from "./verify-runtime-provenance.mjs";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  createWriteStream,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:net";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
setPreflightPhase("configuration");
const manifestPath = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
setPreflightPhase("provenance");
const provenance = verifyRuntimeProvenance(manifest);
process.stdout.write(
  JSON.stringify({
    phase: "manual-module-provenance",
    sourceCommit: provenance.sourceCommit,
    mode: provenance.mode,
    sourceManifestSha256: provenance.sourceManifestSha256,
    buildManifestSha256: provenance.buildManifestSha256,
    resolvedContexts: provenance.resolved.length,
  }) + "\n",
);
setPreflightPhase("platform");
taggedAssert("manual-assert-001", assert.ok, ["source", "compiled"].includes(manifest.mode));
taggedAssert("manual-assert-002", assert.equal, process.platform, "win32");
taggedAssert("manual-assert-003", assert.equal, process.arch, "x64");
setPreflightPhase("fixture-root");
const source = manifest.runtimeRoot;
const nodePath = manifest.nodePath;
const nodeArgs = manifest.nodeArgs ?? [];
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL(join(source, "package.json")));
const auditParent = resolve(manifest.fixtureParent);
mkdirSync(auditParent, { recursive: true });
const root = mkdtempSync(join(auditParent, "manual-runtime-" + manifest.mode + "-"));
const cfg = join(root, "config"),
  vault = join(root, "vault");
const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const url = "https://localhost:" + port;
for (const name of Object.keys(process.env))
  if (name.toUpperCase().startsWith("OMNESIS_")) delete process.env[name];
setPreflightPhase("environment");
const env = {
  ...process.env,
  OMNESIS_BIND: "127.0.0.1",
  OMNESIS_CONFIG_DIR: cfg,
  OMNESIS_DB_PATH: join(root, "gateway.db"),
  OMNESIS_ANALYTICS_DB_PATH: join(root, "analytics.db"),
  OMNESIS_GATEWAY_PORT: String(port),
  OMNESIS_GATEWAY_URL: url,
  OMNESIS_COLLECTOR_HOSTNAME: "audit-notes",
  OMNESIS_MDNS_DISABLE: "1",
  OMNESIS_SECRET_STORE: "passphrase",
  OMNESIS_KEYRING_PASSPHRASE: randomBytes(32).toString("base64url"),
  OMNESIS_IO_CONCURRENCY: "2",
  OMNESIS_CPU_CONCURRENCY: "2",
  OMNESIS_SEARCH_WORKER_CONCURRENCY: "1",
  OMNESIS_USEARCH_BACKFILL_THREADS: "1",
  OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
  OMNESIS_E2E_DISABLE_RELEASE_CHECK: "1",
  OMNESIS_E2E_DISABLE_ICON_FETCH: "1",
  OMNESIS_AGENT_BACKEND: "replay",
  OMNESIS_EXPERIMENTAL: "0",
  OMNESIS_SYNTHETIC: "0",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  CI: "1",
};
for (const k of [
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "OMNESIS_INSECURE_TLS",
  "OMNESIS_TOKEN",
]) {
  delete env[k];
  delete process.env[k];
}
Object.assign(process.env, env);
setPreflightPhase("core-import");
const core = await import(pathToFileURL(req.resolve("@omnesis/core")).href);
setPreflightPhase("core-api");
taggedAssert("manual-assert-004", assert.equal, typeof core.ensurePrivateDirs, "function");
taggedAssert("manual-assert-005", assert.equal, typeof core.atomicWriteFile, "function");
taggedAssert("manual-assert-006", assert.equal, typeof core.createWindowsPrivateFile, "function");
taggedAssert("manual-assert-007", assert.ok, Number.isFinite(core.GATEWAY_EXIT_TIMEOUT_SECONDS));
const legacyGracefulAcceptanceMs = 35000;
const productExitEnvelopeMs = core.GATEWAY_EXIT_TIMEOUT_SECONDS * 1000;
taggedAssert(
  "manual-assert-008",
  assert.ok,
  [legacyGracefulAcceptanceMs, productExitEnvelopeMs].includes(manifest.gracefulObservationMs),
  "Explicit graceful observation must select legacy35s or the existing product exit envelope",
);
setPreflightPhase("private-directories");
await core.ensurePrivateDirs([root, cfg, vault]);
setPreflightPhase("vault-fixtures");
mkdirSync(join(vault, ".obsidian"));
const fixtures = [
  [
    "Observatory inventory.md",
    "# Observatory inventory\n\nInvented amber lantern and telescope inventory.\n",
  ],
  [
    "Field checklist.md",
    "# Field checklist\n\nInvented amber lantern checklist for an imaginary observatory.\n",
  ],
  ["Calibration log.md", "# Calibration log\n\nInvented optical calibration measurements.\n"],
];
for (const [name, text] of fixtures) writeFileSync(join(vault, name), text);
const roles = [
  "agent",
  "embedder",
  "transcriber",
  "ocr",
  "background-agent",
  "watch-judge",
  "entailment-verifier",
  "privacy-reviewer",
  "decision",
  "speech-to-speech",
];
setPreflightPhase("initial-config");
await core.atomicWriteFile(
  join(cfg, "omnesis.json"),
  JSON.stringify({
    inference: { assignments: Object.fromEntries(roles.map((r) => [r, null])) },
  }),
  { mode: 0o600 },
);
setPreflightPhase("fresh-token");
const entry = manifest.cliEntry;
taggedAssert(
  "manual-assert-009",
  assert.ok,
  !existsSync(join(cfg, "token")),
  "Fresh fixture unexpectedly has an existing owner token",
);
const diagnosticDaemonBudget = 90000; // Same documented90s readiness budget; late readiness still cannot pass.
const bootBudget = JSON.parse(readFileSync(manifest.sourceBootBudgetFile, "utf8")).seconds * 1000;
const receipt = {
  sourceCommit: manifest.sourceCommit,
  provenance,
  mode: manifest.mode,
  root,
  platform: process.platform,
  arch: process.arch,
  realCollectorCli: true,
  modelInference: false,
  privateDaemonObservationMs: diagnosticDaemonBudget,
  sourceTestDaemonBudgetMs: bootBudget,
  legacyGracefulAcceptanceMs,
  gracefulObservationMs: manifest.gracefulObservationMs,
  productExitEnvelopeMs,
  readinessObservations: [],
  steps: [],
  invocations: [],
  passed: false,
};
const emit = (v) => console.log(JSON.stringify(v));
const save = () => writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
let phase = "keyring-init",
  gateway,
  collector,
  token,
  agent,
  sequence = 0;
const children = [];
function unknown(error) {
  const seen = new Set();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if (Object.hasOwn(error, "cleanupFailure")) return true;
    error = error.cause;
  }
  return false;
}
function launchProgram(programArgs, label, childEnv = env, wrapped = false) {
  receipt.invocations.push({
    label,
    startedUtc: new Date().toISOString(),
    executable: nodePath,
    args: programArgs,
  });
  const out = createWriteStream(join(root, label + ".stdout.log")),
    err = createWriteStream(join(root, label + ".stderr.log"));
  const child = core.spawnWindowsJob(nodePath, programArgs, {
    cwd: source,
    env: childEnv,
    completion: "tree",
  });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  const record = {
    child,
    label,
    wrapped,
    stdout: "",
    stderr: "",
    fate: undefined,
  };
  record.ready = child.jobReady.then(
    () => true,
    (error) => {
      record.readyFailure = error;
      return false;
    },
  );
  record.joined = child.jobClosed.then(
    () =>
      (record.fate = {
        joined: true,
        code: child.exitCode,
        signal: child.signalCode,
      }),
    (error) => (record.fate = { joined: false, error }),
  );
  child.stdout.on("data", (b) => (record.stdout = (record.stdout + b.toString()).slice(-2097152)));
  child.stderr.on("data", (b) => (record.stderr = (record.stderr + b.toString()).slice(-2097152)));
  children.push(record);
  return record;
}
function launch(args, label) {
  const record = launchProgram(
    [
      ...nodeArgs,
      join(scriptDirectory, "owned-cli-wrapper.mjs"),
      manifestPath,
      JSON.stringify(args),
    ],
    label,
    env,
    true,
  );
  record.daemon =
    (args[0] === "gateway" && args[1] === "serve") ||
    (args[0] === "collector" && args[1] === "run");
  return record;
}
async function waitJoined(r, budget, label) {
  let timer;
  const fate = await Promise.race([
    r.joined,
    new Promise((resolve) => (timer = setTimeout(() => resolve(null), budget))),
  ]);
  clearTimeout(timer);
  if (!fate) {
    r.cleanupUnconfirmed = true;
    throw Object.assign(new Error("Owned Job join unresolved: " + label), {
      cleanupFailure: true,
    });
  }
  if (!fate.joined) throw fate.error;
  return fate;
}
async function cli(args, label, timeout = 180000) {
  const r = launch(args, ++sequence + "-" + label);
  let timer;
  const fate = await Promise.race([
    r.joined,
    new Promise((resolve) => (timer = setTimeout(() => resolve(null), timeout))),
  ]);
  clearTimeout(timer);
  if (!fate) {
    receipt.ungracefulFallback = true;
    r.child.kill("SIGKILL");
    await waitJoined(r, 90000, label + "-forced");
    throw new Error("CLI fixture deadline " + label);
  }
  if (!fate.joined) throw fate.error;
  assert.equal(fate.code, 0, "CLI failed " + label);
  return r.stdout;
}
async function until(check, budget, label) {
  const end = Date.now() + budget;
  let last;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    await delay(150);
  }
  throw new Error("Readiness deadline " + label, { cause: last });
}
function api(path, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const r = https.request(
      url + path,
      {
        method,
        agent,
        timeout: 10000,
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(encoded
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(encoded),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (b) => (text += b));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error("Owned API HTTP " + res.statusCode + " " + path));
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    r.once("error", reject);
    r.once("timeout", () => r.destroy(new Error("Owned API timeout")));
    r.end(encoded);
  });
}
async function step(name, fn) {
  phase = name;
  const start = Date.now();
  const firstNestedStep = receipt.steps.length;
  await fn();
  const passed = receipt.steps.slice(firstNestedStep).every((step) => step.passed !== false);
  receipt.steps.push({ name, passed, elapsedMs: Date.now() - start });
  save();
  emit({ phase: name, passed, elapsedMs: Date.now() - start });
}
async function startGateway() {
  const readinessStart = Date.now();
  gateway = launch(["gateway", "serve"], "gateway-" + sequence++);
  await until(
    async () => {
      if (gateway.fate || gateway.readyFailure)
        throw Object.assign(new Error("Gateway exited before readiness"), {
          fatal: true,
        });
      const cert = join(cfg, "tls", "cert.pem");
      if (!existsSync(cert)) return false;
      if (!agent) agent = new https.Agent({ ca: readFileSync(cert) });
      await api("/health");
      token = core.readTokenFile(cfg);
      if (!token) return false;
      await api("/whoami");
      env.OMNESIS_TOKEN = token;
      return true;
    },
    diagnosticDaemonBudget,
    "gateway",
  );
  const elapsedMs = Date.now() - readinessStart;
  recordReadiness(receipt, "gateway", elapsedMs, bootBudget);
}
async function startCollector() {
  const readinessStart = Date.now();
  collector = launch(["collector", "run"], "collector-" + sequence++);
  await until(
    async () => {
      if (collector.fate || collector.readyFailure)
        throw Object.assign(new Error("Collector exited before pairing"), {
          fatal: true,
        });
      const list = await api("/admin/devices");
      return (
        list.items?.some((d) => d.kind === "collector" && d.name === "audit-notes-collector") &&
        existsSync(join(cfg, "collector-token"))
      );
    },
    diagnosticDaemonBudget,
    "collector self-pair",
  );
  const elapsedMs = Date.now() - readinessStart;
  recordReadiness(receipt, "collector", elapsedMs, bootBudget);
  await cli(
    ["sources", "describe", "obsidian-notes", "--device", "audit-notes-collector", "--json"],
    "collector-descriptors",
    90000,
  );
}
async function stop(r) {
  if (!r) return;
  if (r.fate) {
    if (!r.fate.joined) throw r.fate.error;
    assert.equal(r.fate.code, 0, "Owned child exit " + r.label);
    assert.ok(
      !r.daemon || r.shutdownRequested,
      "Daemon exited without requested graceful shutdown",
    );
    return;
  }
  assert.ok(r.wrapped, "Only CLI wrappers support graceful IPC shutdown");
  const start = Date.now();
  r.shutdownRequested = true;
  r.child.stdin.write(JSON.stringify({ type: "shutdown", version: 1 }) + "\n");
  const budget = manifest.gracefulObservationMs;
  let timer;
  const fate = await Promise.race([
    r.joined,
    new Promise((resolve) => (timer = setTimeout(() => resolve(null), budget))),
  ]);
  clearTimeout(timer);
  if (!fate) {
    receipt.ungracefulFallback = true;
    r.child.kill("SIGKILL");
    await waitJoined(r, 90000, r.label + "-forced");
    throw new Error("Owned daemon did not drain " + r.label);
  }
  if (!fate.joined) throw fate.error;
  const lines = r.stderr.split(/\r?\n/u).filter((line) => line.startsWith("AUDIT_OWNED_CLI:"));
  const evidence = lines
    .map((line) => JSON.parse(line.slice("AUDIT_OWNED_CLI:".length)))
    .findLast((row) => row.event === "closed");
  assert.equal(evidence?.shutdownRequested, true, "Missing graceful shutdown receipt");
  assert.equal(evidence?.ipcAccepted, true, "Actual CLI refused parent shutdown IPC");
  assert.equal(evidence?.code, 0, "Actual CLI drain exit");
  assert.equal(fate.code, 0, "Owned wrapper drain exit");
  const elapsedMs = Date.now() - start;
  const withinLegacyGracefulAcceptance = elapsedMs <= legacyGracefulAcceptanceMs;
  if (!withinLegacyGracefulAcceptance) {
    receipt.gracefulAcceptanceFailed = true;
    receipt.functionalDiagnosticOnly = true;
    process.exitCode = 1;
  }
  receipt.steps.push({
    name: "joined-" + r.label,
    passed: withinLegacyGracefulAcceptance,
    legacyGracefulAcceptanceMs,
    gracefulObservationMs: budget,
    withinLegacyGracefulAcceptance,
    exitCode: fate.code,
    gracefulIpcAccepted: true,
    nativeJobJoined: true,
    elapsedMs,
  });
}

setPreflightPhase("lifecycle");
try {
  emit({
    phase: "manual-runtime-begin",
    sourceCommit: receipt.sourceCommit,
    arch: process.arch,
    realCollectorCli: true,
    modelInference: false,
  });
  await step("retain-private-audit-resume-key", async () => {
    await core.createWindowsPrivateFile(
      join(root, "audit-resume.key"),
      Buffer.from(env.OMNESIS_KEYRING_PASSPHRASE),
    );
    receipt.privateAuditResumeKey = true;
  });
  await step("keyring-init", async () => {
    const result = JSON.parse(
      await cli(["keyring", "init", "--backend", "passphrase", "--json"], "keyring-init"),
    );
    assert.equal(result.valid, true);
    assert.equal(result.store.backend, "passphrase");
  });
  await step("supported-cli-storage-init", async () => {
    const result = JSON.parse(
      await cli(
        ["keyring", "storage-init", "--backend", "passphrase", "--host", "all", "--json"],
        "storage-init",
        180000,
      ),
    );
    assert.equal(result.required, true);
    assert.ok(result.stores.length >= 4);
    assert.ok(result.stores.every((s) => s.valid));
    receipt.preparedStorageKeys = result.stores.length;
  });
  await step("gateway-tls-health-encrypted-boot", startGateway);
  await step("actual-collector-cli-self-pair", startCollector);
  await step("cli-add-real-obsidian-vault", async () => {
    await cli(
      [
        "sources",
        "add",
        "obsidian-notes",
        "--device",
        "audit-notes-collector",
        "--set",
        "vaultPath=" + vault,
      ],
      "source-add",
      90000,
    );
    const sources = await api("/admin/sources");
    const added = sources.items.find((s) => s.type === "obsidian-notes");
    assert.ok(added);
    receipt.sourceId = added.id;
    await cli(["sources", "resync", added.id, "--yes"], "source-resync", 90000);
  });
  let documents;
  await step("real-collector-sync-three-invented-docs", async () => {
    documents = await until(
      async () => {
        const result = await api(
          "/documents/search?q=" + encodeURIComponent("Invented") + "&limit=20",
        );
        return result.results?.length >= 3 ? result.results : false;
      },
      bootBudget,
      "source sync",
    );
    receipt.documentIds = documents.map((d) => d.id ?? d.documentId);
    assert.ok(receipt.documentIds.every(Boolean));
    assert.equal(new Set(receipt.documentIds).size, 3);
  });
  await step("cli-status-search-show-sql", async () => {
    await until(
      async () => {
        const result = await api("/search", {
          method: "POST",
          body: { text: "amber lantern", limit: 5 },
        });
        return result.results?.length > 0;
      },
      bootBudget,
      "lexical index ready",
    );
    JSON.parse(await cli(["status", "--json"], "status"));
    const found = JSON.parse(await cli(["search", "amber lantern", "--json"], "search", 90000));
    assert.ok(found.results.length >= 1);
    const id = receipt.documentIds[0];
    const doc = JSON.parse(await cli(["show", id, "--json"], "show"));
    assert.ok(JSON.stringify(doc).includes("Invented"));
    const count = JSON.parse(
      await cli(
        ["sql", "SELECT COUNT(*) AS count FROM documents", "--db", "sqlite", "--json"],
        "sqlite-query",
      ),
    );
    assert.equal(count.rows.length, 1);
    assert.equal(Number(count.rows[0][0]), 3);
    const analytics = JSON.parse(
      await cli(["sql", "SELECT 17 AS audit_value", "--db", "duckdb", "--json"], "duckdb-query"),
    );
    assert.equal(analytics.rows[0][0], 17);
    const key = await core.readStorageKey("analytics-db", { configDir: cfg });
    assert.equal(key?.length, 32);
    receipt.encryptedAnalyticsKeyPresent = true;
  });
  await step("first-graceful-joined-shutdown", async () => {
    await stop(collector);
    await stop(gateway);
  });
  await step("encrypted-analytics-no-key-refusal", async () => {
    assert.ok(existsSync(join(root, "analytics.db")));
    const cleanEnv = { ...env };
    for (const name of Object.keys(cleanEnv))
      if (name.startsWith("OMNESIS_")) delete cleanEnv[name];
    const r = launchProgram(
      [join(scriptDirectory, "no-key-duckdb.mjs"), manifest.depsRoot, join(root, "analytics.db")],
      "keyless-duckdb",
      cleanEnv,
    );
    const fate = await waitJoined(r, 90000, "keyless DuckDB");
    assert.equal(fate.code, 0);
    assert.equal(JSON.parse(r.stdout).encryptedWithoutKeyRefused, true);
    receipt.duckdbWithoutKeyRefused = true;
  });
  await step("encrypted-sqlite-no-key-refusal", async () => {
    assert.ok(existsSync(join(root, "gateway.db")));
    const cleanEnv = { ...env };
    for (const name of Object.keys(cleanEnv))
      if (name.toUpperCase().startsWith("OMNESIS_")) delete cleanEnv[name];
    const r = launchProgram(
      [
        join(scriptDirectory, "no-key-sqlite.mjs"),
        manifest.depsRoot,
        join(root, "gateway.db"),
        join(root, "invented-plain-control.sqlite"),
      ],
      "keyless-sqlite",
      cleanEnv,
    );
    const fate = await waitJoined(r, 90000, "keyless SQLite");
    assert.equal(fate.code, 0);
    const evidence = JSON.parse(r.stdout);
    assert.equal(evidence.sqliteWithoutKeyRefused, true);
    assert.equal(evidence.sqlitePlainControlRead, true);
    receipt.sqliteWithoutKeyRefused = true;
    receipt.sqlitePlainControlRead = true;
  });
  await step("restart-persistence-real-daemons", async () => {
    agent.destroy();
    agent = undefined;
    await startGateway();
    await startCollector();
    const persisted = await api("/documents/search?q=Invented&limit=20");
    assert.deepEqual(
      persisted.results.map((d) => d.id ?? d.documentId).sort(),
      receipt.documentIds.slice().sort(),
    );
    await cli(["status", "--json"], "restart-status");
  });
  await step("final-graceful-joined-shutdown", async () => {
    await stop(collector);
    await stop(gateway);
  });
  receipt.functionalStepsCompleted = true;
  receipt.passed = manualAcceptance(receipt);
  if (!receipt.passed) process.exitCode = 1;
  save();
} catch (error) {
  receipt.failedPhase = phase;
  receipt.errorType = error?.name;
  writeFileSync(
    join(root, "private-error.log"),
    JSON.stringify(
      {
        stack: String(error?.stack ?? error),
        cause: error?.cause
          ? {
              name: error.cause.name,
              code: error.cause.code,
              message: error.cause.message,
              stack: error.cause.stack,
            }
          : null,
      },
      null,
      2,
    ),
  );
  if (unknown(error)) receipt.cleanupUnconfirmed = true;
  save();
  process.exitCode = 1;
} finally {
  for (const r of [...children].reverse()) {
    if (r.cleanupUnconfirmed) {
      receipt.cleanupUnconfirmed = true;
      receipt.passed = false;
      process.exitCode = 1;
      continue;
    }
    if (r.fate) {
      if (!r.fate.joined) {
        receipt.cleanupUnconfirmed = true;
        receipt.passed = false;
        process.exitCode = 1;
      }
      continue;
    }
    try {
      await stop(r);
    } catch (error) {
      receipt.passed = false;
      process.exitCode = 1;
      if (unknown(error)) {
        receipt.cleanupUnconfirmed = true;
        continue;
      }
      receipt.ungracefulFallback = true;
      try {
        r.child.kill("SIGKILL");
        await waitJoined(r, 90000, r.label + "-cleanup");
      } catch {
        receipt.cleanupUnconfirmed = true;
      }
    }
  }
  agent?.destroy();
  save();
  emit({
    phase: "manual-runtime-summary",
    passed: receipt.passed,
    mode: manifest.mode,
    steps: receipt.steps.length,
    documents: receipt.documentIds?.length ?? 0,
    legacyGracefulAcceptanceMs,
    gracefulObservationMs: manifest.gracefulObservationMs,
    functionalDiagnosticOnly: receipt.functionalDiagnosticOnly ?? false,
    readinessAcceptanceFailed: receipt.readinessAcceptanceFailed ?? false,
    sourceCommit: receipt.sourceCommit,
    failedPhase: receipt.failedPhase ?? null,
    cleanupUnconfirmed: receipt.cleanupUnconfirmed ?? false,
    ungracefulFallback: receipt.ungracefulFallback ?? false,
    readinessObservations: receipt.readinessObservations,
    phaseResults: receipt.steps.map(({ name, passed, elapsedMs }) => ({
      name,
      passed,
      elapsedMs,
    })),
  });
  writeFileSync(
    manifest.publicSummaryFile,
    JSON.stringify(
      {
        sourceCommit: receipt.sourceCommit,
        mode: manifest.mode,
        passed: receipt.passed,
        realCollectorCli: true,
        modelInference: false,
        documents: receipt.documentIds?.length ?? 0,
        privateAuditResumeKey: receipt.privateAuditResumeKey === true,
        encryptedAnalyticsKeyPresent: receipt.encryptedAnalyticsKeyPresent === true,
        sqliteWithoutKeyRefused: receipt.sqliteWithoutKeyRefused === true,
        sqlitePlainControlRead: receipt.sqlitePlainControlRead === true,
        duckdbWithoutKeyRefused: receipt.duckdbWithoutKeyRefused === true,
        functionalStepsCompleted: receipt.functionalStepsCompleted === true,
        readinessAcceptanceFailed: receipt.readinessAcceptanceFailed === true,
        gracefulAcceptanceFailed: receipt.gracefulAcceptanceFailed === true,
        cleanupUnconfirmed: receipt.cleanupUnconfirmed === true,
        ungracefulFallback: receipt.ungracefulFallback === true,
        failedPhase: receipt.failedPhase ?? null,
        readinessObservations: receipt.readinessObservations,
        phaseResults: receipt.steps.map(({ name, passed, elapsedMs }) => ({
          name,
          passed,
          elapsedMs,
        })),
        sourceManifestSha256: manifest.sourceManifestSha256,
        buildManifestSha256: manifest.buildManifestSha256 ?? null,
        resolutionHashes: provenance.resolved.map(({ from, name, entry }) => ({
          from,
          name,
          sha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
        })),
      },
      null,
      2,
    ),
  );
}

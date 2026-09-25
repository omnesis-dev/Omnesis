// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis secure` — the guided path from a plaintext install to full at-rest
 * encryption, in one safe, legible command.
 *
 * The individual building blocks exist as separate commands (`keyring init`,
 * `keyring migrate`, `keyring storage-init`, `keyring export-recovery`,
 * `backup`), but reaching the secure state by hand is a multi-step dance with
 * two sharp edges: the database migration at next gateway boot is one-way, and
 * nothing took a backup first. The wizard runs the whole chain in a safe
 * order — recovery escrow and a pre-migration backup come BEFORE anything
 * irreversible — and then performs or precisely names the gateway restart.
 *
 * Order of operations:
 *   1. posture  — inspect the secret store, root key, markers, store keys,
 *                 database headers, and gateway reachability
 *   2. backup   — online (`/admin/backup`) when the gateway is running, else
 *                 an offline snapshot of the database files, restorable with
 *                 `omnesis restore` (or `omnesis secure --rollback`)
 *   3. root key — create it in the chosen secret-store backend
 *   4. escrow   — export the recovery code + envelope (printed exactly once)
 *   5. migrate  — encrypt existing secret files in place
 *   6. keys     — mint the wrapped per-store live-storage keys
 *   7. restart  — restart the gateway service when one is installed (else name
 *                 the exact command), then verify encryption took effect
 *
 * The host's role decides which of those apply. A host that only runs a
 * collector has no gateway databases to back up or verify and no gateway to
 * restart: it keeps provider stores that migrate in place when their source
 * next opens them, so the wizard mints the collector's keys and restarts the
 * collector service instead. The gateway named in the config is never
 * restarted from a collector host, and its health is never taken as proof
 * of this host's encryption.
 *
 * `--dry-run` prints the plan for this install without changing anything.
 * `--rollback` restores the pre-secure backup recorded by a previous run
 * (databases only for offline snapshots; the keyring material stays, so a
 * re-run simply re-encrypts).
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  liveGatewayHolder,
  DEFAULT_CONFIG_DIR,
  SECRET_STORE_BACKENDS,
  GATEWAY_STORE_FILE,
  storageKeyNamesForHosts,
  atomicWriteFileSync,
  createRecoveryEnvelope,
  createSecretStore,
  ensureInstallRootKey,
  ensurePrivateDirSync,
  ensureStorageKey,
  generateRecoveryCode,
  inspectInstallRootKey,
  inspectStorageKey,
  markSecretFileEncryptionRequired,
  migrateSecretTextFile,
  parseSecretStoreBackend,
  readPackageVersion,
  recoveryEnvelopePath,
  storageEncryptionRequired,
  type SecretStoreBackend,
  type SecretStoreStatus,
  type StorageKeyHost,
} from "@omnesis/core";
import { c, CliError, EXIT_FAILURE, EXIT_USER_ERROR, gatewayFetch, isJSON } from "../utils.js";
import { collectSecretFileCandidates } from "./keyring.js";
import { restore } from "./restore.js";

const WIZARD_STATE_FILE = "keyring/secure-wizard.json";
const CLI_VERSION = readPackageVersion(import.meta.url);
// First 15 bytes of a plaintext SQLite file; byte 16 is NUL.
const SQLITE_MAGIC_PREFIX = "SQLite format 3";

interface WizardState {
  backupDir: string;
  backupKind: "online" | "offline";
  startedAt: string;
}

export interface SecureDeps {
  configDir: string;
  backend: SecretStoreBackend;
  /** GET /health against the configured gateway; false on any failure. */
  gatewayHealthy(): Promise<boolean>;
  /** Drive the gateway's online backup and wait for completion. */
  onlineBackup(note: string): Promise<void>;
  /** Restart a local service; "not-installed" when no unit manages it. */
  restartService(
    component: "gateway" | "collector",
  ): Promise<"restarted" | "not-installed" | "failed">;
  now(): Date;
  log(line: string): void;
}

export interface SecureOptions {
  dryRun: boolean;
  skipBackup: boolean;
  /** The processes to secure for, when the operator names them instead of letting the wizard detect. */
  hosts?: StorageKeyHost[];
}

interface StepResult {
  id: string;
  title: string;
  status: "done" | "skipped" | "planned" | "action-required";
  detail: string;
}

export interface SecureSummary {
  steps: StepResult[];
  recoveryCode?: string;
  backupDir?: string;
}

/** True when the file exists and starts with the plaintext SQLite magic. */
function sqliteLooksPlaintext(path: string): boolean | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(16);
    const read = readSync(fd, head, 0, 16, 0);
    return read === 16 && head.toString("latin1", 0, 15) === SQLITE_MAGIC_PREFIX && head[15] === 0;
  } finally {
    closeSync(fd);
  }
}

/** Offline pre-migration snapshot: copy the database files (with their WAL/SHM
 * companions) into a restore-compatible backup directory. Only safe while the
 * gateway is stopped — the caller guarantees that. */
function offlineBackup(configDir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(configDir, "backups", `${stamp}-pre-secure`);
  mkdirSync(dir, { recursive: true });
  const files: Array<{ name: string; bytes: number }> = [];
  for (const base of ["omnesis.db", "index.db", "analytics.db"]) {
    for (const name of [base, `${base}-wal`, `${base}-shm`]) {
      const src = join(configDir, name);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(dir, name));
      files.push({ name, bytes: readFileSync(join(dir, name)).length });
    }
  }
  atomicWriteFileSync(
    join(dir, "backup-manifest.json"),
    `${JSON.stringify(
      {
        version: CLI_VERSION,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        includeIndex: true,
        note: "pre-secure",
        files,
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

/**
 * A gateway that is booting or draining holds the stores while `/health`
 * does not answer, so an offline step must ask the config dir's lock, not
 * only the HTTP probe.
 */
function assertNoLiveGateway(configDir: string, action: string): void {
  const holder = liveGatewayHolder(configDir);
  if (!holder) return;
  throw new CliError(
    `Gateway PID ${holder.pid} still owns ${configDir}; wait for it to exit (or \`omnesis service stop gateway\`) before trying to ${action}.`,
    EXIT_USER_ERROR,
  );
}

export async function runSecure(deps: SecureDeps, opts: SecureOptions): Promise<SecureSummary> {
  const { configDir, backend } = deps;
  const steps: StepResult[] = [];
  const summary: SecureSummary = { steps };

  // ── 1. posture ──────────────────────────────────────────────────────
  const store = createSecretStore({ backend, configDir });
  const storeStatus: SecretStoreStatus = await store.status();
  if (!storeStatus.available) {
    throw new CliError(
      `The "${storeStatus.backend}" secret store is not available: ${storeStatus.detail}`,
      EXIT_USER_ERROR,
    );
  }
  const root = await inspectInstallRootKey({ backend, configDir });
  if (root.present && !root.valid) {
    throw new CliError(
      "An install root key exists but cannot be read (wrong passphrase or corrupt entry). " +
        "Fix the secret-store configuration before securing this install.",
      EXIT_FAILURE,
    );
  }
  // The host's role, from the state each process leaves behind: a paired
  // collector's token and the gateway's database — or its lock, since a
  // running gateway whose database was moved elsewhere still owns this
  // directory. A fresh directory is a gateway install until a collector
  // pairs in it; `--host` overrides the detection.
  const collectorPaired = existsSync(join(configDir, "collector-token"));
  const gatewayPresent =
    existsSync(join(configDir, GATEWAY_STORE_FILE)) || liveGatewayHolder(configDir) !== null;
  const hosts: StorageKeyHost[] =
    opts.hosts ??
    (collectorPaired && !gatewayPresent
      ? ["collector"]
      : collectorPaired
        ? ["gateway", "collector"]
        : ["gateway"]);
  const hasGateway = hosts.includes("gateway");
  const hasCollector = hosts.includes("collector");
  deps.log(
    `${c.dim}Host role: ${
      hasGateway && hasCollector ? "gateway and collector" : hasGateway ? "gateway" : "collector"
    }${opts.hosts ? " (from --host)" : ""}${c.reset}`,
  );
  // A collector host has no gateway beside it: the gateway in its config is
  // remote, and its health says nothing about this host's stores.
  const healthy = hasGateway ? await deps.gatewayHealthy() : false;
  const mainDbPlain = hasGateway ? sqliteLooksPlaintext(join(configDir, "omnesis.db")) : null;
  const storageKeyNames = storageKeyNamesForHosts(hosts);
  const storeStates = await Promise.all(
    storageKeyNames.map((k) => inspectStorageKey(k, { backend, configDir })),
  );
  const allKeysPresent = storeStates.every((s) => s.present && s.valid);
  const envelopeExists = existsSync(recoveryEnvelopePath(configDir));
  const candidates = collectSecretFileCandidates(configDir);

  const plan = (id: string, title: string, status: StepResult["status"], detail: string) => {
    steps.push({ id, title, status, detail });
    deps.log(
      `${status === "done" ? `${c.green}✔` : status === "skipped" ? `${c.dim}∅` : status === "action-required" ? `${c.yellow}▶` : `${c.cyan}·`}${c.reset} ${title} ${c.dim}— ${detail}${c.reset}`,
    );
  };

  // ── 2. backup ───────────────────────────────────────────────────────
  if (!hasGateway) {
    plan(
      "backup",
      "Pre-migration backup",
      "skipped",
      "no gateway databases on this host; provider stores migrate through staged copies",
    );
  } else if (opts.skipBackup) {
    plan("backup", "Pre-migration backup", "skipped", "--skip-backup was passed");
  } else if (opts.dryRun) {
    plan(
      "backup",
      "Pre-migration backup",
      "planned",
      healthy ? "online backup via the running gateway" : "offline snapshot of the database files",
    );
  } else if (healthy) {
    await deps.onlineBackup("pre-secure");
    plan("backup", "Pre-migration backup", "done", "online backup completed (note: pre-secure)");
  } else {
    assertNoLiveGateway(configDir, "take an offline snapshot");
    const dir = offlineBackup(configDir, deps.now());
    summary.backupDir = dir;
    ensurePrivateDirSync(join(configDir, "keyring"));
    atomicWriteFileSync(
      join(configDir, WIZARD_STATE_FILE),
      `${JSON.stringify({ backupDir: dir, backupKind: "offline", startedAt: deps.now().toISOString() } satisfies WizardState, null, 2)}\n`,
    );
    plan("backup", "Pre-migration backup", "done", `offline snapshot at ${dir}`);
  }

  // ── 3. root key ─────────────────────────────────────────────────────
  if (root.valid) {
    plan("root-key", "Install root key", "skipped", `already present (${storeStatus.backend})`);
  } else if (opts.dryRun) {
    plan("root-key", "Install root key", "planned", `create in ${storeStatus.backend}`);
  } else {
    await ensureInstallRootKey({ backend, configDir });
    await markSecretFileEncryptionRequired(configDir);
    plan("root-key", "Install root key", "done", `created in ${storeStatus.backend}`);
  }

  // ── 4. recovery escrow ──────────────────────────────────────────────
  if (envelopeExists) {
    plan("escrow", "Recovery escrow", "skipped", "a recovery envelope already exists");
  } else if (opts.dryRun) {
    plan("escrow", "Recovery escrow", "planned", "generate a recovery code + envelope");
  } else {
    const rootKeyValue = await store.read("install-root-key-v1");
    if (!rootKeyValue) throw new CliError("Root key vanished while securing.", EXIT_FAILURE);
    const code = generateRecoveryCode();
    ensurePrivateDirSync(join(configDir, "keyring"));
    atomicWriteFileSync(
      recoveryEnvelopePath(configDir),
      `${JSON.stringify(createRecoveryEnvelope(rootKeyValue, code), null, 2)}\n`,
    );
    summary.recoveryCode = code;
    plan(
      "escrow",
      "Recovery escrow",
      "done",
      "recovery code generated — printed below, shown once",
    );
  }

  // ── 5. migrate secret files ─────────────────────────────────────────
  if (opts.dryRun) {
    plan("migrate", "Encrypt secret files", "planned", `${candidates.length} candidate file(s)`);
  } else {
    let changed = 0;
    for (const path of candidates) {
      const result = await migrateSecretTextFile(path, { backend, configDir });
      if (result.changed) changed += 1;
    }
    plan("migrate", "Encrypt secret files", "done", `${changed} file(s) newly encrypted`);
  }

  // ── 6. wrapped live-storage keys ────────────────────────────────────
  if (allKeysPresent && storageEncryptionRequired(configDir)) {
    plan("storage-keys", "Live-storage keys", "skipped", "all wrapped keys already exist");
  } else if (opts.dryRun) {
    plan(
      "storage-keys",
      "Live-storage keys",
      "planned",
      `mint wrapped keys for ${storageKeyNames.join(", ")}`,
    );
  } else {
    for (const keyName of storageKeyNames) {
      await ensureStorageKey(keyName, { backend, configDir });
    }
    plan("storage-keys", "Live-storage keys", "done", "wrapped keys ready; migration armed");
  }

  // ── 7. restart + verify ─────────────────────────────────────────────
  if (hasGateway) await restartGatewayStep(deps, opts, { healthy, mainDbPlain }, plan);
  if (hasCollector) await restartCollectorStep(deps, opts, plan);
  return summary;
}

type PlanStep = (id: string, title: string, status: StepResult["status"], detail: string) => void;

/**
 * The gateway encrypts its databases on boot, so its restart is both the
 * activation and the verification: the main database header says whether
 * the migration happened.
 */
async function restartGatewayStep(
  deps: SecureDeps,
  opts: SecureOptions,
  posture: { healthy: boolean; mainDbPlain: boolean | null },
  plan: PlanStep,
): Promise<void> {
  const { configDir } = deps;
  const { healthy, mainDbPlain } = posture;
  if (opts.dryRun) {
    plan(
      "restart",
      "Gateway restart",
      "planned",
      healthy
        ? "restart the gateway service, then verify the databases are encrypted"
        : "start the gateway; it encrypts the databases on boot",
    );
    return;
  }
  if (mainDbPlain === false && !healthy) {
    plan("restart", "Gateway restart", "skipped", "databases are already encrypted");
    return;
  }
  if (healthy) {
    const restarted = await deps.restartService("gateway");
    if (restarted === "restarted") {
      const ok = await waitForHealthy(deps, 90_000);
      const nowPlain = sqliteLooksPlaintext(join(configDir, "omnesis.db"));
      if (ok && nowPlain === false) {
        plan("restart", "Gateway restart", "done", "gateway is back up; databases are encrypted");
      } else if (ok) {
        plan(
          "restart",
          "Gateway restart",
          "action-required",
          "gateway is up but the database still looks plaintext — check the gateway log for the migration line",
        );
      } else {
        plan(
          "restart",
          "Gateway restart",
          "action-required",
          "gateway did not come back within 90s — a large corpus can take longer to encrypt; watch `omnesis service logs gateway -f`",
        );
      }
    } else {
      plan(
        "restart",
        "Gateway restart",
        "action-required",
        "no managed service found — restart the gateway yourself; it encrypts the databases on boot",
      );
    }
  } else {
    plan(
      "restart",
      "Gateway start",
      "action-required",
      "start the gateway (`omnesis service start gateway`, or your usual command); it encrypts the databases on boot",
    );
  }
}

/**
 * A collector re-creates any key it lacks at start and each source migrates
 * its store the next time it opens it, so the restart is the activation; a
 * host without a managed collector unit is told the exact command.
 */
async function restartCollectorStep(
  deps: SecureDeps,
  opts: SecureOptions,
  plan: PlanStep,
): Promise<void> {
  if (opts.dryRun) {
    plan(
      "collector-restart",
      "Collector restart",
      "planned",
      "restart the collector service; its sources encrypt their stores as they open them",
    );
    return;
  }
  const restarted = await deps.restartService("collector");
  if (restarted === "restarted") {
    plan(
      "collector-restart",
      "Collector restart",
      "done",
      "collector restarted; its sources encrypt their stores as they open them",
    );
  } else if (restarted === "not-installed") {
    plan(
      "collector-restart",
      "Collector restart",
      "action-required",
      "no managed collector service found — restart the collector yourself (`omnesis collector run`, or your usual command); its sources encrypt their stores as they open them",
    );
  } else {
    plan(
      "collector-restart",
      "Collector restart",
      "action-required",
      "the collector service did not restart — run `omnesis service restart collector` and check `omnesis service logs collector`",
    );
  }
}

async function waitForHealthy(deps: SecureDeps, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await deps.gatewayHealthy()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

export async function runRollback(deps: SecureDeps, opts: { yes: boolean }): Promise<void> {
  const statePath = join(deps.configDir, WIZARD_STATE_FILE);
  if (!existsSync(statePath)) {
    throw new CliError(
      "No pre-secure snapshot is recorded for this install. Use `omnesis restore <backup-dir>` " +
        "with a backup taken by `omnesis backup` instead.",
      EXIT_USER_ERROR,
    );
  }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as WizardState;
  if (!existsSync(state.backupDir)) {
    throw new CliError(
      `The recorded snapshot at ${state.backupDir} no longer exists.`,
      EXIT_FAILURE,
    );
  }
  if (await deps.gatewayHealthy()) {
    throw new CliError(
      "The gateway is running — stop it before rolling back (`omnesis service stop gateway`).",
      EXIT_USER_ERROR,
    );
  }
  assertNoLiveGateway(deps.configDir, "roll back");
  if (!opts.yes) {
    throw new CliError(
      `This would replace the current databases with the snapshot at ${state.backupDir} ` +
        `(taken ${state.startedAt}). Re-run with --yes to proceed.`,
      EXIT_USER_ERROR,
    );
  }
  await restore(state.backupDir, {
    target: deps.configDir,
    backend: deps.backend,
    codeArg: undefined,
    envelopeFileArg: undefined,
    force: true,
  });
  deps.log(
    `${c.green}Rolled back to the pre-secure snapshot.${c.reset} ${c.dim}Keyring material was kept; ` +
      `starting the gateway re-encrypts the restored databases.${c.reset}`,
  );
}

function defaultDeps(backend: SecretStoreBackend): SecureDeps {
  return {
    configDir: process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
    backend,
    async gatewayHealthy() {
      try {
        const res = await gatewayFetch("/health", { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    },
    async onlineBackup(note) {
      const { runBackup } = await import("./backup.js");
      await runBackup({ includeIndex: true, note });
    },
    async restartService(component) {
      const { createSupervisor } = await import("../service/supervisor.js");
      try {
        const supervisor = createSupervisor();
        if (!supervisor.isInstalled(component, undefined)) return "not-installed";
        await supervisor.restart(component, undefined);
        return "restarted";
      } catch {
        return "failed";
      }
    },
    now: () => new Date(),
    log: (line) => console.log(line),
  };
}

export const secureCommand = defineCommand({
  meta: {
    name: "secure",
    description: "Guided wizard: enable full at-rest encryption safely (backup + recovery first)",
  },
  args: {
    backend: {
      type: "string",
      description: `Secret-store backend (${SECRET_STORE_BACKENDS.join(", ")})`,
    },
    "dry-run": { type: "boolean", description: "Print the plan for this install; change nothing" },
    host: {
      type: "string",
      description:
        "Secure for gateway, collector, or all (default: detected from this directory's gateway database or lock and collector pairing)",
    },
    "skip-backup": {
      type: "boolean",
      description: "Skip the pre-migration backup (not recommended)",
    },
    rollback: {
      type: "boolean",
      description: "Restore the pre-secure snapshot from a previous run",
    },
    yes: { type: "boolean", description: "Confirm a destructive --rollback" },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run(ctx) {
    const backend = ((): SecretStoreBackend => {
      const raw: unknown = ctx.args.backend;
      if (raw == null || raw === false || raw === "") {
        return parseSecretStoreBackend(process.env.OMNESIS_SECRET_STORE);
      }
      if (typeof raw !== "string") throw new CliError("Invalid --backend value", EXIT_USER_ERROR);
      return parseSecretStoreBackend(raw);
    })();
    const deps = defaultDeps(backend);
    // In --json mode stdout must be a single JSON document; suppress the
    // human step narration so machine callers can parse it directly.
    if (isJSON) deps.log = () => {};

    if (ctx.args.rollback === true) {
      await runRollback(deps, { yes: ctx.args.yes === true });
      return;
    }

    const hosts = ((): StorageKeyHost[] | undefined => {
      const raw: unknown = ctx.args.host;
      if (raw == null || raw === false || raw === "") return undefined;
      if (raw === "all") return ["gateway", "collector"];
      if (raw === "gateway" || raw === "collector") return [raw];
      throw new CliError(
        `Invalid --host: ${String(raw)} (expected gateway, collector, or all)`,
        EXIT_USER_ERROR,
      );
    })();
    const summary = await runSecure(deps, {
      hosts,
      dryRun: ctx.args["dry-run"] === true,
      skipBackup: ctx.args["skip-backup"] === true,
    });

    if (isJSON) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (summary.recoveryCode) {
      console.log(`\n${c.bold}Omnesis recovery code${c.reset}\n`);
      console.log(`    ${c.green}${summary.recoveryCode}${c.reset}\n`);
      console.log(
        `${c.yellow}Write this down and keep it offline — it is shown only once.${c.reset}`,
      );
      console.log("It is the only way back into your encrypted data if the OS keyring is lost.");
    }
  },
});

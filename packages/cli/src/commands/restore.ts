// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis restore` — put a gateway backup back into a config directory.
 *
 * This is a LOCAL, offline operation: no gateway may hold the target config
 * dir while it runs, and the restore holds the dir's gateway lock for its
 * whole length so none can start. It is the consuming half of the recovery
 * spine (`omnesis keyring export-recovery` produces the escrow; the online
 * `BackupService` and the offline pre-update copy produce the backup).
 *
 * A restore replaces what a backup owns and keeps what the machine owns. The
 * line between the two is drawn once, in `@omnesis/core`'s backup layout
 * (`backupScopeEntryFor`): the stores and their companion files, the config
 * material, the TLS identity and the escrow are the backup's; other backups,
 * models, exports, logs, the keyring passphrase and the secret store's own
 * entries, the lock and a Docker install's compose file are the machine's.
 *
 * How it works:
 *   1. An encrypted backup's artifacts are AES-256-GCM-wrapped under the
 *      install root key. The restore uses the key the target's secret store
 *      already holds, or reconstitutes it from a recovery envelope + the
 *      operator's recovery code — taken from `--envelope`, or from
 *      `keyring/recovery-envelope.json` inside the backup when the backup
 *      bundles its own escrow. A supplied code always wins: it is the operator
 *      saying the backup came from elsewhere.
 *   2. Every backup-owned file the backup holds is inflated into a stage
 *      inside the target: encrypted artifacts (`*.enc`) are decrypted,
 *      plaintext files are copied, preserving the relative tree. The `.env`
 *      keeps the target's lines for the keys that say how this machine runs
 *      (`MACHINE_ENV_KEYS`). Anything else a backup holds is skipped.
 *   3. Only once the whole stage inflated is it swapped in, entry by entry
 *      (`restore-swap.ts`): each backup-owned entry of the target is moved
 *      aside, removed when the backup does not carry it — a stale index beside
 *      a restored corpus is worse than none — and the staged one put in its
 *      place; a reconstituted root key goes in with them. A failure at any
 *      step puts the target back as it was. The derived vector-graph files are
 *      always removed; the gateway rebuilds them.
 *   4. The database snapshots decrypt back to PLAINTEXT SQLite/DuckDB files,
 *      alongside the wrapped per-store keys and the `storage-encryption-required`
 *      marker; the gateway re-encrypts them in place on its next boot.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import {
  DEFAULT_CONFIG_DIR,
  ENCRYPTED_ARTIFACT_SUFFIX,
  GATEWAY_STORE_FILE,
  GatewayLockHeldError,
  PRIVATE_FILE_MODE,
  SECRET_STORE_BACKENDS,
  acquireGatewayLock,
  atomicWriteFileSync,
  backupScopeEntries,
  backupScopeEntryFor,
  createSecretStore,
  decryptArtifactFileToFile,
  ensurePrivateDirSync,
  isEncryptedArtifactFile,
  openRecoveryEnvelope,
  parseSecretStoreBackend,
  readInstallRootKey,
  restoredDotEnv,
  writeInstallRootKey,
  type RecoveryEnvelopeV1,
  type SecretStoreBackend,
} from "@omnesis/core";
import { c, CliError, EXIT_FAILURE, EXIT_USER_ERROR, isJSON } from "../utils.js";
import { detectDockerContext } from "../docker-install.js";
import { resolveRecoveryCode } from "./keyring.js";
import { DOCKER_HOST_RESTART_ENV } from "./secure-docker.js";
import { swapIntoPlace, SwapRollbackError, type RenameFn } from "./restore-swap.js";

const MANIFEST_NAME = "backup-manifest.json";
const RECOVERY_ENVELOPE_RELPATH = "keyring/recovery-envelope.json";
/** The prefix of the restore's scratch directory inside the target. */
const WORK_DIR_PREFIX = ".omnesis-restore-";

function backendFromArg(raw: unknown): SecretStoreBackend {
  if (raw == null || raw === false || raw === "") {
    return parseSecretStoreBackend(process.env.OMNESIS_SECRET_STORE);
  }
  if (typeof raw !== "string") {
    throw new CliError("Invalid --backend value", EXIT_USER_ERROR);
  }
  try {
    return parseSecretStoreBackend(raw);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT_USER_ERROR);
  }
}

/** Backup metadata files that describe the backup itself, not config state. */
function isManifestFile(rel: string): boolean {
  return rel === MANIFEST_NAME || rel.startsWith("backup-manifest.full.json");
}

function stripEncSuffix(path: string): string {
  return path.endsWith(ENCRYPTED_ARTIFACT_SUFFIX)
    ? path.slice(0, -ENCRYPTED_ARTIFACT_SUFFIX.length)
    : path;
}

/** Relative paths of every regular file under `root`, depth-first. */
function listFilesRelative(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRelative(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

interface RestoreSummary {
  target: string;
  restored: number;
  decrypted: number;
  copied: number;
  /** Backup-owned entries of the target the backup did not carry, now removed. */
  removed: string[];
  /** Files in the backup that are not a backup's to restore, left out. */
  skipped: string[];
  rootKeyReseeded: boolean;
  encrypted: boolean;
}

export interface RestoreOptions {
  target: string;
  backend: SecretStoreBackend;
  codeArg: unknown;
  envelopeFileArg: unknown;
  force: boolean;
  /** Test seam: the rename each swap step makes. */
  rename?: RenameFn;
}

/** True when the backup manifest declares its artifacts encrypted. */
function backupIsEncrypted(backupDir: string): boolean {
  const manifestPath = join(backupDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new CliError(
      `Not an Omnesis backup directory (no ${MANIFEST_NAME}): ${backupDir}`,
      EXIT_USER_ERROR,
    );
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { encryption?: unknown };
    return manifest.encryption != null;
  } catch {
    throw new CliError(`Could not parse ${MANIFEST_NAME} in ${backupDir}.`, EXIT_USER_ERROR);
  }
}

/**
 * The install root key an encrypted backup decrypts under: the target's own,
 * or one reconstituted from a recovery envelope + the operator's recovery code.
 */
async function resolveRootKey(
  backupDir: string,
  target: string,
  backend: SecretStoreBackend,
  codeArg: unknown,
  envelopeFileArg: unknown,
  force: boolean,
): Promise<{ value: string; reseeded: boolean }> {
  // A recovery code (or an explicit envelope) is the operator saying
  // "reconstitute from recovery". Honour it even when the target already holds a
  // key -- which it always does on the documented path, where the new machine
  // ran the installer before restoring. Preferring the local key there decrypts
  // the backup with a key that cannot read it, and the recovery code the
  // operator was told to write down is silently discarded.
  const wantsRecovery =
    (typeof codeArg === "string" && codeArg !== "") ||
    (typeof envelopeFileArg === "string" && envelopeFileArg !== "");

  if (!wantsRecovery) {
    const existing = await readInstallRootKey({ backend, configDir: target });
    if (existing) return { value: existing, reseeded: false };
  }

  const envelopePath =
    typeof envelopeFileArg === "string" && envelopeFileArg
      ? envelopeFileArg
      : join(backupDir, RECOVERY_ENVELOPE_RELPATH);
  if (!existsSync(envelopePath)) {
    throw new CliError(
      "This backup is encrypted, but the install root key is not in the keyring and no recovery " +
        `envelope was found at ${envelopePath}. Provide one with --envelope, or seed the key first ` +
        "with `omnesis keyring import-recovery`.",
      EXIT_USER_ERROR,
    );
  }

  let envelope: RecoveryEnvelopeV1;
  try {
    envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as RecoveryEnvelopeV1;
  } catch {
    throw new CliError(
      `Could not parse the recovery envelope at ${envelopePath}.`,
      EXIT_USER_ERROR,
    );
  }

  const code = resolveRecoveryCode(codeArg);
  let value: string;
  try {
    value = openRecoveryEnvelope(envelope, code);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT_USER_ERROR);
  }
  if (!force) {
    const existing = await readInstallRootKey({ backend, configDir: target }).catch(() => null);
    if (existing && existing !== value) {
      throw new CliError(
        `${target} already holds a different install root key. Pass --force to replace it with the ` +
          "one this backup was sealed under.",
        EXIT_USER_ERROR,
      );
    }
  }
  return { value, reseeded: true };
}

/** Inflate one backup file into the stage: decrypt an artifact, copy anything else. */
async function inflateFile(
  src: string,
  dest: string,
  rel: string,
  rootKey: string | null,
): Promise<"decrypted" | "copied"> {
  ensurePrivateDirSync(dirname(dest));
  if (!isEncryptedArtifactFile(src)) {
    copyFileSync(src, dest);
    chmodSync(dest, PRIVATE_FILE_MODE);
    return "copied";
  }
  if (!rootKey) {
    throw new CliError(
      `${rel} is encrypted, but the backup manifest does not say so; the backup is damaged.`,
      EXIT_USER_ERROR,
    );
  }
  try {
    await decryptArtifactFileToFile(src, dest, { rootKey, force: true });
  } catch (err) {
    // An AES-GCM authentication failure means the key is wrong, not that
    // the file is damaged. Nothing in a backup records which root key
    // encrypted it, so this is the only signal available -- say what it
    // means rather than surfacing `Unsupported state or unable to
    // authenticate data` from a stream pipeline.
    const message = err instanceof Error ? err.message : String(err);
    if (/unable to authenticate data|unsupported state/i.test(message)) {
      throw new CliError(
        `This backup was not encrypted with this machine's root key (${rel} could not be ` +
          "decrypted). Pass --code <recovery code> to reconstitute the original key from the " +
          "backup's recovery envelope.",
        EXIT_USER_ERROR,
      );
    }
    throw err;
  }
  return "decrypted";
}

function readTextIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export async function restore(backupDir: string, opts: RestoreOptions): Promise<RestoreSummary> {
  if (!existsSync(backupDir) || !statSync(backupDir).isDirectory()) {
    throw new CliError(`Backup directory not found: ${backupDir}`, EXIT_USER_ERROR);
  }
  const encrypted = backupIsEncrypted(backupDir);
  const source = resolve(backupDir);
  const target = resolve(opts.target);
  if (source === target) {
    throw new CliError(
      `${source} is the backup itself, not a config dir to restore into.`,
      EXIT_USER_ERROR,
    );
  }
  if (existsSync(target) && !statSync(target).isDirectory()) {
    throw new CliError(`${target} is not a directory.`, EXIT_USER_ERROR);
  }

  const createdTarget = !existsSync(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  // The gateway lock, held for the whole restore: a gateway that is running,
  // booting or draining holds it, and one that starts during the restore
  // waits for it before it opens a store.
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock(target, { waitMs: 0 });
  } catch (err) {
    if (createdTarget) rmSync(target, { recursive: true, force: true });
    if (err instanceof GatewayLockHeldError) {
      throw new CliError(
        `Gateway PID ${err.holder.pid} still owns ${target}; wait for it to exit (or \`omnesis service stop gateway\`) before restoring into it.`,
        EXIT_USER_ERROR,
      );
    }
    throw err;
  }

  let succeeded = false;
  try {
    // Refuse to clobber an existing corpus unless the operator forces it.
    if (existsSync(join(target, GATEWAY_STORE_FILE)) && !opts.force) {
      throw new CliError(
        `The target config dir already contains a corpus (${join(target, GATEWAY_STORE_FILE)}). ` +
          "Stop the gateway and pass --force to replace it, or restore into a fresh --target.",
        EXIT_USER_ERROR,
      );
    }
    const rootKey = encrypted
      ? await resolveRootKey(
          source,
          target,
          opts.backend,
          opts.codeArg,
          opts.envelopeFileArg,
          opts.force,
        )
      : null;
    // What the backup owns in the target now, read before the work dir exists.
    const owned = backupScopeEntries(target).map((entry) => entry.name);

    // Inflate inside the target itself — the same filesystem, so every swap
    // step is a rename — and swap in only once everything inflated.
    const workDir = mkdtempSync(join(target, WORK_DIR_PREFIX));
    chmodSync(workDir, 0o700);
    try {
      const stage = join(workDir, "stage");
      mkdirSync(stage, { mode: 0o700 });
      let decrypted = 0;
      let copied = 0;
      const skipped: string[] = [];
      const units = new Set<string>();
      for (const rel of listFilesRelative(source)) {
        if (isManifestFile(rel)) continue;
        const name = stripEncSuffix(rel);
        const scope = backupScopeEntryFor(name);
        if (!scope || scope.kind === "derived") {
          skipped.push(name);
          continue;
        }
        const how = await inflateFile(
          join(source, rel),
          join(stage, name),
          rel,
          rootKey?.value ?? null,
        );
        if (how === "decrypted") decrypted += 1;
        else copied += 1;
        units.add(scope.name);
      }

      // The `.env` keeps the lines that say how this machine runs the install.
      const stagedEnv = join(stage, ".env");
      const env = restoredDotEnv(
        readTextIfPresent(stagedEnv),
        readTextIfPresent(join(target, ".env")),
      );
      if (env === null) {
        rmSync(stagedEnv, { force: true });
        units.delete(".env");
      } else {
        atomicWriteFileSync(stagedEnv, env, { mode: PRIVATE_FILE_MODE });
        units.add(".env");
      }

      const place = [...units].map((rel) => ({ rel, from: join(stage, rel) }));
      let commit: (() => Promise<void>) | undefined;
      if (rootKey?.reseeded) {
        // A secret store that keeps its entries in the config dir gets the
        // reconstituted key as part of the swap; one that keeps them elsewhere
        // (an OS keyring) is written as the swap's last step, so a restore that
        // fails earlier leaves the machine's key alone.
        const keyStage = join(workDir, "key");
        mkdirSync(keyStage, { mode: 0o700 });
        const store = createSecretStore({ backend: opts.backend, configDir: keyStage });
        if (store.backend === "file" || store.backend === "passphrase") {
          try {
            await writeInstallRootKey(rootKey.value, {
              backend: opts.backend,
              configDir: keyStage,
              overwrite: true,
            });
          } catch (err) {
            throw new CliError(err instanceof Error ? err.message : String(err), EXIT_FAILURE);
          }
          for (const rel of listFilesRelative(keyStage))
            place.push({ rel, from: join(keyStage, rel) });
        } else {
          commit = async () => {
            try {
              await writeInstallRootKey(rootKey.value, {
                backend: opts.backend,
                configDir: target,
                overwrite: true,
              });
            } catch (err) {
              throw new CliError(err instanceof Error ? err.message : String(err), EXIT_FAILURE);
            }
          };
        }
      }

      const removed = owned.filter((name) => !units.has(name));
      await swapIntoPlace({
        target,
        workDir,
        place,
        remove: removed,
        ...(commit ? { commit } : {}),
        ...(opts.rename ? { rename: opts.rename } : {}),
      });
      succeeded = true;
      return {
        target,
        restored: decrypted + copied,
        decrypted,
        copied,
        removed,
        skipped,
        rootKeyReseeded: rootKey?.reseeded ?? false,
        encrypted,
      };
    } catch (err) {
      // A swap that could not put everything back keeps its work dir: the
      // superseded entries are in it, and the error says where.
      if (!(err instanceof SwapRollbackError)) rmSync(workDir, { recursive: true, force: true });
      throw err;
    }
  } finally {
    lock.release();
    if (!succeeded && createdTarget) rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Inside a Docker install the restore needs the host: the containers that
 * hold the config dir have to stop first, which no container can do to
 * itself. The host launcher does that and says so; anything else is told what
 * to run instead of being left to fail on the gateway's lock.
 */
export function refuseInsideDockerWithoutLauncher(target: string, env: NodeJS.ProcessEnv): void {
  const docker = detectDockerContext(target);
  if (!docker || env[DOCKER_HOST_RESTART_ENV] === "1") return;
  throw new CliError(
    "This is a Docker install, so `omnesis restore` runs from the host: its launcher stops the " +
      "containers, restores in a one-off container and starts them again. Run it there as " +
      "`omnesis restore <backup-dir> --force`. A launcher that sent the command here instead " +
      "predates that: refresh it with `omnesis update` (or re-run the installer), then run the " +
      "restore again.",
    EXIT_USER_ERROR,
  );
}

export const restoreCommand = defineCommand({
  meta: {
    name: "restore",
    description:
      "Restore a gateway backup into a config directory (offline; stop the gateway first, or let a Docker install's launcher do it)",
  },
  args: {
    backup: {
      type: "positional",
      description: "Path to a backup directory (contains backup-manifest.json)",
      required: true,
    },
    target: {
      type: "string",
      description: "Config directory to restore into (default: $OMNESIS_CONFIG_DIR)",
    },
    code: {
      type: "string",
      description: "Recovery code, if the root key must be reconstituted (else read from stdin)",
    },
    envelope: {
      type: "string",
      description: "Recovery envelope path (default: <backup>/keyring/recovery-envelope.json)",
    },
    force: {
      type: "boolean",
      description:
        "Replace an existing corpus in the target (what the backup owns is replaced; the machine's own files stay)",
    },
    backend: {
      type: "string",
      description: `Secret-store backend (${SECRET_STORE_BACKENDS.join(", ")})`,
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run(ctx) {
    const backupDir = String(ctx.args.backup ?? "");
    if (!backupDir) throw new CliError("Missing backup directory", EXIT_USER_ERROR);
    const target =
      typeof ctx.args.target === "string" && ctx.args.target
        ? ctx.args.target
        : (process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR);
    refuseInsideDockerWithoutLauncher(resolve(target), process.env);
    const backend = backendFromArg(ctx.args.backend);

    const summary = await restore(backupDir, {
      target,
      backend,
      codeArg: ctx.args.code,
      envelopeFileArg: ctx.args.envelope,
      force: ctx.args.force === true,
    });

    if (isJSON) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`\n${c.bold}Omnesis restore${c.reset}\n`);
    console.log(`  target:    ${summary.target}`);
    console.log(
      `  restored:  ${summary.restored} files (${summary.decrypted} decrypted, ${summary.copied} copied)`,
    );
    if (summary.removed.length > 0) {
      console.log(
        `  removed:   ${summary.removed.join(", ")} ${c.dim}(not in the backup; rebuilt or re-added as needed)${c.reset}`,
      );
    }
    if (summary.skipped.length > 0) {
      console.log(
        `  ${c.yellow}skipped:${c.reset}   ${summary.skipped.join(", ")} ${c.dim}(not a backup's to restore)${c.reset}`,
      );
    }
    if (summary.rootKeyReseeded) {
      console.log(
        `  ${c.green}reconstituted the install root key from the recovery envelope${c.reset}`,
      );
    }
    console.log(`  ${c.dim}Everything else in ${summary.target} was kept as it was.${c.reset}`);
    console.log("");
    if (process.env[DOCKER_HOST_RESTART_ENV] !== "1") {
      console.log(`${c.yellow}Next:${c.reset} start the gateway (and collector) again`);
      console.log(`  ${c.dim}omnesis service start${c.reset}`);
      console.log(
        `  ${c.dim}or, without installed services: OMNESIS_CONFIG_DIR=${summary.target} omnesis gateway serve${c.reset}`,
      );
    }
    if (summary.encrypted) {
      console.log(
        `${c.dim}The databases are restored as plaintext snapshots; the gateway re-encrypts them in place on first boot.${c.reset}`,
      );
    }
  },
});

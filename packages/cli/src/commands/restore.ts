// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis restore` — reconstitute a config directory from a gateway backup.
 *
 * This is a LOCAL, offline operation: the gateway must NOT be running against
 * the target config dir while its database files are being replaced. It is the
 * consuming half of the recovery spine (`omnesis keyring export-recovery`
 * produces the escrow; the online `BackupService` produces the backup).
 *
 * How it works:
 *   1. Encrypted backup artifacts are AES-256-GCM-wrapped under the install
 *      root key. To decrypt them the root key must be present in the target's
 *      secret store. When it isn't, restore reconstitutes it from a recovery
 *      envelope + the operator's recovery code — taken from `--envelope`, or
 *      from `keyring/recovery-envelope.json` inside the backup when the backup
 *      bundles its own escrow (self-contained backups). If neither is present,
 *      seed the key first with `omnesis keyring import-recovery`.
 *   2. Every backup file is then inflated into a staging dir: encrypted
 *      artifacts (`*.enc`) are decrypted, plaintext files (markers, the recovery
 *      envelope, an unencrypted backup's files) are copied verbatim, preserving
 *      the relative tree (`keyring/storage-keys/*`, `tls/*`, credentials, …).
 *      Only after the whole tree inflates successfully is the staging dir moved
 *      into place, so a mid-restore failure never leaves a half-written config.
 *   3. The database snapshots decrypt back to PLAINTEXT SQLite/DuckDB files.
 *      They are placed alongside the wrapped per-store keys + the root key + the
 *      `storage-encryption-required` marker; the gateway re-encrypts them in
 *      place on its next boot. Restore never hand-encrypts a database.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import {
  liveGatewayHolder,
  DEFAULT_CONFIG_DIR,
  ENCRYPTED_ARTIFACT_SUFFIX,
  GATEWAY_STORE_FILE,
  KEYRING_PASSPHRASE_FILE_NAME,
  PRIVATE_FILE_MODE,
  SECRET_STORE_BACKENDS,
  decryptArtifactFileToFile,
  ensurePrivateDirSync,
  isEncryptedArtifactFile,
  openRecoveryEnvelope,
  parseSecretStoreBackend,
  readInstallRootKey,
  writeInstallRootKey,
  type RecoveryEnvelopeV1,
  type SecretStoreBackend,
} from "@omnesis/core";
import { c, CliError, EXIT_FAILURE, EXIT_USER_ERROR, isJSON } from "../utils.js";
import { resolveRecoveryCode } from "./keyring.js";

const MANIFEST_NAME = "backup-manifest.json";
const RECOVERY_ENVELOPE_RELPATH = "keyring/recovery-envelope.json";

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
  rootKeyReseeded: boolean;
  encrypted: boolean;
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
 * Make the install root key available in `staging` for artifact decryption.
 * Reuses a key already present in the target's secret store (copied into the
 * staging dir so a `file` backend can resolve it; OS keyrings resolve it
 * globally, making the copy an idempotent no-op), else reconstitutes it from a
 * recovery envelope + the operator's recovery code. Returns whether the key was
 * reconstituted from recovery.
 */
async function seedRootKey(
  backupDir: string,
  target: string,
  staging: string,
  backend: SecretStoreBackend,
  codeArg: unknown,
  envelopeFileArg: unknown,
  force: boolean,
): Promise<boolean> {
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
    if (existing) {
      await writeInstallRootKey(existing, { backend, configDir: staging, overwrite: true });
      return false;
    }
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
  let rootKey: string;
  try {
    rootKey = openRecoveryEnvelope(envelope, code);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT_USER_ERROR);
  }
  try {
    await writeInstallRootKey(rootKey, { backend, configDir: staging, overwrite: force });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT_FAILURE);
  }
  return true;
}

/** Move a fully-inflated staging dir into place, preserving the old one until the swap succeeds. */
function commitStaging(staging: string, target: string): void {
  if (!existsSync(target)) {
    renameSync(staging, target);
    return;
  }
  const superseded = `${target}.superseded-${process.pid}`;
  renameSync(target, superseded);
  try {
    renameSync(staging, target);
  } catch (err) {
    renameSync(superseded, target);
    throw err;
  }
  rmSync(superseded, { recursive: true, force: true });
}

export async function restore(
  backupDir: string,
  opts: {
    target: string;
    backend: SecretStoreBackend;
    codeArg: unknown;
    envelopeFileArg: unknown;
    force: boolean;
  },
): Promise<RestoreSummary> {
  if (!existsSync(backupDir) || !statSync(backupDir).isDirectory()) {
    throw new CliError(`Backup directory not found: ${backupDir}`, EXIT_USER_ERROR);
  }
  const encrypted = backupIsEncrypted(backupDir);

  const target = resolve(opts.target);
  // A gateway that is booting or draining holds the stores while `/health`
  // does not answer; the config dir's lock is the authority on that.
  const holder = liveGatewayHolder(target);
  if (holder) {
    throw new CliError(
      `Gateway PID ${holder.pid} still owns ${target}; wait for it to exit (or \`omnesis service stop gateway\`) before restoring into it.`,
      EXIT_USER_ERROR,
    );
  }
  // Refuse to clobber an existing corpus unless the operator forces it — a
  // restore over a live config dir would corrupt it (and the gateway must be
  // stopped anyway).
  if (existsSync(join(target, GATEWAY_STORE_FILE)) && !opts.force) {
    throw new CliError(
      `The target config dir already contains a corpus (${join(target, GATEWAY_STORE_FILE)}). ` +
        "Stop the gateway and pass --force to overwrite it, or restore into a fresh --target.",
      EXIT_USER_ERROR,
    );
  }

  // Inflate into a same-filesystem staging dir and swap it in only on success,
  // so a mid-restore failure never poisons the target (and a --force restore is
  // all-or-nothing rather than a mix of two backup epochs).
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".omnesis-restore-"));
  chmodSync(staging, 0o700);

  try {
    const rootKeyReseeded = encrypted
      ? await seedRootKey(
          backupDir,
          target,
          staging,
          opts.backend,
          opts.codeArg,
          opts.envelopeFileArg,
          opts.force,
        )
      : false;

    let decrypted = 0;
    let copied = 0;
    for (const rel of listFilesRelative(backupDir)) {
      if (isManifestFile(rel)) continue;
      const src = join(backupDir, rel);
      const dest = join(staging, stripEncSuffix(rel));
      ensurePrivateDirSync(dirname(dest));

      if (isEncryptedArtifactFile(src)) {
        try {
          await decryptArtifactFileToFile(src, dest, {
            backend: opts.backend,
            configDir: staging,
            force: true,
          });
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
        decrypted += 1;
      } else {
        copyFileSync(src, dest);
        chmodSync(dest, PRIVATE_FILE_MODE);
        copied += 1;
      }
    }

    // The backup deliberately never carries the keyring passphrase — it is what
    // unseals the root key. But the whole config dir is about to be replaced,
    // and on a headless install the service unit loads that file through
    // `LoadCredential=`, so dropping it leaves systemd unable to start the
    // gateway ever again (243/CREDENTIALS): a restore that reports success and
    // leaves the machine unbootable. The file belongs to the machine, not to
    // the backup, so it is carried across the swap.
    const localCredential = join(target, KEYRING_PASSPHRASE_FILE_NAME);
    const stagedCredential = join(staging, KEYRING_PASSPHRASE_FILE_NAME);
    if (existsSync(localCredential) && !existsSync(stagedCredential)) {
      copyFileSync(localCredential, stagedCredential);
      chmodSync(stagedCredential, PRIVATE_FILE_MODE);
    }

    commitStaging(staging, target);

    return {
      target,
      restored: decrypted + copied,
      decrypted,
      copied,
      rootKeyReseeded,
      encrypted,
    };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

export const restoreCommand = defineCommand({
  meta: {
    name: "restore",
    description:
      "Restore a config directory from a gateway backup (offline; stop the gateway first)",
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
      description: "Replace an existing corpus in the target (the whole config dir is swapped)",
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
    if (summary.rootKeyReseeded) {
      console.log(
        `  ${c.green}reconstituted the install root key from the recovery envelope${c.reset}`,
      );
    }
    console.log("");
    console.log(`${c.yellow}Next:${c.reset} start the gateway against this config dir`);
    console.log(`  ${c.dim}OMNESIS_CONFIG_DIR=${summary.target} omnesis gateway serve${c.reset}`);
    if (summary.encrypted) {
      console.log(
        `${c.dim}The databases are restored as plaintext snapshots; the gateway re-encrypts them in place on first boot.${c.reset}`,
      );
    }
  },
});

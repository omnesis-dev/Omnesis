// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The on-disk shape of a gateway backup, shared by the two ways one is taken.
 *
 * A running gateway takes an online backup (the gateway's `BackupService`):
 * its SQLite stores are vacuumed and its DuckDB store is copied through the
 * live pool, because the open stores cannot be copied as files. A gateway that
 * is not running cannot answer that request, and its stores are closed, so
 * `writeOfflineBackup` copies the files themselves.
 *
 * Both write `<configDir>/backups/<timestamp>/` with the same manifest and the
 * same config material, so `omnesis restore`, `omnesis backup --list` and the
 * pre-update retention read either without knowing which one produced it.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.js";
import {
  GATEWAY_ANALYTICS_STORE_FILE,
  GATEWAY_INDEX_STORE_FILE,
  GATEWAY_STORE_FILE,
  OPERATOR_INSTRUCTIONS_FILENAME,
  WATCH_JOURNAL_FILENAME,
} from "./utils.js";

export const BACKUP_MANIFEST_NAME = "backup-manifest.json";
export const BACKUP_FULL_MANIFEST_NAME = "backup-manifest.full.json";

/**
 * The root-key recovery envelope (written by `omnesis keyring export-recovery`).
 * It is already sealed under the operator's recovery code, so a backup carries
 * it verbatim: that is what lets a restore on a fresh machine reconstitute the
 * root key the rest of an encrypted backup depends on.
 */
export const BACKUP_RECOVERY_ENVELOPE_NAME = "keyring/recovery-envelope.json";

/**
 * The keyring passphrase a headless install writes into the config dir and
 * wires into its service unit with `LoadCredential=`. Deliberately NOT in
 * `CONFIG_COPY_NAMES`: it is what unseals the root key, so a backup carrying it
 * would defeat encryption at rest. It belongs to the machine, which is why a
 * restore has to preserve the target's own rather than expect one in the backup.
 */
export const KEYRING_PASSPHRASE_FILE_NAME = "keyring.pass";

/** Automatic pre-update snapshots kept when no configuration overrides it. */
export const DEFAULT_PRE_UPDATE_BACKUP_COUNT = 2;

export type BackupPurpose = "operator" | "pre-update";

export const backupManifestSchema = z.object({
  /** Product version that produced the backup. */
  version: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  files: z.array(
    z.object({ name: z.string(), bytes: z.number(), encrypted: z.boolean().optional() }),
  ),
  encryption: z
    .object({
      scheme: z.literal("omnesis.encrypted-artifact.v1"),
      key: z.literal("install-root-key-v1"),
    })
    .optional(),
  encryptedManifest: z.string().optional(),
  includeIndex: z.boolean(),
  /** Optional so backups written before purpose tracking remain listable. */
  purpose: z.enum(["operator", "pre-update"]).optional(),
  note: z.string().optional(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export interface ListedBackup extends BackupManifest {
  /** Absolute path of the backup directory. */
  path: string;
}

/** The two things retention and listing report, without choosing a logger. */
export interface BackupLog {
  info(message: string): void;
  warn(message: string): void;
}

// ── What a backup owns ──────────────────────────────────────────────────
//
// A config directory holds two kinds of thing. Some of it is the corpus and
// the settings that go with it: the stores, the config material below, the
// TLS identity and the escrow. That is what a backup carries, and what a
// restore replaces — including removing an entry of that kind the backup does
// not carry, so nothing from the epoch being replaced sits beside the restored
// one. The rest belongs to the machine: other backups, downloaded models,
// exports and logs, the keyring passphrase and the secret store's own entries,
// the lock, and a Docker install's compose file and install marker. A restore
// carries all of that across untouched. This section is the one definition of
// the line between them; `writeOfflineBackup`, the gateway's `BackupService`
// and `omnesis restore` all read it.

/** The stores a backup holds, by the name each has in a config dir and in a backup. */
export const BACKUP_STORE_NAMES = [
  GATEWAY_STORE_FILE,
  GATEWAY_INDEX_STORE_FILE,
  WATCH_JOURNAL_FILENAME,
  GATEWAY_ANALYTICS_STORE_FILE,
] as const;

/**
 * The files a closed store may still keep committed data in: SQLite's
 * write-ahead log, its shared-memory index and rollback journal, and DuckDB's
 * write-ahead log. A copy of the main file without them can lose the last
 * transactions or not open at all, so each one present travels with its store.
 */
export const STORE_COMPANION_SUFFIXES = ["-wal", "-shm", "-journal", ".wal"] as const;

/**
 * Every file the vector graph leaves in a config dir: each index generation's
 * usearch file, its encrypted persistence, and temp or quarantined copies of
 * either. Derived from the index store, so a backup never carries one and a
 * restore removes them all: the gateway rebuilds the graph from the index it
 * restored, or from nothing when the backup was taken without the index.
 */
export const DERIVED_INDEX_FILE_PATTERN = /^index(?:-\d+)?\.usearch(?:\..+)?$/;

/**
 * Config material copied verbatim when present: a file, or a directory taken
 * whole. Unlike the privacy policy — a mirror of a row the database restore
 * brings back — the operator's standing instructions to the agent are the only
 * copy, so a restore that skipped them would silently un-tell the agent
 * everything its owner had told it.
 */
const CONFIG_COPY_NAMES = [
  "omnesis.json",
  OPERATOR_INSTRUCTIONS_FILENAME,
  ".env",
  "token",
  "collector-token",
  "keyring/secret-files-required",
  "keyring/storage-encryption-required",
  "keyring/storage-keys",
  BACKUP_RECOVERY_ENVELOPE_NAME,
];

/**
 * Directories taken whole, after the per-account credentials. `sweeps` is
 * user-authored sweep prose that exists nowhere else: a restore that skipped
 * it would silently revert every sweep the operator wrote or forked.
 */
const CONFIG_COPY_TREES = ["tls", "config-secrets", "sweeps"];

/**
 * Per-provider OAuth token directories stay out because a token is
 * re-obtainable: re-authenticating mints a new one. A pasted credential is
 * not — an api key a platform shows once at creation cannot be recovered from
 * a restore that skipped it — so those are carried, matched by shape
 * (`<provider>-credentials.json`, `<provider>/<account>/credentials.json`),
 * never by provider name.
 */
const TOP_LEVEL_CREDENTIAL_FILE = /^[^/]+-credentials\.json$/;
const ACCOUNT_CREDENTIAL_FILE = /^[^/]+\/[^/]+\/credentials\.json$/;

/**
 * The `.env` keys that say how this machine runs the install, not what the
 * corpus is: the image a Docker install runs, the secret-store backend and how
 * it reaches its passphrase, and the port the host's own service arrangement
 * listens on. A restored `.env` keeps the target's lines for these and drops
 * the backup's, so restoring a backup from another release, or from a native
 * install onto a Docker one, cannot point the machine at an image or a keyring
 * it does not have.
 */
export const MACHINE_ENV_KEYS = [
  "OMNESIS_IMAGE_TAG",
  "OMNESIS_SECRET_STORE",
  "OMNESIS_KEYRING_PASSPHRASE",
  "OMNESIS_KEYRING_PASSPHRASE_FILE",
  "OMNESIS_GATEWAY_PORT",
] as const;

/** How an entry of a config dir relates to a backup. */
export type BackupScopeKind =
  /** A store or a store's companion file: carried, replaced by a restore. */
  | "store"
  /** Config material: carried, replaced by a restore. */
  | "config"
  /** Rebuilt from a store: never carried, always removed by a restore. */
  | "derived";

export interface BackupScopeEntry {
  /** Path relative to the config dir: a file, or a directory taken whole. */
  name: string;
  kind: BackupScopeKind;
}

const STORE_FILE_NAMES = new Set<string>(
  BACKUP_STORE_NAMES.flatMap((store) => [
    store,
    ...STORE_COMPANION_SUFFIXES.map((suffix) => `${store}${suffix}`),
  ]),
);

/**
 * The backup-owned entry `rel` (a path relative to a config dir or a backup,
 * `/`-separated) is or lies inside, or null when it belongs to the machine.
 */
export function backupScopeEntryFor(rel: string): BackupScopeEntry | null {
  if (STORE_FILE_NAMES.has(rel)) return { name: rel, kind: "store" };
  if (DERIVED_INDEX_FILE_PATTERN.test(rel)) return { name: rel, kind: "derived" };
  for (const name of [...CONFIG_COPY_NAMES, ...CONFIG_COPY_TREES]) {
    if (rel === name || rel.startsWith(`${name}/`)) return { name, kind: "config" };
  }
  if (TOP_LEVEL_CREDENTIAL_FILE.test(rel) || ACCOUNT_CREDENTIAL_FILE.test(rel)) {
    return { name: rel, kind: "config" };
  }
  return null;
}

/**
 * Every backup-owned entry that exists in `dir` right now, of every kind.
 * Store paths are the config dir's own; a store an environment override puts
 * elsewhere is not in it.
 */
export function backupScopeEntries(dir: string): BackupScopeEntry[] {
  const entries: BackupScopeEntry[] = [];
  for (const name of STORE_FILE_NAMES) {
    if (existsSync(join(dir, name))) entries.push({ name, kind: "store" });
  }
  try {
    for (const name of readdirSync(dir)) {
      if (DERIVED_INDEX_FILE_PATTERN.test(name)) entries.push({ name, kind: "derived" });
    }
  } catch {
    // A missing or unreadable dir holds nothing derived.
  }
  for (const name of backupConfigCopyNames(dir)) entries.push({ name, kind: "config" });
  return entries;
}

/**
 * The config material a backup mirrors, as paths relative to `configDir` that
 * exist right now. Anything {@link backupScopeEntryFor} does not name — among
 * them `models/` (re-downloadable), `backups/` (no recursion) and the derived
 * index files — stays out.
 */
export function backupConfigCopyNames(configDir: string): string[] {
  const names: string[] = [];
  const add = (name: string): void => {
    if (existsSync(join(configDir, name))) names.push(name);
  };
  for (const name of CONFIG_COPY_NAMES) add(name);
  try {
    for (const entry of readdirSync(configDir, { withFileTypes: true })) {
      if (entry.isFile() && TOP_LEVEL_CREDENTIAL_FILE.test(entry.name)) add(entry.name);
      if (!entry.isDirectory()) continue;
      for (const account of readdirSync(join(configDir, entry.name), { withFileTypes: true })) {
        if (!account.isDirectory()) continue;
        add(`${entry.name}/${account.name}/credentials.json`);
      }
    }
  } catch {
    // An unreadable config dir has nothing extra to copy.
  }
  for (const name of CONFIG_COPY_TREES) add(name);
  return names;
}

/**
 * The `.env` a restore leaves: the backup's lines, except that every
 * {@link MACHINE_ENV_KEYS} line comes from the target's own `.env` instead.
 * Null when neither side leaves anything to write.
 */
export function restoredDotEnv(
  fromBackup: string | null,
  fromTarget: string | null,
): string | null {
  const machineKey = (line: string): boolean => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    return key !== undefined && (MACHINE_ENV_KEYS as readonly string[]).includes(key);
  };
  const lines = (text: string | null): string[] =>
    text === null ? [] : text.split(/\r?\n/).filter((line, i, all) => i < all.length - 1 || line);
  const kept = lines(fromBackup).filter((line) => !machineKey(line));
  const machine = lines(fromTarget).filter(machineKey);
  const merged = [...kept, ...machine];
  return merged.length === 0 ? null : `${merged.join("\n")}\n`;
}

/** Timestamped directory for a new backup; colon-free, suffixed on collision. */
export function createBackupDir(backupsDir: string, startedAt: string): string {
  const dirName = startedAt.slice(0, 19).replace(/:/g, "-");
  let path = join(backupsDir, dirName);
  for (let n = 2; existsSync(path); n++) {
    path = join(backupsDir, `${dirName}-${n}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Completed backups (directories with a parseable manifest), newest first. */
export function listBackups(backupsDir: string, log?: BackupLog): ListedBackup[] {
  if (!existsSync(backupsDir)) return [];
  const out: ListedBackup[] = [];
  for (const entry of readdirSync(backupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(backupsDir, entry.name);
    const manifestPath = join(dir, BACKUP_MANIFEST_NAME);
    if (!existsSync(manifestPath)) continue;
    try {
      const parsed = backupManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
      if (!parsed.success) {
        log?.warn(`Skipping backup with invalid manifest: ${manifestPath}`);
        continue;
      }
      out.push({ ...parsed.data, path: dir });
    } catch (err) {
      log?.warn(
        `Skipping unreadable backup manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.path.localeCompare(a.path));
  return out;
}

/**
 * Keep the newest `keepCount` pre-update backups, counting `currentPath`.
 *
 * Retention is deliberately fail-closed: only manifests explicitly marked as
 * pre-update are eligible. The completed backup is fenced independently of
 * timestamps, so clock rollback cannot make the run that earned pruning look
 * older than a previous snapshot. Zero disables pruning.
 */
export function prunePreUpdateBackups(
  backupsDir: string,
  keepCount: number,
  currentPath: string,
  log: BackupLog,
): void {
  try {
    if (keepCount === 0) return;
    if (!Number.isSafeInteger(keepCount) || keepCount < 0) {
      log.warn(`Skipping pre-update backup pruning: invalid retention count ${keepCount}`);
      return;
    }
    const older = listBackups(backupsDir, log).filter((backup) => {
      if (backup.purpose !== "pre-update" || backup.path === currentPath) return false;
      if (isCanonicalBackupTimestamp(backup.startedAt)) return true;
      log.warn(`Skipping pre-update backup with invalid start time during pruning: ${backup.path}`);
      return false;
    });
    for (const backup of older.slice(Math.max(0, keepCount - 1))) {
      try {
        rmSync(backup.path, { recursive: true, force: true });
        log.info(`Pruned pre-update backup at ${backup.path}`);
      } catch (err) {
        log.warn(
          `Could not prune pre-update backup ${backup.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    log.warn(
      `Could not inspect pre-update backups for pruning: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Only timestamps emitted by `Date#toISOString` may drive destructive ordering. */
function isCanonicalBackupTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** One gateway store: its name inside a backup and where it lives now. */
export interface GatewayStoreFile {
  name: string;
  path: string;
}

/**
 * The stores a gateway using `configDir` opens, at the paths it opens them —
 * the same environment overrides the gateway reads. The index is left out when
 * `includeIndex` is false: it rebuilds from the document store.
 */
export function gatewayStoreFiles(
  configDir: string,
  opts: { includeIndex: boolean; env?: NodeJS.ProcessEnv },
): GatewayStoreFile[] {
  const env = opts.env ?? process.env;
  return [
    { name: GATEWAY_STORE_FILE, path: env.OMNESIS_DB_PATH ?? join(configDir, GATEWAY_STORE_FILE) },
    ...(opts.includeIndex
      ? [
          {
            name: GATEWAY_INDEX_STORE_FILE,
            path: env.OMNESIS_INDEX_DB_PATH ?? join(configDir, GATEWAY_INDEX_STORE_FILE),
          },
        ]
      : []),
    { name: WATCH_JOURNAL_FILENAME, path: join(configDir, WATCH_JOURNAL_FILENAME) },
    {
      name: GATEWAY_ANALYTICS_STORE_FILE,
      path: env.OMNESIS_ANALYTICS_DB_PATH ?? join(configDir, GATEWAY_ANALYTICS_STORE_FILE),
    },
  ];
}

/** Free space demanded over the summed size of what is copied. */
const DISK_HEADROOM_FACTOR = 1.1;

export interface OfflineBackupOptions {
  configDir: string;
  /** Defaults to `<configDir>/backups`. */
  backupsDir?: string;
  stores: readonly GatewayStoreFile[];
  includeIndex: boolean;
  /** Product version recorded in the manifest. */
  version: string;
  purpose: BackupPurpose;
  note?: string;
  now?: () => Date;
  /** Mockable statfs seam for the disk preflight. */
  statfs?: (path: string) => { bavail: number | bigint; bsize: number | bigint };
}

export interface OfflineBackupResult {
  path: string;
  files: Array<{ name: string; bytes: number }>;
}

/**
 * Copy a stopped gateway's stores and config material into a backup.
 *
 * Only safe while no gateway has the stores open; the caller proves that, and
 * keeps proving it for the length of the copy by holding the config
 * directory's gateway lock. Stores are copied byte for byte: an
 * encrypted-at-rest store stays encrypted under the storage keys the backup
 * also carries, so the manifest declares no artifact encryption and
 * `omnesis restore` puts the files back as they were.
 *
 * The manifest is written last. A copy that fails part-way removes its
 * directory, and one that never got that far is skipped by every reader.
 */
export function writeOfflineBackup(opts: OfflineBackupOptions): OfflineBackupResult {
  const backupsDir = opts.backupsDir ?? join(opts.configDir, "backups");
  const now = opts.now ?? (() => new Date());
  const copies: Array<{ from: string; name: string }> = [];
  for (const store of opts.stores) {
    for (const suffix of ["", ...STORE_COMPANION_SUFFIXES]) {
      if (existsSync(`${store.path}${suffix}`)) {
        copies.push({ from: `${store.path}${suffix}`, name: `${store.name}${suffix}` });
      }
    }
  }
  for (const name of backupConfigCopyNames(opts.configDir)) {
    copies.push({ from: join(opts.configDir, name), name });
  }

  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const requiredBytes = copies.reduce((sum, copy) => sum + sizeOfPath(copy.from), 0);
  const sf = (opts.statfs ?? statfsSync)(backupsDir);
  const freeBytes = Number(sf.bavail) * Number(sf.bsize);
  const neededBytes = Math.ceil(requiredBytes * DISK_HEADROOM_FACTOR);
  if (freeBytes < neededBytes) {
    throw new Error(
      `Not enough free disk space for a backup: need ~${formatBytes(neededBytes)}, ` +
        `but only ${formatBytes(freeBytes)} is free in ${backupsDir}`,
    );
  }

  const startedAt = now().toISOString();
  const path = createBackupDir(backupsDir, startedAt);
  try {
    const files: Array<{ name: string; bytes: number }> = [];
    for (const copy of copies) {
      copyPrivate(copy.from, join(path, copy.name));
      files.push({ name: copy.name, bytes: sizeOfPath(join(path, copy.name)) });
    }
    const manifest: BackupManifest = {
      version: opts.version,
      startedAt,
      finishedAt: now().toISOString(),
      files,
      includeIndex: opts.includeIndex,
      purpose: opts.purpose,
      ...(opts.note ? { note: opts.note } : {}),
    };
    atomicWriteFileSync(
      join(path, BACKUP_MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    return { path, files };
  } catch (err) {
    rmSync(path, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Copy a file or directory tree owner-only. Symbolic links and special files
 * are not followed: a backup mirrors what the config directory holds, never
 * what a link inside it points at.
 *
 * It copies entry by entry with plain calls rather than `fs.cpSync`: a
 * container's bind mount of the config directory through a Mac VM's file
 * share (colima's virtiofs) refuses `cpSync`'s directory copy with EACCES
 * while accepting each mkdir, copy and chmod it is made of.
 */
export function copyPrivate(from: string, to: string): void {
  const stat = lstatSync(from);
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    chmodSync(to, 0o700);
    for (const entry of readdirSync(from)) copyPrivate(join(from, entry), join(to, entry));
    return;
  }
  if (!stat.isFile()) return;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to);
  chmodSync(to, 0o600);
}

function sizeOfPath(path: string): number {
  const stat = lstatSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of readdirSync(path)) total += sizeOfPath(join(path, entry));
  return total;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

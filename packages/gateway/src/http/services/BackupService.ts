// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * BackupService (#57) — gateway-side online backup of the data directory.
 *
 * One backup produces `<configDir>/backups/<YYYY-MM-DDTHH-mm-ss>/` holding:
 *
 *   - `omnesis.db`      — `VACUUM INTO` snapshot (always)
 *   - `index.db`        — `VACUUM INTO` snapshot (unless `includeIndex: false`)
 *   - `watch.db`        — `VACUUM INTO` snapshot of the watch journal
 *   - `analytics.db`    — DuckDB online copy via the injected `analyticsBackup`
 *                         port (the live `AnalyticsDb` pool holds the file
 *                         lock, so a second DuckDB instance cannot open it —
 *                         the copy must run through the pool)
 *   - config material   — `omnesis.json`, `.env`, `token`, `collector-token`,
 *                         non-secret keyring policy markers, wrapped
 *                         live-storage key envelopes, the root-key recovery
 *                         envelope, every `*-credentials.json`,
 *                         `config-secrets/`, and `tls/`, each copied only when
 *                         present
 *   - `backup-manifest.json` — listing metadata; when artifacts are encrypted,
 *     the full note-bearing manifest is stored as `backup-manifest.full.json.enc`
 *
 * Deliberately excluded (the copy list is an allowlist): `models/`
 * (re-downloadable), `backups/` (no recursion), `index.usearch` (rebuilds
 * from index.db), and the SQLite `-wal`/`-shm` companions (`VACUUM INTO`
 * folds WAL content into the snapshot). When an install root key exists,
 * completed backup files are encrypted in place as generated artifacts — with
 * one exception: the recovery envelope (already sealed under the operator's
 * recovery code) is left as-is so that restoring on a fresh machine, where the
 * root key is not yet present, can still reconstitute it from the backup.
 *
 * The SQLite vacuums run on a worker thread (`workers/backup-worker.ts`) —
 * better-sqlite3 is synchronous and a multi-GB vacuum would otherwise park
 * the gateway main thread for minutes. Start/poll shape mirrors the model
 * download flow: `start()` returns immediately with a `backupId`,
 * `getStatus()` serves per-file progress, and a second concurrent `start()`
 * is rejected with a 409.
 */

import { Worker } from "node:worker_threads";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BACKUP_FULL_MANIFEST_NAME,
  BACKUP_MANIFEST_NAME,
  BACKUP_RECOVERY_ENVELOPE_NAME,
  DEFAULT_PRE_UPDATE_BACKUP_COUNT,
  ENCRYPTED_ARTIFACT_SUFFIX,
  backupConfigCopyNames,
  createBackupDir,
  createLogger,
  encryptArtifactFileInPlace,
  listBackups,
  prunePreUpdateBackups,
  resolveWorkerEntry,
  type BackupManifest,
  type BackupPurpose,
  type ListedBackup,
  type SecretStoreBackend,
} from "@omnesis/core";
import { GATEWAY_VERSION } from "../../version.js";
import { ConflictError, InsufficientStorageError, ServiceUnavailableError } from "../errors.js";
import { WATCH_JOURNAL_FILENAME } from "../../watch/journal-path.js";
import type { BackupWorkerInput, BackupWorkerMessage } from "../../workers/backup-protocol.js";

const log = createLogger("gateway:backup");

const MANIFEST_NAME = BACKUP_MANIFEST_NAME;
const FULL_MANIFEST_NAME = BACKUP_FULL_MANIFEST_NAME;
const RECOVERY_ENVELOPE_NAME = BACKUP_RECOVERY_ENVELOPE_NAME;

/** Required free-space headroom over the summed source DB sizes. */
const DISK_HEADROOM_FACTOR = 1.1;

export {
  backupManifestSchema,
  DEFAULT_PRE_UPDATE_BACKUP_COUNT,
  type BackupManifest,
  type BackupPurpose,
  type ListedBackup,
} from "@omnesis/core";

export interface BackupFileProgress {
  name: string;
  bytes: number;
  durationMs: number;
  encrypted?: boolean;
}

export interface BackupResult {
  backupId: string;
  ok: boolean;
  error?: string;
  startedAt: string;
  finishedAt: string;
  path: string;
  totalBytes: number;
  files: BackupFileProgress[];
}

export interface BackupStatus {
  running: boolean;
  current?: {
    backupId: string;
    startedAt: string;
    path: string;
    includeIndex: boolean;
    note?: string;
    /** File currently being vacuumed/copied, when one is in flight. */
    currentFile?: string;
    /**
     * Bytes written so far to the in-flight file's destination. `VACUUM INTO`
     * grows its output file in place, so this tracks a multi-GB snapshot while
     * it runs. Absent when nothing is measurable yet — config copies, and an
     * analytics copy staged elsewhere and moved into the backup only once done.
     */
    currentFileBytes?: number;
    /** Files completed so far. */
    files: BackupFileProgress[];
  };
  lastResult?: BackupResult;
}

interface CurrentBackup {
  backupId: string;
  startedAt: string;
  path: string;
  includeIndex: boolean;
  purpose: BackupPurpose;
  note?: string;
  currentFile?: string;
  /** Destination of the in-flight file, measured on each status read. */
  currentDestPath?: string;
  files: BackupFileProgress[];
}

export interface BackupServiceOptions {
  configDir: string;
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  indexDbPath: string;
  indexDbKeyHex?: string;
  /**
   * The watch journal. Copied like the other stores because nothing else holds
   * a watch's definition — the event stream can be replayed from the corpus,
   * but what the operator asked to be told about cannot be reconstructed from
   * anything.
   */
  watchDbPath: string;
  watchDbKeyHex?: string;
  analyticsDbPath: string;
  /**
   * Online copy of the live DuckDB analytics database into `destPath`.
   * Production wires `analyticsDb.backupTo`; tests stub it.
   */
  analyticsBackup: (destPath: string) => Promise<void>;
  /** Defaults to `<configDir>/backups`. */
  backupsDir?: string;
  /** Mockable statfs seam for the disk preflight. */
  statfs?: (path: string) => { bavail: number | bigint; bsize: number | bigint };
  /**
   * The gateway's own low-disk floor (`gateway.minFreeDiskMb`), read fresh so a
   * config edit lands without a restart. A backup that fits but consumes this
   * floor leaves the process unable to ingest — 507 on every write — so the
   * preflight requires the floor to survive the copy, not merely to precede it.
   * Omitted means no floor is enforced.
   */
  minFreeDiskBytes?: () => number;
  /**
   * Number of automatic pre-update backups to retain, read at prune time so a
   * config edit can apply without a restart. Zero disables pruning.
   */
  preUpdateRetentionCount?: () => number;
  /** Clock seam (backup directory names derive from it). */
  now?: () => Date;
  /** Test seam; production uses OMNESIS_SECRET_STORE/auto. */
  secretStoreBackend?: SecretStoreBackend;
}

export class BackupService {
  private readonly backupsDir: string;
  private readonly statfs: NonNullable<BackupServiceOptions["statfs"]>;
  private readonly now: () => Date;
  private current: CurrentBackup | null = null;
  private lastResult: BackupResult | undefined;
  private runPromise: Promise<void> = Promise.resolve();

  constructor(private readonly opts: BackupServiceOptions) {
    this.backupsDir = opts.backupsDir ?? join(opts.configDir, "backups");
    this.statfs = opts.statfs ?? ((path) => statfsSync(path));
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Kick off a backup. Returns immediately; progress is polled via
   * `getStatus()`. Throws 409 when a backup is already running and 507
   * when the backups volume lacks the required free space.
   *
   * `estimatedTotalBytes` is the disk preflight's requirement — an upper bound,
   * not a prediction: the snapshots compact free pages, so a finished backup is
   * usually well below it.
   */
  start(opts?: { includeIndex?: boolean; note?: string; purpose?: BackupPurpose }): {
    backupId: string;
    estimatedTotalBytes: number;
  } {
    if (this.current) {
      throw new ConflictError("A backup is already running — poll GET /admin/backup/status");
    }
    const includeIndex = opts?.includeIndex ?? true;
    if (!existsSync(this.opts.gatewayDbPath)) {
      throw new ServiceUnavailableError(
        `Gateway database not found at ${this.opts.gatewayDbPath} — nothing to back up`,
      );
    }

    mkdirSync(this.backupsDir, { recursive: true });
    const estimatedTotalBytes = this.preflightDiskSpace(includeIndex);

    const backupId = randomUUID();
    const startedAt = this.now().toISOString();
    const path = createBackupDir(this.backupsDir, startedAt);

    const current: CurrentBackup = {
      backupId,
      startedAt,
      path,
      includeIndex,
      purpose: opts?.purpose ?? "operator",
      ...(opts?.note ? { note: opts.note } : {}),
      files: [],
    };
    this.current = current;
    log.info(`Backup ${backupId} started: dir=${path} includeIndex=${includeIndex}`);
    // run() handles every failure internally (records lastResult, cleans
    // up); the stored promise never rejects, so whenIdle() can await it.
    this.runPromise = this.run(current);
    return { backupId, estimatedTotalBytes };
  }

  getStatus(): BackupStatus {
    const currentFileBytes = this.current ? measureInFlight(this.current) : undefined;
    return {
      running: this.current !== null,
      ...(this.current
        ? {
            current: {
              backupId: this.current.backupId,
              startedAt: this.current.startedAt,
              path: this.current.path,
              includeIndex: this.current.includeIndex,
              ...(this.current.note ? { note: this.current.note } : {}),
              ...(this.current.currentFile ? { currentFile: this.current.currentFile } : {}),
              ...(currentFileBytes !== undefined ? { currentFileBytes } : {}),
              files: [...this.current.files],
            },
          }
        : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
    };
  }

  /** Completed backups (directories with a parseable manifest), newest first. */
  list(): ListedBackup[] {
    return listBackups(this.backupsDir, log);
  }

  /** Resolves once no backup is in flight. Test + shutdown hook. */
  whenIdle(): Promise<void> {
    return this.runPromise;
  }

  /**
   * Fail fast when the backups volume can't hold the snapshot: free space must
   * exceed the summed source DB sizes plus 10% headroom (`VACUUM INTO` output
   * is at most the source size; the headroom covers config copies and
   * concurrent growth).
   *
   * The snapshot must also *leave* the gateway's low-disk floor intact. Fitting
   * is not the same as being safe to run: a backup that ends one byte above
   * empty takes ingestion down with it, and the operator asked for a copy of
   * their data, not an outage. The floor is the same `gateway.minFreeDiskMb`
   * the write path already refuses below, so a backup can never be the thing
   * that trips it.
   */
  private preflightDiskSpace(includeIndex: boolean): number {
    const sources = [
      this.opts.gatewayDbPath,
      this.opts.analyticsDbPath,
      this.opts.watchDbPath,
      ...(includeIndex ? [this.opts.indexDbPath] : []),
    ];
    let requiredBytes = 0;
    for (const source of sources) {
      try {
        requiredBytes += statSync(source).size;
      } catch {
        // Source not created yet (e.g. fresh install) — nothing to copy.
      }
    }
    const sf = this.statfs(this.backupsDir);
    const freeBytes = Number(sf.bavail) * Number(sf.bsize);
    const neededBytes = Math.ceil(requiredBytes * DISK_HEADROOM_FACTOR);
    const configuredFloor = this.opts.minFreeDiskBytes?.() ?? 0;
    const floorBytes = Number.isFinite(configuredFloor) ? Math.max(0, configuredFloor) : 0;
    if (freeBytes < neededBytes + floorBytes) {
      const floorNote = floorBytes
        ? ` and keep ${formatBytes(floorBytes)} free for the gateway to keep writing`
        : "";
      throw new InsufficientStorageError(
        `Not enough free disk space for a backup: need ~${formatBytes(neededBytes)} ` +
          `(${formatBytes(requiredBytes)} of databases + 10% headroom)${floorNote}, ` +
          `but only ${formatBytes(freeBytes)} is free in ${this.backupsDir}`,
      );
    }
    return neededBytes;
  }

  private async run(cur: CurrentBackup): Promise<void> {
    const startMs = Date.now();
    try {
      const vacuums: BackupWorkerInput["vacuums"] = [
        {
          sourcePath: this.opts.gatewayDbPath,
          destPath: join(cur.path, "omnesis.db"),
          ...(this.opts.gatewayDbKeyHex ? { keyHex: this.opts.gatewayDbKeyHex } : {}),
          name: "omnesis.db",
        },
      ];
      if (cur.includeIndex) {
        if (existsSync(this.opts.indexDbPath)) {
          vacuums.push({
            sourcePath: this.opts.indexDbPath,
            destPath: join(cur.path, "index.db"),
            ...(this.opts.indexDbKeyHex ? { keyHex: this.opts.indexDbKeyHex } : {}),
            name: "index.db",
          });
        } else {
          log.warn(`index.db not found at ${this.opts.indexDbPath} — skipping`);
        }
      }
      if (existsSync(this.opts.watchDbPath)) {
        vacuums.push({
          sourcePath: this.opts.watchDbPath,
          destPath: join(cur.path, WATCH_JOURNAL_FILENAME),
          ...(this.opts.watchDbKeyHex ? { keyHex: this.opts.watchDbKeyHex } : {}),
          name: WATCH_JOURNAL_FILENAME,
        });
      }
      await this.runWorker({ vacuums, copies: this.collectConfigCopies(cur.path) }, cur);

      if (existsSync(this.opts.analyticsDbPath)) {
        const dest = join(cur.path, "analytics.db");
        cur.currentFile = "analytics.db";
        cur.currentDestPath = dest;
        const t = Date.now();
        await this.opts.analyticsBackup(dest);
        const bytes = statSync(dest).size;
        const durationMs = Date.now() - t;
        cur.files.push({ name: "analytics.db", bytes, durationMs });
        log.info(`Backed up analytics.db: ${formatBytes(bytes)} in ${durationMs}ms`);
      }
      cur.currentFile = undefined;
      cur.currentDestPath = undefined;
      const encrypted = await this.encryptCompletedFiles(cur);

      const finishedAt = this.now().toISOString();
      const manifestBase: BackupManifest = {
        version: GATEWAY_VERSION,
        startedAt: cur.startedAt,
        finishedAt,
        files: cur.files.map(({ name, bytes, encrypted }) => ({
          name,
          bytes,
          ...(encrypted ? { encrypted } : {}),
        })),
        ...(encrypted
          ? {
              encryption: {
                scheme: "omnesis.encrypted-artifact.v1",
                key: "install-root-key-v1",
              },
            }
          : {}),
        includeIndex: cur.includeIndex,
        purpose: cur.purpose,
        ...(cur.note ? { note: cur.note } : {}),
      };
      const manifest = encrypted
        ? await this.writeEncryptedFullManifest(cur, manifestBase)
        : manifestBase;
      writeFileSync(join(cur.path, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

      const totalBytes = cur.files.reduce((sum, f) => sum + f.bytes, 0);
      this.lastResult = {
        backupId: cur.backupId,
        ok: true,
        startedAt: cur.startedAt,
        finishedAt,
        path: cur.path,
        totalBytes,
        files: [...cur.files],
      };
      if (cur.purpose === "pre-update") this.prunePreUpdateBackups(cur.path);
      log.info(
        `Backup ${cur.backupId} complete: ${cur.files.length} files, ${formatBytes(totalBytes)} in ${Date.now() - startMs}ms at ${cur.path}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastResult = {
        backupId: cur.backupId,
        ok: false,
        error: message,
        startedAt: cur.startedAt,
        finishedAt: this.now().toISOString(),
        path: cur.path,
        totalBytes: 0,
        files: [...cur.files],
      };
      // Drop the partial directory so a failed run doesn't strand
      // multi-GB half-written snapshots (list() would skip it anyway —
      // no manifest — but the disk space matters).
      try {
        rmSync(cur.path, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      log.error(`Backup ${cur.backupId} failed after ${Date.now() - startMs}ms: ${message}`);
    } finally {
      this.current = null;
    }
  }

  private prunePreUpdateBackups(currentPath: string): void {
    const keepCount = this.opts.preUpdateRetentionCount?.() ?? DEFAULT_PRE_UPDATE_BACKUP_COUNT;
    prunePreUpdateBackups(this.backupsDir, keepCount, currentPath, log);
  }

  /** The shared config-material allowlist, as worker copy jobs into `backupDir`. */
  private collectConfigCopies(backupDir: string): BackupWorkerInput["copies"] {
    return backupConfigCopyNames(this.opts.configDir).map((name) => ({
      from: join(this.opts.configDir, name),
      to: join(backupDir, name),
      name,
    }));
  }

  private runWorker(input: BackupWorkerInput, cur: CurrentBackup): Promise<void> {
    const entry = resolveWorkerEntry(
      "../../workers/backup-worker.ts",
      import.meta.url,
      "../../workers/register-tsx.mjs",
    );
    // Only vacuums are measured in flight: config copies are small and may be
    // whole directories.
    const destByName = new Map(input.vacuums.map((job) => [job.name, job.destPath]));
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(entry.url, { workerData: input, execArgv: entry.execArgv });
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      worker.on("message", (msg: BackupWorkerMessage) => {
        switch (msg.type) {
          case "begin":
            cur.currentFile = msg.file;
            cur.currentDestPath = destByName.get(msg.file);
            break;
          case "file":
            cur.currentFile = undefined;
            cur.currentDestPath = undefined;
            cur.files.push({ name: msg.file, bytes: msg.bytes, durationMs: msg.durationMs });
            log.info(`Backed up ${msg.file}: ${formatBytes(msg.bytes)} in ${msg.durationMs}ms`);
            break;
          case "done":
            settle(resolve);
            break;
          case "error":
            settle(() => reject(new Error(msg.error)));
            break;
        }
      });
      worker.on("error", (err) => settle(() => reject(err)));
      worker.on("exit", (code) =>
        settle(() => reject(new Error(`backup worker exited prematurely (code ${code})`))),
      );
    });
  }

  private async encryptCompletedFiles(cur: CurrentBackup): Promise<boolean> {
    let encryptedAny = false;
    for (let i = 0; i < cur.files.length; i++) {
      const file = cur.files[i]!;
      // The recovery envelope is already sealed under the operator's recovery
      // code and must stay root-key-independent — re-encrypting it under the
      // root key would defeat its purpose (recovering that key on a machine
      // where it is absent). Leave it verbatim in the backup.
      if (file.name === RECOVERY_ENVELOPE_NAME) continue;
      const target = join(cur.path, file.name);
      if (!existsSync(target)) continue;
      const result = await this.encryptBackupPath(
        target,
        file.name,
        `backup:${cur.backupId}:${file.name}`,
      );
      if (!result.encrypted) continue;
      encryptedAny = true;
      cur.files[i] = {
        ...file,
        name: result.name,
        bytes: result.bytes,
        encrypted: true,
      };
      log.info(`Encrypted backup artifact ${result.name}: ${formatBytes(result.bytes)}`);
    }
    return encryptedAny;
  }

  private async writeEncryptedFullManifest(
    cur: CurrentBackup,
    fullManifest: BackupManifest,
  ): Promise<BackupManifest> {
    const fullPath = join(cur.path, FULL_MANIFEST_NAME);
    writeFileSync(fullPath, JSON.stringify(fullManifest, null, 2) + "\n", { mode: 0o600 });
    const result = await encryptArtifactFileInPlace(fullPath, {
      configDir: this.opts.configDir,
      backend: this.opts.secretStoreBackend,
      scope: `backup:${cur.backupId}:${FULL_MANIFEST_NAME}`,
    });
    if (!result.encrypted) {
      throw new Error(
        "Backup artifacts were encrypted but the full manifest could not be encrypted",
      );
    }
    return {
      version: fullManifest.version,
      startedAt: fullManifest.startedAt,
      finishedAt: fullManifest.finishedAt,
      files: [
        ...fullManifest.files.filter((file) => file.name !== MANIFEST_NAME),
        {
          name: `${FULL_MANIFEST_NAME}${ENCRYPTED_ARTIFACT_SUFFIX}`,
          bytes: result.bytes,
          encrypted: true,
        },
      ],
      encryption: fullManifest.encryption,
      encryptedManifest: `${FULL_MANIFEST_NAME}${ENCRYPTED_ARTIFACT_SUFFIX}`,
      includeIndex: fullManifest.includeIndex,
      purpose: fullManifest.purpose,
    };
  }

  private async encryptBackupPath(
    path: string,
    name: string,
    scope: string,
  ): Promise<{ encrypted: boolean; name: string; bytes: number }> {
    const st = statSync(path);
    if (st.isFile()) {
      const result = await encryptArtifactFileInPlace(path, {
        configDir: this.opts.configDir,
        backend: this.opts.secretStoreBackend,
        scope,
      });
      return {
        encrypted: result.encrypted,
        name: result.encrypted ? `${name}${ENCRYPTED_ARTIFACT_SUFFIX}` : name,
        bytes: result.bytes,
      };
    }
    if (!st.isDirectory()) return { encrypted: false, name, bytes: st.size };

    let encryptedAny = false;
    for (const rel of listFilesRelative(path)) {
      const result = await encryptArtifactFileInPlace(join(path, rel), {
        configDir: this.opts.configDir,
        backend: this.opts.secretStoreBackend,
        scope: `${scope}/${rel}`,
      });
      encryptedAny = encryptedAny || result.encrypted;
    }
    return {
      encrypted: encryptedAny,
      name,
      bytes: sizeOfPath(path),
    };
  }
}

/**
 * Current size of the in-flight file's destination, or undefined when there is
 * no destination to measure or it does not exist yet. Only the destination
 * file itself counts: the rollback journal `VACUUM INTO` keeps beside it holds
 * a header, not snapshot content.
 */
function measureInFlight(cur: CurrentBackup): number | undefined {
  if (!cur.currentFile || !cur.currentDestPath) return undefined;
  try {
    return statSync(cur.currentDestPath).size;
  } catch {
    return undefined;
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function listFilesRelative(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRelative(root, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function sizeOfPath(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOfPath(join(path, entry.name));
  }
  return total;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { opendir, lstat, readFile, rm } from "node:fs/promises";
import { lstatSync, mkdirSync, renameSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKUP_MANIFEST_NAME, backupManifestSchema } from "@omnesis/core";
import { fileIdentity } from "../agent/conversation-retention.js";
import type { Dir } from "node:fs";
import type {
  HistoryCleanupAdapter,
  HistoryCleanupCandidate,
  HistoryCleanupOutcome,
  HistoryCleanupPage,
  StoredHistoryCleanupJob,
} from "./history-cleanup-types.js";
const BACKUP_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-(?:[2-9]|[1-9]\d+))?$/;
interface BackupEntry {
  id: string;
  identity: string;
  bytesEstimate: number;
  startedAt: string;
  inode: string;
  digest: string;
}
function isNewerBackup(left: BackupEntry, right: BackupEntry): boolean {
  return (
    left.startedAt > right.startedAt || (left.startedAt === right.startedAt && left.id > right.id)
  );
}
function canonical(value: string): boolean {
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString() === value;
}
async function readEntry(root: string, id: string): Promise<BackupEntry | null> {
  if (!BACKUP_ID.test(id)) return null;
  const path = join(root, id);
  const dir = await lstat(path, { bigint: true });
  if (!dir.isDirectory() || dir.isSymbolicLink()) return null;
  const manifestPath = join(path, BACKUP_MANIFEST_NAME);
  const before = await lstat(manifestPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) return null;
  const text = await readFile(manifestPath, "utf8");
  const after = await lstat(manifestPath, { bigint: true });
  if (fileIdentity(before) !== fileIdentity(after)) return null;
  const parsed = backupManifestSchema.safeParse(JSON.parse(text));
  if (
    !parsed.success ||
    !canonical(parsed.data.startedAt) ||
    !canonical(parsed.data.finishedAt) ||
    Date.parse(parsed.data.finishedAt) < Date.parse(parsed.data.startedAt)
  )
    return null;
  if (parsed.data.files.some((file) => !Number.isSafeInteger(file.bytes) || file.bytes < 0))
    return null;
  const base = parsed.data.startedAt.slice(0, 19).replace(/:/g, "-");
  if (id !== base && !id.startsWith(base + "-")) return null;
  const bytesEstimate = parsed.data.files.reduce((n, f) => n + f.bytes, 0);
  if (!Number.isSafeInteger(bytesEstimate)) return null;
  const inode = [dir.dev, dir.ino].join(":");
  const digest = createHash("sha256").update(text).digest("hex");
  return {
    id,
    identity: fileIdentity(dir) + ":" + fileIdentity(after) + ":" + digest,
    bytesEstimate,
    startedAt: parsed.data.startedAt,
    inode,
    digest,
  };
}
interface BackupScan {
  dir: Dir | null;
  phase: "catalog" | "delete";
  newest: BackupEntry | null;
  identity: string;
  initialRemoved: number;
}
export interface BackupCleanupOptions {
  backupsDir: string;
  /** Owns the same in-process exclusion as backup creation and automatic pruning. */
  exclusive: (operation: () => Promise<HistoryCleanupOutcome>) => Promise<HistoryCleanupOutcome>;
}
/** Manifest-based selection and atomic claims; requests never carry filesystem paths. */
export function backupCleanupAdapter(options: BackupCleanupOptions): HistoryCleanupAdapter {
  const scans = new Map<string, BackupScan>();
  const root = options.backupsDir;
  const close = async (id: string) => {
    await scans
      .get(id)
      ?.dir?.close()
      .catch(() => {});
    scans.delete(id);
  };
  return {
    close,
    async next(job): Promise<HistoryCleanupPage> {
      let scan = scans.get(job.id);
      if (!scan) {
        try {
          scan = {
            dir: await opendir(root),
            phase: "catalog",
            newest: null,
            identity: fileIdentity(await lstat(root, { bigint: true })),
            initialRemoved: job.removed,
          };
          scans.set(job.id, scan);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { cursor: null, scanned: 0, protectedReasons: {}, done: true };
          throw error;
        }
      }
      const reasons: Record<string, number> = {};
      let checked = 0;
      for (let i = 0; i < 20; i++) {
        const entry = await scan.dir!.read();
        if (!entry) {
          await scan.dir!.close().catch(() => {});
          if (scan.phase === "catalog") {
            scan.phase = "delete";
            scan.dir = await opendir(root);
            return {
              cursor: null,
              scanned: checked,
              protectedReasons: {},
              done: false,
              resetProtected: true,
              progressed: true,
            };
          }
          const changed = scan.identity !== fileIdentity(await lstat(root, { bigint: true }));
          const ownRemoval = job.removed !== scan.initialRemoved;
          await close(job.id);
          return {
            cursor: null,
            scanned: checked,
            protectedReasons: reasons,
            done: !changed,
            progressed: ownRemoval,
          };
        }
        if (entry.name === ".storage-cleanup") continue;
        checked++;
        if (!entry.isDirectory() || entry.isSymbolicLink() || !BACKUP_ID.test(entry.name)) {
          if (scan.phase === "delete") reasons.unsafe = (reasons.unsafe ?? 0) + 1;
          continue;
        }
        let backup: BackupEntry | null = null;
        try {
          backup = await readEntry(root, entry.name);
        } catch {
          // Unreadable or malformed manifests remain protected.
        }
        if (!backup) {
          if (scan.phase === "delete") reasons.incomplete = (reasons.incomplete ?? 0) + 1;
          continue;
        }
        if (scan.phase === "catalog") {
          if (!scan.newest || isNewerBackup(backup, scan.newest)) scan.newest = backup;
          continue;
        }
        if (Date.parse(backup.startedAt) >= Date.parse(job.before)) continue;
        if (job.keepNewest !== false && backup.id === scan.newest?.id) {
          reasons.newest = (reasons.newest ?? 0) + 1;
          continue;
        }
        return {
          cursor: null,
          scanned: checked,
          protectedReasons: reasons,
          done: false,
          candidate: {
            id: backup.id,
            identity: backup.identity,
            bytesEstimate: backup.bytesEstimate,
            detail: JSON.stringify({
              inode: backup.inode,
              digest: backup.digest,
              newestId: scan.newest?.id,
            }),
          },
        };
      }
      return { cursor: null, scanned: checked, protectedReasons: reasons, done: false };
    },
    remove: (job, candidate) => options.exclusive(() => removeBackup(root, job, candidate)),
  };
}
async function removeBackup(
  root: string,
  job: StoredHistoryCleanupJob,
  candidate: HistoryCleanupCandidate,
): Promise<HistoryCleanupOutcome> {
  if (!BACKUP_ID.test(candidate.id) || !/^[-a-z0-9]+$/.test(job.id))
    return { state: "protected", reason: "unsafe" };
  const authority = JSON.parse(candidate.detail ?? "{}") as {
    inode?: string;
    digest?: string;
    newestId?: string;
    claimed?: boolean;
  };
  if (!authority.inode || !authority.digest) return { state: "protected", reason: "unsafe" };
  const quarantine = join(root, ".storage-cleanup");
  mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  const q = lstatSync(quarantine);
  if (!q.isDirectory() || q.isSymbolicLink()) return { state: "protected", reason: "unsafe" };
  const claimed = join(quarantine, job.id);
  const original = join(root, candidate.id);
  if (!existsSync(claimed)) {
    let current: BackupEntry | null;
    try {
      current = await readEntry(root, candidate.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { state: "protected", reason: "already-removed" };
      throw error;
    }
    if (!current || current.identity !== candidate.identity)
      return { state: "protected", reason: "changed" };
    if (job.keepNewest !== false) {
      try {
        if (!authority.newestId) return { state: "protected", reason: "changed" };
        const retained = await readEntry(root, authority.newestId);
        // An archive may have finished after the catalog pass. The retained
        // witness must still be strictly newer than the selected candidate.
        if (!retained || !isNewerBackup(retained, current))
          return { state: "protected", reason: "changed" };
      } catch {
        return { state: "protected", reason: "changed" };
      }
    }
    renameSync(original, claimed);
  }
  if (!authority.claimed) {
    const actual = lstatSync(claimed, { bigint: true });
    const manifest = join(claimed, BACKUP_MANIFEST_NAME);
    let valid = false;
    try {
      const manifestStat = lstatSync(manifest);
      valid =
        actual.isDirectory() &&
        !actual.isSymbolicLink() &&
        [actual.dev, actual.ino].join(":") === authority.inode &&
        manifestStat.isFile() &&
        !manifestStat.isSymbolicLink() &&
        createHash("sha256").update(readFileSync(manifest)).digest("hex") === authority.digest;
    } catch {
      // An unverifiable claim is restored instead of being deleted.
    }
    if (!valid) {
      if (existsSync(original))
        throw new Error("Backup claim changed and cannot be restored safely");
      renameSync(claimed, original);
      return { state: "protected", reason: "changed" };
    }
    // Persist successful claim validation before any recursive deletion. A
    // crash during removal may erase the manifest but never its authority.
    return {
      state: "pending",
      candidate: { ...candidate, detail: JSON.stringify({ ...authority, claimed: true }) },
    };
  }
  // A restart may find an already partly removed claimed directory. Its
  // unguessable job name and original inode are the durable ownership proof.
  const actual = lstatSync(claimed, { bigint: true });
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    [actual.dev, actual.ino].join(":") !== authority.inode
  )
    return { state: "protected", reason: "unsafe" };
  await rm(claimed, { recursive: true, force: true });
  return { state: "removed", bytesEstimate: candidate.bytesEstimate };
}

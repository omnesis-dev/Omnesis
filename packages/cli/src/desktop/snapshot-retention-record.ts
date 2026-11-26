// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Builtins only: the fixed reclamation host must not start Keychain children
// while it holds the native code publication reservation.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertDesktopProfileGeneration } from "./generation.js";
import type { DesktopProfile } from "./environment.js";

export const MAX_RETAINED_DESKTOP_SNAPSHOTS = 16;
const MAX_RECORD_BYTES = 16_384;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digest = /^[a-f0-9]{64}$/u;
export interface RetentionFileIdentity {
  device: string;
  inode: string;
}
export interface RetainedDesktopSnapshot {
  operationId: string;
  oldEpoch: string;
  purpose: "update" | "restore";
  oldVersion: string;
  registeredAt: string;
  manifestSha256: string;
  bytes: number;
  directory: RetentionFileIdentity;
  order: number;
  pinned: boolean;
}
export interface DesktopSnapshotWitness {
  operationId: string;
  staging: boolean;
  directory: RetentionFileIdentity;
  inventory: {
    kind: "manifest" | "owner";
    identity: RetentionFileIdentity;
    bytes: number;
    mtimeNs: string;
    ctimeNs: string;
    sha256: string;
  };
}
export interface DesktopSnapshotCleanupReceipt {
  operationId: string;
  snapshotId: string;
  journals: { updateId: string | null; restoreId: string | null };
  currentEpoch: string;
  oldEpoch: string;
  mode: "redundant-snapshot" | "last-copy-old-epoch" | "incomplete-owned";
  phase: "planned" | "deleting";
  target: DesktopSnapshotWitness;
  keeper: DesktopSnapshotWitness | null;
}
export interface DesktopSnapshotRetentionRecord {
  format: 1;
  owner: "omnesis-desktop";
  instance: string;
  secretService: string;
  root: RetentionFileIdentity;
  sequence: number;
  records: RetainedDesktopSnapshot[];
  pending: DesktopSnapshotCleanupReceipt | null;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: string): boolean {
  return Object.keys(value).sort().join(",") === names;
}
function identity(value: unknown): value is RetentionFileIdentity {
  return (
    object(value) &&
    keys(value, "device,inode") &&
    typeof value.device === "string" &&
    /^\d{1,32}$/u.test(value.device) &&
    typeof value.inode === "string" &&
    /^\d{1,32}$/u.test(value.inode)
  );
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function productVersion(value: unknown): value is string {
  return (
    matches(value, /^(?:0|[1-9]\d{0,15})\.(?:0|[1-9]\d{0,15})\.(?:0|[1-9]\d{0,15})$/u) &&
    value.split(".").every((part) => Number.isSafeInteger(Number(part)))
  );
}
function invalid(): never {
  throw new Error("The recovery snapshot ledger is invalid");
}
export function parseDesktopSnapshotRetention(value: unknown): DesktopSnapshotRetentionRecord {
  if (
    !object(value) ||
    !keys(value, "format,instance,owner,pending,records,root,secretService,sequence") ||
    value.format !== 1 ||
    value.owner !== "omnesis-desktop" ||
    !matches(value.instance, /^desktop-[a-f0-9]{16}$/u) ||
    !matches(value.secretService, /^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u) ||
    !identity(value.root) ||
    !integer(value.sequence) ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_RETAINED_DESKTOP_SNAPSHOTS
  )
    invalid();
  const records: RetainedDesktopSnapshot[] = [];
  const ids = new Set<string>(),
    orders = new Set<number>();
  for (const entry of value.records) {
    if (
      !object(entry) ||
      !keys(
        entry,
        "bytes,directory,manifestSha256,oldEpoch,oldVersion,operationId,order,pinned,purpose,registeredAt",
      ) ||
      !matches(entry.operationId, uuid) ||
      !matches(entry.oldEpoch, digest) ||
      (entry.purpose !== "update" && entry.purpose !== "restore") ||
      !productVersion(entry.oldVersion) ||
      !matches(entry.registeredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u) ||
      !Number.isFinite(Date.parse(entry.registeredAt)) ||
      new Date(entry.registeredAt).toISOString() !== entry.registeredAt ||
      !matches(entry.manifestSha256, digest) ||
      !integer(entry.bytes) ||
      !identity(entry.directory) ||
      !integer(entry.order) ||
      entry.order < 1 ||
      entry.order > value.sequence ||
      typeof entry.pinned !== "boolean" ||
      ids.has(entry.operationId) ||
      orders.has(entry.order)
    )
      invalid();
    ids.add(entry.operationId);
    orders.add(entry.order);
    records.push({
      operationId: entry.operationId,
      oldEpoch: entry.oldEpoch,
      purpose: entry.purpose,
      oldVersion: entry.oldVersion,
      registeredAt: entry.registeredAt,
      manifestSha256: entry.manifestSha256,
      bytes: entry.bytes,
      directory: { ...entry.directory },
      order: entry.order,
      pinned: entry.pinned,
    });
  }
  let pending: DesktopSnapshotCleanupReceipt | null = null;
  if (value.pending !== null) {
    const receipt = value.pending;
    if (
      !object(receipt) ||
      !keys(
        receipt,
        "currentEpoch,journals,keeper,mode,oldEpoch,operationId,phase,snapshotId,target",
      ) ||
      !matches(receipt.operationId, uuid) ||
      !matches(receipt.snapshotId, uuid) ||
      !object(receipt.journals) ||
      !keys(receipt.journals, "restoreId,updateId") ||
      (receipt.journals.updateId !== null && !matches(receipt.journals.updateId, uuid)) ||
      (receipt.journals.restoreId !== null && !matches(receipt.journals.restoreId, uuid)) ||
      !matches(receipt.currentEpoch, digest) ||
      !matches(receipt.oldEpoch, digest) ||
      (receipt.mode !== "redundant-snapshot" &&
        receipt.mode !== "last-copy-old-epoch" &&
        receipt.mode !== "incomplete-owned") ||
      (receipt.phase !== "planned" && receipt.phase !== "deleting")
    )
      invalid();
    const target = parseSnapshotWitness(receipt.target),
      keeper = receipt.keeper === null ? null : parseSnapshotWitness(receipt.keeper);
    const row = records.find((entry) => entry.operationId === receipt.snapshotId);
    if (
      target.operationId !== receipt.snapshotId ||
      (receipt.mode === "incomplete-owned"
        ? target.inventory.kind !== "owner" ||
          ![receipt.journals.updateId, receipt.journals.restoreId].includes(receipt.snapshotId) ||
          (row !== undefined && !target.staging)
        : [receipt.journals.updateId, receipt.journals.restoreId].includes(receipt.snapshotId) ||
          !row ||
          row.pinned ||
          row.oldEpoch !== receipt.oldEpoch ||
          target.staging ||
          target.inventory.kind !== "manifest" ||
          target.inventory.sha256 !== row.manifestSha256 ||
          row.directory.device !== target.directory.device ||
          row.directory.inode !== target.directory.inode)
    )
      invalid();
    if (receipt.mode === "redundant-snapshot") {
      const retained = records.find((entry) => entry.operationId === keeper?.operationId);
      if (
        !row ||
        !keeper ||
        !retained ||
        retained.order <= row.order ||
        retained.oldEpoch !== row.oldEpoch ||
        keeper.staging ||
        keeper.inventory.kind !== "manifest" ||
        keeper.inventory.sha256 !== retained.manifestSha256 ||
        keeper.directory.device !== retained.directory.device ||
        keeper.directory.inode !== retained.directory.inode
      )
        invalid();
    } else if (keeper !== null) invalid();
    pending = {
      operationId: receipt.operationId,
      snapshotId: receipt.snapshotId,
      journals: { updateId: receipt.journals.updateId, restoreId: receipt.journals.restoreId },
      currentEpoch: receipt.currentEpoch,
      oldEpoch: receipt.oldEpoch,
      mode: receipt.mode,
      phase: receipt.phase,
      target,
      keeper,
    };
  }
  return {
    format: 1,
    owner: "omnesis-desktop",
    instance: value.instance,
    secretService: value.secretService,
    root: { ...value.root },
    sequence: value.sequence,
    records,
    pending,
  };
}
function parseSnapshotWitness(value: unknown): DesktopSnapshotWitness {
  if (
    !object(value) ||
    !keys(value, "directory,inventory,operationId,staging") ||
    !matches(value.operationId, uuid) ||
    typeof value.staging !== "boolean" ||
    !identity(value.directory) ||
    !object(value.inventory) ||
    !keys(value.inventory, "bytes,ctimeNs,identity,kind,mtimeNs,sha256") ||
    (value.inventory.kind !== "manifest" && value.inventory.kind !== "owner") ||
    !identity(value.inventory.identity) ||
    !integer(value.inventory.bytes) ||
    value.inventory.bytes < 1 ||
    value.inventory.bytes > 32 * 1024 ** 2 ||
    !matches(value.inventory.mtimeNs, /^-?\d{1,32}$/u) ||
    !matches(value.inventory.ctimeNs, /^-?\d{1,32}$/u) ||
    !matches(value.inventory.sha256, digest)
  )
    invalid();
  return {
    operationId: value.operationId,
    staging: value.staging,
    directory: { ...value.directory },
    inventory: {
      kind: value.inventory.kind,
      identity: { ...value.inventory.identity },
      bytes: value.inventory.bytes,
      mtimeNs: value.inventory.mtimeNs,
      ctimeNs: value.inventory.ctimeNs,
      sha256: value.inventory.sha256,
    },
  };
}
export function desktopSnapshotRetentionPath(profile: DesktopProfile): string {
  return join(`${profile.configDir}.bootstrap`, "code-retention.json");
}
async function parent(profile: DesktopProfile): Promise<void> {
  assertDesktopProfileGeneration(profile);
  const path = `${profile.configDir}.bootstrap`,
    stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("The recovery snapshot ledger folder must be private and owned");
}
function belongs(profile: DesktopProfile, record: DesktopSnapshotRetentionRecord): void {
  if (profile.instance !== record.instance || profile.secretService !== record.secretService)
    throw new Error("The recovery snapshot ledger belongs to another installation");
}
export async function readDesktopSnapshotRetention(
  profile: DesktopProfile,
): Promise<DesktopSnapshotRetentionRecord | null> {
  await parent(profile);
  let file;
  try {
    file = await open(
      desktopSnapshotRetentionPath(profile),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size > BigInt(MAX_RECORD_BYTES)
    )
      invalid();
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1),
      result = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat({ bigint: true });
    const published = await lstat(desktopSnapshotRetentionPath(profile), { bigint: true });
    if (
      BigInt(result.bytesRead) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== published.dev ||
      before.ino !== published.ino
    )
      invalid();
    const record = parseDesktopSnapshotRetention(
      JSON.parse(buffer.subarray(0, result.bytesRead).toString("utf8")),
    );
    belongs(profile, record);
    return record;
  } finally {
    await file.close();
  }
}
/** Caller holds the shared external installation lease. Directory sync makes intent durable. */
export async function writeDesktopSnapshotRetention(
  profile: DesktopProfile,
  input: DesktopSnapshotRetentionRecord,
): Promise<void> {
  await parent(profile);
  const record = parseDesktopSnapshotRetention(input);
  belongs(profile, record);
  const previous = await readDesktopSnapshotRetention(profile);
  if (
    previous &&
    (previous.root.device !== record.root.device ||
      previous.root.inode !== record.root.inode ||
      previous.sequence > record.sequence)
  )
    throw new Error(
      "The recovery snapshot ledger cannot replace an earlier library identity or order",
    );
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES) invalid();
  const destination = desktopSnapshotRetentionPath(profile),
    temporary = join(`${profile.configDir}.bootstrap`, `.code-retention-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(body);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await file.close();
  try {
    await parent(profile);
    await rename(temporary, destination);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!hasCode(cleanupError, "ENOENT"))
        throw new AggregateError(
          [error, cleanupError],
          "Recovery ledger publication and cleanup failed",
          { cause: cleanupError },
        );
    }
    throw error;
  }
  const directory = await open(
    `${profile.configDir}.bootstrap`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export type DesktopSnapshotDisposition =
  | { kind: "keep"; reason: "pinned" | "current-operation" | "latest" | "unregistered" }
  | { kind: "redundant-snapshot"; keeper: RetainedDesktopSnapshot }
  | { kind: "last-copy-old-epoch"; oldEpoch: string };

/** Eligibility is separate from native authority: callers still need the continuous reservation. */
export function desktopSnapshotDisposition(
  ledger: DesktopSnapshotRetentionRecord,
  snapshotId: string,
  protectedOperations: ReadonlySet<string>,
): DesktopSnapshotDisposition {
  const target = ledger.records.find((row) => row.operationId === snapshotId);
  if (!target) return { kind: "keep", reason: "unregistered" };
  if (target.pinned) return { kind: "keep", reason: "pinned" };
  if (protectedOperations.has(snapshotId)) return { kind: "keep", reason: "current-operation" };
  const latest = ledger.records.reduce<RetainedDesktopSnapshot | undefined>(
    (previous, row) => (previous === undefined || row.order > previous.order ? row : previous),
    undefined,
  );
  if (latest?.operationId === snapshotId) return { kind: "keep", reason: "latest" };
  const keeper = ledger.records
    .filter((row) => row.oldEpoch === target.oldEpoch && row.order > target.order)
    .reduce<RetainedDesktopSnapshot | undefined>(
      (previous, row) => (previous === undefined || row.order > previous.order ? row : previous),
      undefined,
    );
  return keeper
    ? { kind: "redundant-snapshot", keeper: { ...keeper, directory: { ...keeper.directory } } }
    : { kind: "last-copy-old-epoch", oldEpoch: target.oldEpoch };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BACKUP_MANIFEST_NAME,
  BACKUP_RECOVERY_ENVELOPE_NAME,
  backupManifestSchema,
  isEncryptedArtifactBuffer,
  parseRecoveryEnvelope,
} from "@omnesis/core";
import { HttpError, NotFoundError } from "../errors.js";
import { exportManifestSchema, type ExportManifest } from "./ExportService.js";

export type ArtifactKind = "backup" | "export";
export type ArtifactProtection = "encrypted-payloads" | "plaintext" | "mixed";
export interface ArtifactCatalogItem {
  id: string;
  kind: ArtifactKind;
  createdAt: string;
  /** Stored file bytes, excluding archive headers. */
  bytes: number;
  /** Data payloads are sealed; archive headers and public metadata remain readable. */
  encrypted: boolean;
  protection: ArtifactProtection;
  format?: "json" | "csv";
}
export interface ArtifactFile {
  name: string;
  identity: string;
  bytes: number;
  modifiedAt: number;
  sealed: boolean;
}
export interface ArtifactPlan {
  exportManifest?: ExportManifest;
  item: ArtifactCatalogItem;
  root: string;
  rootIdentity: string;
  directory: string;
  directoryIdentity: string;
  files: ArtifactFile[];
  directories: string[];
}

// These bounds limit untrusted filesystem metadata work, not corpus/store size.
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_FILES = 16384;
const MAX_DEPTH = 16;
const MAX_PATH_BYTES = 1024;

export function artifactUnavailable(): NotFoundError {
  return new NotFoundError("This completed artifact is no longer available. Refresh the list.");
}
function limit(): HttpError {
  return new HttpError(
    503,
    "ARTIFACT_METADATA_LIMIT",
    "This artifact has too many files to download safely.",
  );
}
export function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function directoryIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}
function safeName(name: string): boolean {
  return (
    Boolean(name) &&
    Buffer.byteLength(name) <= MAX_PATH_BYTES &&
    !isAbsolute(name) &&
    !/[\\\x00-\x1f\x7f:]/u.test(name) &&
    name.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function regular(stat: BigIntStats): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    stat.size >= 0n &&
    stat.size <= BigInt(Number.MAX_SAFE_INTEGER)
  );
}
async function checkedPath(root: string, name: string): Promise<string> {
  if (!safeName(name)) throw artifactUnavailable();
  let current = root;
  for (const part of name.split("/")) {
    current = join(current, part);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !regular(stat)))
      throw artifactUnavailable();
  }
  const canonical = await realpath(current);
  if (!inside(root, canonical) || canonical !== resolve(current)) throw artifactUnavailable();
  return current;
}

async function readManifest(
  directory: string,
  name: string,
): Promise<{ text: string; identity: string }> {
  const path = await checkedPath(directory, name);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!regular(before) || before.size > BigInt(MAX_MANIFEST_BYTES)) throw artifactUnavailable();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== Number(before.size) || fileIdentity(before) !== fileIdentity(after))
      throw artifactUnavailable();
    return { text: buffer.subarray(0, offset).toString("utf8"), identity: fileIdentity(before) };
  } finally {
    await handle.close();
  }
}

async function manifestPlan(
  root: string,
  kind: ArtifactKind,
  name: string,
  signal: AbortSignal,
  budget: { remaining: number },
): Promise<ArtifactPlan> {
  signal.throwIfAborted();
  if (!safeName(name) || name.includes("/")) throw artifactUnavailable();
  const rootStat = await lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw artifactUnavailable();
  const directory = await checkedPath(root, name);
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory()) throw artifactUnavailable();
  const manifestName = kind === "backup" ? BACKUP_MANIFEST_NAME : "manifest.json";
  const manifest = await readManifest(directory, manifestName);
  const raw: unknown = JSON.parse(manifest.text);
  const parsed =
    kind === "backup" ? backupManifestSchema.safeParse(raw) : exportManifestSchema.safeParse(raw);
  if (!parsed.success) throw artifactUnavailable();
  const time = Date.parse(parsed.data.finishedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== parsed.data.finishedAt)
    throw artifactUnavailable();
  const declared = parsed.data.files.map((file) => (typeof file === "string" ? file : file.name));
  if (declared.length > MAX_FILES) throw limit();
  const files = new Map<string, ArtifactFile>();
  const directories = new Set<string>();
  let entries = 0;
  const collect = async (fileName: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > MAX_DEPTH || ++entries > MAX_FILES || --budget.remaining < 0) throw limit();
    const path = await checkedPath(directory, fileName);
    const stat = await lstat(path, { bigint: true });
    if (stat.isDirectory()) {
      directories.add(fileName);
      const children = await opendir(path);
      try {
        for await (const child of children) await collect(`${fileName}/${child.name}`, depth + 1);
      } finally {
        await children.close().catch(() => {});
      }
    } else {
      if (!regular(stat)) throw artifactUnavailable();
      const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      let sealed: boolean;
      try {
        if (fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(stat))
          throw artifactUnavailable();
        const prefix = Buffer.alloc(64);
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        sealed = isEncryptedArtifactBuffer(prefix.subarray(0, bytesRead));
        if (fileName === BACKUP_RECOVERY_ENVELOPE_NAME && stat.size <= BigInt(MAX_MANIFEST_BYTES)) {
          const envelope = Buffer.alloc(Number(stat.size) + 1);
          const read = await handle.read(envelope, 0, envelope.length, 0);
          try {
            sealed =
              read.bytesRead === Number(stat.size) &&
              parseRecoveryEnvelope(
                JSON.parse(envelope.subarray(0, read.bytesRead).toString("utf8")),
              ) !== null;
          } catch {
            sealed = false;
          }
        }
        if (fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(stat))
          throw artifactUnavailable();
      } finally {
        await handle.close();
      }
      files.set(fileName, {
        name: fileName,
        identity: fileIdentity(stat),
        bytes: Number(stat.size),
        modifiedAt: Number(stat.mtimeMs),
        sealed,
      });
    }
  };
  for (const file of new Set([manifestName, ...declared])) await collect(file, 0);
  signal.throwIfAborted();
  const after = await lstat(directory, { bigint: true });
  if (fileIdentity(before) !== fileIdentity(after)) throw artifactUnavailable();
  const manifestAfter = await readManifest(directory, manifestName);
  if (manifest.identity !== manifestAfter.identity || manifest.text !== manifestAfter.text)
    throw artifactUnavailable();
  const ordered = [...files.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const bytes = ordered.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(bytes)) throw limit();
  const payloads = ordered.filter((file) => file.name !== manifestName);
  const sealed = payloads.filter((file) => file.sealed).length;
  const protection: ArtifactProtection =
    parsed.data.encryption && payloads.length > 0 && sealed === payloads.length
      ? "encrypted-payloads"
      : sealed > 0
        ? "mixed"
        : "plaintext";
  const digest = createHash("sha256").update(
    JSON.stringify([
      kind,
      root,
      directoryIdentity(rootStat),
      name,
      fileIdentity(after),
      manifest.text,
    ]),
  );
  for (const [index, file] of ordered.entries()) {
    digest.update(JSON.stringify(file));
    if (index % 128 === 127) {
      signal.throwIfAborted();
      await setImmediate();
    }
  }
  for (const directory of [...directories].sort()) digest.update(JSON.stringify(directory));
  const id = digest.digest("hex");
  return {
    ...(kind === "export" ? { exportManifest: exportManifestSchema.parse(raw) } : {}),
    item: {
      id,
      kind,
      createdAt: parsed.data.finishedAt,
      bytes,
      protection,
      encrypted: protection === "encrypted-payloads",
      ...("format" in parsed.data ? { format: parsed.data.format } : {}),
    },
    root,
    rootIdentity: directoryIdentity(rootStat),
    directory,
    directoryIdentity: fileIdentity(after),
    files: ordered,
    directories: [...directories].sort(),
  };
}

export async function catalogArtifactPlans(
  rootPath: string,
  kind: ArtifactKind,
  signal: AbortSignal,
): Promise<ArtifactPlan[]> {
  let root: string;
  try {
    root = await realpath(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: ArtifactPlan[] = [];
  const directory = await opendir(root);
  let checked = 0;
  const budget = { remaining: MAX_FILES };
  try {
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (++checked > MAX_ENTRIES) throw limit();
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      try {
        out.push(await manifestPlan(root, kind, entry.name, signal, budget));
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof HttpError && error.status === 503) throw error;
        // Partial, removed, or unsafe directories never become downloadable.
      }
    }
  } finally {
    await directory.close().catch(() => {});
  }
  return out;
}

export async function openArtifactFile(
  plan: ArtifactPlan,
  file: ArtifactFile,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    const root = await lstat(plan.root, { bigint: true });
    const directory = await lstat(plan.directory, { bigint: true });
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      directoryIdentity(root) !== plan.rootIdentity ||
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      fileIdentity(directory) !== plan.directoryIdentity
    )
      throw artifactUnavailable();
    const path = await checkedPath(plan.directory, file.name);
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat({ bigint: true });
    const canonical = await realpath(path);
    if (
      !regular(stat) ||
      fileIdentity(stat) !== file.identity ||
      !inside(plan.directory, canonical) ||
      canonical !== resolve(path)
    )
      throw artifactUnavailable();
    return handle;
  } catch {
    await handle?.close().catch(() => {});
    throw artifactUnavailable();
  }
}

export async function verifyArtifactFile(handle: FileHandle, file: ArtifactFile): Promise<void> {
  const stat = await handle.stat({ bigint: true });
  if (!regular(stat) || fileIdentity(stat) !== file.identity) throw artifactUnavailable();
}

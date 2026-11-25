// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract, type Header } from "tar-stream";
import semver from "semver";
import {
  BACKUP_MANIFEST_NAME,
  BACKUP_FULL_MANIFEST_NAME,
  backupManifestSchema,
  backupScopeEntryFor,
  produceEncryptedArtifact,
  readEncryptedArtifactStream,
  type BackupManifest,
} from "@omnesis/core";

export interface DesktopBackupArchive {
  manifest: BackupManifest;
  files: ReadonlyMap<string, number>;
  sealedFiles: ReadonlyMap<string, { path: string; scope: string }>;
  sha256: string;
  bytes: number;
}
export interface DesktopArchiveLimits {
  maxBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxManifestBytes: number;
}
const limits: DesktopArchiveLimits = {
  maxBytes: 1024 ** 4,
  maxExpandedBytes: 1024 ** 4,
  maxEntries: 16384,
  maxFileBytes: 1024 ** 4,
  maxManifestBytes: 1024 ** 2,
};
const refusal = (): Error =>
  new Error("The selected file is not a complete supported Omnesis backup");

/** Internal boundary: caller allocates both paths inside its private, owned import slot. */
export async function extractDesktopBackupArchive(options: {
  archivePath: string;
  destination: string;
  sha256: string;
  bytes: number;
  currentVersion: string;
  signal: AbortSignal;
  limits?: Partial<DesktopArchiveLimits>;
  seal: { rootKey: string; scope: string };
  inputProtection?: { rootKey: string; scope: string };
}): Promise<DesktopBackupArchive> {
  const bound = { ...limits, ...options.limits };
  if (
    !Object.values(bound).every((value) => Number.isSafeInteger(value) && value > 0) ||
    !/^[a-f0-9]{64}$/u.test(options.sha256) ||
    !Number.isSafeInteger(options.bytes) ||
    options.bytes <= 0 ||
    options.bytes > bound.maxBytes ||
    !semver.valid(options.currentVersion)
  )
    throw refusal();
  options.signal.throwIfAborted();
  let archive: FileHandle | undefined;
  let ownsDestination = false;
  try {
    archive = await open(
      options.archivePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
    const before = await archive.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (options.inputProtection
        ? before.size < BigInt(options.bytes) || before.size > BigInt(options.bytes + 16_384)
        : before.size !== BigInt(options.bytes)) ||
      (before.mode & 0o077n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid()))
    )
      throw refusal();
    await mkdir(options.destination, { mode: 0o700 });
    ownsDestination = true;
    const tar = extract();
    const entries = new Map<string, { type: "file" | "directory"; bytes: number }>();
    const ancestors = new Set<string>();
    const sealedFiles = new Map<string, { path: string; scope: string }>();
    const hash = createHash("sha256");
    let seenBytes = 0;
    let expandedBytes = 0;
    let tail = Buffer.alloc(0);
    let root: string | undefined;
    let manifestRaw: Buffer | undefined;
    const consume = (async () => {
      for await (const entry of tar) {
        options.signal.throwIfAborted();
        const header = entry.header;
        const parts = safeName(header.name);
        root ??= parts[0]!;
        if (parts[0] !== root || entries.size >= bound.maxEntries) throw refusal();
        const rel = parts.slice(1).join("/");
        if (header.type !== "file" && header.type !== "directory") throw refusal();
        if (
          !Number.isSafeInteger(header.size) ||
          header.size < 0 ||
          header.size > bound.maxFileBytes ||
          (header.type === "directory" && header.size !== 0) ||
          (!rel && header.type !== "directory") ||
          entries.has(rel)
        )
          throw refusal();
        if (rel && !allowedEntry(rel, header)) throw refusal();
        // Refuse file/directory collisions regardless of entry order.
        for (let depth = 1; depth < parts.length - 1; depth++) {
          if (entries.get(parts.slice(1, depth + 1).join("/"))?.type === "file") throw refusal();
        }
        if (header.type === "file" && ancestors.has(rel)) throw refusal();
        for (let depth = 1; depth < parts.length - 1; depth++)
          ancestors.add(parts.slice(1, depth + 1).join("/"));
        entries.set(rel, { type: header.type, bytes: header.size });
        if (header.type === "directory") continue;
        expandedBytes += header.size;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > bound.maxExpandedBytes)
          throw refusal();
        if (rel === BACKUP_MANIFEST_NAME && header.size > bound.maxManifestBytes) throw refusal();
        // Logical names never become filesystem paths. Even legacy readable
        // stores and manifest notes are sealed before their first persisted byte.
        const target = join(
          options.destination,
          `entry-${String(entries.size).padStart(6, "0")}.enc`,
        );
        const scope = `${options.seal.scope}:entry:${entries.size}`;
        let written = 0;
        const chunks: Buffer[] = [];
        await produceEncryptedArtifact(
          target,
          { rootKey: options.seal.rootKey, scope },
          async (output) => {
            for await (const raw of entry) {
              options.signal.throwIfAborted();
              const chunk = Buffer.from(raw as Uint8Array);
              written += chunk.length;
              if (written > header.size) throw refusal();
              if (rel === BACKUP_MANIFEST_NAME) chunks.push(chunk);
              if (!output.write(chunk)) await once(output, "drain", { signal: options.signal });
            }
            if (written !== header.size) throw refusal();
          },
        );
        sealedFiles.set(rel, { path: target, scope });
        if (rel === BACKUP_MANIFEST_NAME) manifestRaw = Buffer.concat(chunks);
      }
    })();
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        seenBytes += chunk.length;
        if (seenBytes > options.bytes) return done(refusal());
        hash.update(chunk);
        tail = Buffer.concat([tail, chunk]).subarray(-1024);
        done(null, chunk);
      },
    });
    const protectedSource = options.inputProtection
      ? readEncryptedArtifactStream(options.archivePath, {
          rootKey: options.inputProtection.rootKey,
          expectedScope: options.inputProtection.scope,
          signal: options.signal,
          maxBytes: options.bytes + 16_384,
        })
      : null;
    const source = protectedSource
      ? Readable.from(protectedSource)
      : archive.createReadStream({ autoClose: false });
    const piping = pipeline(source, measure, tar, { signal: options.signal });
    // Both operations must be observed and drained before any extracted file is removed.
    const failure = consume.catch((error: unknown) => {
      tar.destroy(refusal());
      throw error;
    });
    const settled = await Promise.allSettled([piping, failure]);
    if (settled.some((result) => result.status === "rejected")) throw refusal();
    protectedSource?.authentication();
    const after = await archive.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n ||
      seenBytes !== options.bytes ||
      seenBytes % 512 !== 0 ||
      tail.length !== 1024 ||
      tail.some((byte) => byte !== 0) ||
      hash.digest("hex") !== options.sha256 ||
      !manifestRaw
    )
      throw refusal();
    const manifest = backupManifestSchema.parse(JSON.parse(manifestRaw.toString("utf8")));
    validateManifest(manifest, entries, options.currentVersion);
    return {
      manifest,
      sha256: options.sha256,
      bytes: seenBytes,
      sealedFiles,
      files: new Map(
        [...entries]
          .filter(([, value]) => value.type === "file")
          .map(([name, value]) => [name, value.bytes]),
      ),
    };
  } catch {
    if (ownsDestination) await rm(options.destination, { recursive: true, force: true });
    if (options.signal.aborted) options.signal.throwIfAborted();
    throw refusal();
  } finally {
    await archive?.close();
  }
}

function safeName(value: string): string[] {
  const name = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = name.split("/");
  if (
    Buffer.byteLength(value) > 1024 ||
    parts.length > 18 ||
    parts.some((part) => !part || part === "." || part === ".." || /[\\:\x00-\x1f\x7f]/u.test(part))
  )
    throw refusal();
  return parts;
}
function allowedEntry(rel: string, header: Header): boolean {
  if (header.type === "file")
    return (
      rel === BACKUP_MANIFEST_NAME ||
      rel === `${BACKUP_FULL_MANIFEST_NAME}.enc` ||
      importedScope(rel)?.kind === "store" ||
      importedScope(rel)?.kind === "config"
    );
  return (
    backupScopeEntryFor(rel)?.kind === "config" ||
    // Structural ancestors may be emitted before their manifest or child entries.
    rel === "keyring" ||
    !rel.includes("/")
  );
}
function validateManifest(
  manifest: BackupManifest,
  entries: ReadonlyMap<string, { type: "file" | "directory"; bytes: number }>,
  currentVersion: string,
): void {
  if (
    !semver.valid(manifest.version) ||
    semver.gt(manifest.version, currentVersion) ||
    !Number.isFinite(Date.parse(manifest.startedAt)) ||
    !Number.isFinite(Date.parse(manifest.finishedAt)) ||
    Date.parse(manifest.finishedAt) < Date.parse(manifest.startedAt)
  )
    throw refusal();
  const declared = new Set<string>();
  const declaredAncestors = new Set<string>();
  const directoryBytes = new Map<string, number>();
  for (const [name, entry] of entries) {
    if (entry.type !== "file") continue;
    const parts = name.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/");
      directoryBytes.set(parent, (directoryBytes.get(parent) ?? 0) + entry.bytes);
    }
  }
  for (const file of manifest.files) {
    const name = safeName(`root/${file.name}`).slice(1).join("/");
    if (
      name !== file.name ||
      declared.has(name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      (!importedScope(name) && name !== `${BACKUP_FULL_MANIFEST_NAME}.enc`) ||
      importedScope(name)?.kind === "derived"
    )
      throw refusal();
    declared.add(name);
    const parts = name.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      declaredAncestors.add(parts.slice(0, depth).join("/"));
    const actual = entries.get(name);
    if (!actual || (actual.type === "file" && actual.bytes !== file.bytes)) throw refusal();
    if (actual.type === "directory" && (directoryBytes.get(name) ?? 0) !== file.bytes)
      throw refusal();
  }
  if (!declared.has("omnesis.db") && !declared.has("omnesis.db.enc")) throw refusal();
  if (
    manifest.encryptedManifest &&
    (!declared.has(manifest.encryptedManifest) || !manifest.encryption)
  )
    throw refusal();
  for (const [name, entry] of entries) {
    if (!name || name === BACKUP_MANIFEST_NAME) continue;
    let covered = declared.has(name);
    const parts = name.split("/");
    for (let depth = 1; depth < parts.length && !covered; depth++)
      covered = declared.has(parts.slice(0, depth).join("/"));
    if (!covered && !(entry.type === "directory" && declaredAncestors.has(name))) throw refusal();
  }
}

function importedScope(name: string) {
  return backupScopeEntryFor(name.endsWith(".enc") ? name.slice(0, -4) : name);
}

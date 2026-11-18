// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { claimGuard, releaseGuard } from "./update-lock-guard.js";
import {
  createWindowsPrivateFileSync,
  readWindowsPrivateFileSync,
} from "./windows-private-file.js";

const PREFIX = ".child-join-";
const NAME =
  /^\.child-join-([a-f0-9]{64})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const MAX_BYTES = 1024;
const markerSchema = z
  .object({
    version: z.literal(1),
    ownerHash: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().uuid(),
  })
  .strict();

export interface UpdateLockChildJoin {
  /** Clear only after the exact owned child and its helpers have joined. */
  joined(): void;
}

interface Identity {
  dev: bigint;
  ino: bigint;
  birth: bigint;
}

function identity(path: string, kind: "file" | "directory"): Identity {
  const stat = lstatSync(path, { bigint: true });
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
    throw new Error("Could not verify the update lock child join protection.");
  return { dev: stat.dev, ino: stat.ino, birth: stat.birthtimeNs };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
}

function ownerHash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function readBoundedMarker(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Invalid update lock child join protection.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (size === 0) break;
      count += size;
    }
    if (count > MAX_BYTES) throw new Error("Invalid update lock child join protection.");
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function readMarker(lockDir: string, name: string) {
  const parsedName = NAME.exec(name);
  if (!parsedName) throw new Error("Invalid update lock child join protection.");
  const path = join(lockDir, name);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(MAX_BYTES))
    throw new Error("Invalid update lock child join protection.");
  const bytes =
    process.platform === "win32"
      ? readWindowsPrivateFileSync(path, MAX_BYTES)
      : readBoundedMarker(path);
  const value = markerSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (value.ownerHash !== parsedName[1] || value.nonce !== parsedName[2])
    throw new Error("Invalid update lock child join protection.");
  return value;
}

function fences(lockDir: string): { owners: Set<string>; unknown: boolean } {
  const owners = new Set<string>();
  try {
    for (const name of readdirSync(lockDir)) {
      if (name.startsWith(PREFIX)) owners.add(readMarker(lockDir, name).ownerHash);
    }
    return { owners, unknown: false };
  } catch {
    return { owners, unknown: true };
  }
}

/** No timestamp or process observation establishes completion of an owned child. */
export function hasPendingChildJoins(lockDir: string): boolean {
  try {
    return readdirSync(lockDir).some((name) => name.startsWith(PREFIX));
  } catch {
    return true;
  }
}

interface JoinAncestor {
  id: string;
  returnTo?: JoinAncestor;
}

/** Only the owner metadata's already-validated return chain grants ancestor authority. */
export function childJoinAncestorIds(ancestor?: JoinAncestor): string[] {
  const ids: string[] = [];
  for (; ancestor; ancestor = ancestor.returnTo) ids.push(ancestor.id);
  return ids;
}

export function childJoinRestriction(
  lockDir: string,
  id: string,
  ancestors: readonly string[],
): "none" | "own" | "unknown" {
  const state = fences(lockDir);
  const own = ownerHash(id);
  const allowed = new Set([own, ...ancestors.map(ownerHash)]);
  if (state.unknown || [...state.owners].some((hash) => !allowed.has(hash))) return "unknown";
  return state.owners.has(own) ? "own" : "none";
}

/** A resumed child may still have its verified ancestors waiting for that child's own exit. */
export function mayReclaimWithChildJoins(
  lockDir: string,
  id: string,
  currentId: string | undefined,
  ancestors: readonly string[],
): boolean {
  const state = fences(lockDir);
  if (state.unknown || state.owners.has(ownerHash(id))) return false;
  if (currentId !== undefined && state.owners.has(ownerHash(currentId))) return false;
  const allowed = new Set(ancestors.map(ownerHash));
  return [...state.owners].every((hash) => allowed.has(hash));
}

/** The owner verifier runs only while the existing claim guard is held. */
export function beginChildJoin(
  lockDir: string,
  id: string,
  readOwnerIdentity: () => { id: string; ancestors: readonly string[] } | null,
): UpdateLockChildJoin {
  const claim = claimGuard(lockDir);
  if (!claim) throw new Error("Could not protect the update lock before starting its child.");
  try {
    const generation = identity(lockDir, "directory");
    const owner = readOwnerIdentity();
    if (
      !owner ||
      owner.id !== id ||
      childJoinRestriction(lockDir, id, owner.ancestors) === "unknown"
    )
      throw new Error("Could not verify ownership before starting an update child.");
    const value = { version: 1 as const, ownerHash: ownerHash(id), nonce: randomUUID() };
    const name = `${PREFIX}${value.ownerHash}-${value.nonce}`;
    const path = join(lockDir, name);
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (process.platform === "win32") createWindowsPrivateFileSync(path, bytes);
    else writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    const marker = identity(path, "file");
    const persisted = readMarker(lockDir, name);
    if (
      persisted.ownerHash !== value.ownerHash ||
      persisted.nonce !== value.nonce ||
      !sameIdentity(marker, identity(path, "file")) ||
      !sameIdentity(generation, identity(lockDir, "directory"))
    )
      throw new Error("The update lock changed while protecting its child.");
    let cleared = false;
    return {
      joined(): void {
        if (cleared) return;
        const clearClaim = claimGuard(lockDir);
        if (!clearClaim) throw new Error("Could not finish the update lock child join protection.");
        try {
          if (
            !sameIdentity(generation, identity(lockDir, "directory")) ||
            !sameIdentity(marker, identity(path, "file"))
          )
            throw new Error("The update lock child join protection changed.");
          const current = readMarker(lockDir, name);
          if (
            current.ownerHash !== value.ownerHash ||
            current.nonce !== value.nonce ||
            !sameIdentity(generation, identity(lockDir, "directory")) ||
            !sameIdentity(marker, identity(path, "file"))
          )
            throw new Error("The update lock child join protection changed.");
          unlinkSync(path);
          cleared = true;
        } finally {
          releaseGuard(clearClaim);
        }
      },
    };
  } finally {
    releaseGuard(claim);
  }
}

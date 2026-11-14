// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, opendir, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { ensurePrivateDirs, inspectWindowsPrivatePaths } from "@omnesis/core";

type WindowsPrivatePath = Parameters<typeof inspectWindowsPrivatePaths>[0][number];

interface AuthOwner {
  home: string;
  path: string;
}
// Only the trusted pool binds this context. It is not a runtime option or a
// value accepted from configuration, model tools, or the child environment.
const poolOwners = new WeakMap<object, AuthOwner>();
export function bindCodexPoolAuthOwner(runtime: object, home: string): void {
  poolOwners.set(runtime, { home, path: join(home, "auth.json") });
}
export function codexPoolAuthOwner(runtime: object): Readonly<AuthOwner> | undefined {
  return poolOwners.get(runtime);
}

const MAX_ENTRIES = 50_000;
const MAX_BATCH_PATHS = 512;
const MAX_BATCH_BYTES = 256 * 1024;

/** Dedicated product-owned state only; never an operator's general workspace. */
export async function prepareCodexPrivateState(
  roots: readonly string[],
  authReference?: { home: string; target: string },
): Promise<void> {
  const ownedRoots = [...new Set(roots.map((root) => resolve(root)))];
  // Reject pre-existing aliases before mkdir can create anything beneath one.
  // Native checks then independently pin and validate ownership and ACLs.
  for (const root of ownedRoots) {
    for (let ancestor = root; ; ancestor = dirname(ancestor)) {
      try {
        const info = await lstat(ancestor);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Codex runtime root contains an untrusted directory alias");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          throw error;
      }
      if (dirname(ancestor) === ancestor) break;
    }
  }
  await ensurePrivateDirs(ownedRoots);
  const pending = [...ownedRoots].reverse();
  const seen = new Set<string>();
  let paths: WindowsPrivatePath[] = [],
    bytes = 0;
  const flush = async (): Promise<void> => {
    if (paths.length === 0) return;
    const result = await inspectWindowsPrivatePaths(paths, { repair: true, protect: true });
    if (result.length !== paths.length || result.some((status) => !status.private))
      throw new Error("Codex runtime state could not be verified as private");
    paths = [];
    bytes = 0;
  };
  const enqueue = async (path: string, kind: WindowsPrivatePath["kind"]): Promise<void> => {
    const size = Buffer.byteLength(JSON.stringify({ path, kind }), "utf8");
    if (paths.length >= MAX_BATCH_PATHS || bytes + size > MAX_BATCH_BYTES) await flush();
    paths.push({ path, kind });
    bytes += size;
  };
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (seen.size > MAX_ENTRIES)
      throw new Error("Codex private state exceeds the bounded inspection limit");
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      if (
        !authReference ||
        path !== resolve(authReference.home, "auth.json") ||
        resolve(dirname(path), await readlink(path)) !== resolve(authReference.target)
      )
        throw new Error("Codex runtime state contains an untrusted symbolic link");
      // Inspect the known owner file through its own native held-handle
      // boundary, never by following the member's reparse point.
      await enqueue(authReference.target, "file");
    } else if (info.isDirectory()) {
      await enqueue(path, "directory");
      // Preorder inspection repairs a parent before its children. Native
      // inspection independently rejects reparse points and untrusted owners.
      // Stream directory names so a single oversized directory cannot force
      // an unbounded allocation before the entry limit is enforced. Async
      // iteration closes the directory even when enumeration fails.
      for await (const entry of await opendir(path)) {
        if (seen.size + pending.length >= MAX_ENTRIES)
          throw new Error("Codex private state exceeds the bounded inspection limit");
        pending.push(join(path, entry.name));
      }
    } else if (info.isFile()) await enqueue(path, "file");
    else throw new Error("Codex runtime state contains a non-regular entry");
    if (seen.size % 128 === 0) await setImmediate();
  }
  await flush();
}

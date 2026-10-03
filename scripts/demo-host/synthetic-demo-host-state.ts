// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const MAX_PAIRING_BYTES = 64 * 1024;
const pairingSchema = z.object({
  device: z.object({ id: z.string().min(1).max(128) }),
  token: z.string().min(1).max(8192),
  universe: z.string().min(1),
  gatewayUrl: z.url(),
});
export type DemoPairingState = z.infer<typeof pairingSchema>;
export interface DemoHostState {
  dir: string;
  saved: DemoPairingState | undefined;
  save(value: unknown): DemoPairingState;
}

function statIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireDirectory(path: string, create = false): void {
  const stat = statIfPresent(path);
  if (!stat && create) {
    mkdirSync(path, { mode: 0o700 });
    return;
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new Error("Demo host state requires owned directories without symlinks");
}

function requirePairingLeaf(path: string): void {
  const stat = statIfPresent(path);
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    throw new Error("Demo pairing state must be a regular file without symlinks");
}

function parsePairing(value: unknown): DemoPairingState {
  const parsed = pairingSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid demo pairing state");
  return parsed.data;
}

function readPairing(path: string): DemoPairingState | undefined {
  requirePairingLeaf(path);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PAIRING_BYTES || (stat.mode & 0o077) !== 0)
      throw new Error("Demo pairing state must be a bounded private regular file");
    const data = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new Error("Demo pairing state changed while reading");
    let raw: unknown;
    try {
      raw = JSON.parse(data.subarray(0, length).toString("utf8")) as unknown;
    } catch {
      throw new Error("Invalid demo pairing JSON");
    }
    return parsePairing(raw);
  } finally {
    closeSync(fd);
  }
}

/** Preflight every roster path and saved credential before the caller pairs any device. */
export function prepareDemoHostStates(
  configDir: string,
  deviceIds: readonly string[],
): Map<string, DemoHostState> {
  if (
    new Set(deviceIds).size !== deviceIds.length ||
    deviceIds.some((id) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id))
  )
    throw new Error("Demo roster ids must be distinct safe single path components");
  const config = resolve(configDir),
    root = join(config, "demo-hosts");
  requireDirectory(config);
  requireDirectory(root, true);
  const states = new Map<string, DemoHostState>();
  for (const id of deviceIds) {
    const dir = join(root, id),
      path = join(dir, "pairing.json");
    requireDirectory(dir, true);
    const saved = readPairing(path);
    states.set(id, {
      dir,
      saved,
      save(value) {
        requireDirectory(config);
        requireDirectory(root);
        requireDirectory(dir);
        requirePairingLeaf(path);
        const parsed = parsePairing(value),
          encoded = JSON.stringify(parsed);
        if (Buffer.byteLength(encoded) > MAX_PAIRING_BYTES)
          throw new Error("Demo pairing state exceeds its byte limit");
        const temporary = join(dir, `.pairing-${randomUUID()}.tmp`);
        const fd = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          try {
            if (!fstatSync(fd).isFile())
              throw new Error("Demo pairing temporary state must be a regular file");
            writeFileSync(fd, encoded);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          requirePairingLeaf(path);
          renameSync(temporary, path);
        } finally {
          if (statIfPresent(temporary)) unlinkSync(temporary);
        }
        return parsed;
      },
    });
  }
  return states;
}

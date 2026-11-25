// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const CPU = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

/** Architectures in a thin or universal Mach-O, or null for a non-Mach-O file. */
export function machoArchitectures(bytes) {
  if (bytes.length < 4) return null;
  const magic = bytes.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
    if (bytes.length < 12) throw new Error("Truncated Mach-O header");
    const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
    const cpu = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
    return [CPU.get(cpu) ?? `unsupported-${cpu.toString(16)}`];
  }
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return null;
  if (bytes.length < 8) throw new Error("Truncated universal Mach-O header");
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const read = (at) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const count = read(4);
  const stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
  if (count < 1 || count > 32 || bytes.length < 8 + stride * count)
    throw new Error("Invalid universal Mach-O architecture table");
  return Array.from({ length: count }, (_, index) => {
    const cpu = read(8 + index * stride);
    return CPU.get(cpu) ?? `unsupported-${cpu.toString(16)}`;
  });
}

export function assertWithin(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Bundle path escapes its root: ${path}`);
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Sorted, portable inventory; no absolute build paths or wall-clock stamps. */
export async function inventoryBundle(root, architecture) {
  if (!["arm64", "x64"].includes(architecture)) throw new Error("Unsupported desktop architecture");
  const canonicalRoot = await realpath(root);
  const records = [];
  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const entry = await lstat(path);
      const local = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target)) throw new Error(`Absolute bundle symlink: ${local}`);
        assertWithin(canonicalRoot, await realpath(path));
        records.push({ path: local, symlink: target });
      } else if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const file = await open(path, "r");
        let architectures;
        try {
          const header = Buffer.alloc(1032);
          const { bytesRead } = await file.read(header, 0, header.length, 0);
          const bytes = header.subarray(0, bytesRead);
          if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x7f454c46)
            throw new Error(`Non-macOS ELF binary in ${local}`);
          if (/\.(?:exe|dll|so)$/u.test(name))
            throw new Error(`Non-macOS native artifact in ${local}`);
          architectures = machoArchitectures(bytes);
        } finally {
          await file.close();
        }
        if (architectures && !architectures.includes(architecture))
          throw new Error(`Wrong native architecture in ${local}: ${architectures.join(", ")}`);
        if (/\.(?:node|dylib)$/u.test(name) && !architectures)
          throw new Error(`Non-macOS native module in ${local}`);
        records.push({
          path: local,
          bytes: entry.size,
          executable: Boolean(entry.mode & 0o111),
          sha256: await hashFile(path),
          ...(architectures ? { architectures } : {}),
        });
      } else throw new Error(`Unsupported bundle file: ${local}`);
    }
  };
  await visit(root);
  return records;
}

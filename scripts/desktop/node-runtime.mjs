// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashFile } from "./native-inventory.mjs";

export const NODE_RUNTIME = JSON.parse(
  await readFile(new URL("./node-runtime.json", import.meta.url), "utf8"),
);

export function nodeArchiveSpec(architecture) {
  const sha256 = NODE_RUNTIME.darwin[architecture];
  if (!Object.hasOwn(NODE_RUNTIME.darwin, architecture))
    throw new Error(`Unsupported desktop architecture: ${architecture}`);
  const filename = `node-v${NODE_RUNTIME.version}-darwin-${architecture}.tar.gz`;
  return {
    filename,
    sha256,
    url: `https://nodejs.org/download/release/v${NODE_RUNTIME.version}/${filename}`,
  };
}

/** Download only the official pinned archive; cached files are verified again. */
export async function acquireNodeArchive(architecture, cache, fetchArchive = fetch) {
  const spec = nodeArchiveSpec(architecture);
  await mkdir(cache, { recursive: true });
  const path = join(cache, spec.filename);
  try {
    if ((await hashFile(path)) === spec.sha256) return path;
    throw new Error(`Cached Node archive checksum mismatch: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.download-${randomUUID()}`;
  try {
    const response = await fetchArchive(spec.url, { redirect: "error" });
    if (!response.ok) throw new Error(`Node archive download failed: ${response.status}`);
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
    if ((await hashFile(temporary)) !== spec.sha256)
      throw new Error("Node archive checksum mismatch");
    await rename(temporary, path);
    return path;
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Extraction follows checksum validation; untrusted archives are never expanded. */
export async function extractNodeArchive(archive, architecture, output, run = execFileSync) {
  const spec = nodeArchiveSpec(architecture);
  if ((await hashFile(archive)) !== spec.sha256) throw new Error("Node archive checksum mismatch");
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  try {
    run("tar", ["-xzf", archive, "--strip-components=1", "-C", output], { stdio: "inherit" });
    return output;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

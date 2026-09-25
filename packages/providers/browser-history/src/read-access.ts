// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { probeFileReadAccess, type SourceReadAccessResult } from "@omnesis/source-sdk";

// Hard health-check ceilings, not limits on what ordinary browser sync indexes.
const MAX_PROFILE_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_READ_ACCESS_PROFILES = 256;
const METADATA_READ_CHUNK_BYTES = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fresh discovery metadata only; History contents are never read or queried. */
export async function probeChromiumReadAccess(
  baseDir: string,
  excludedProfiles: readonly string[],
  { signal }: { signal: AbortSignal },
): Promise<SourceReadAccessResult> {
  if (signal.aborted) return { status: "unavailable" };
  try {
    const handle = await open(
      join(baseDir, "Local State"),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    let metadata: unknown;
    try {
      if (signal.aborted) return { status: "unavailable" };
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_PROFILE_METADATA_BYTES)
        return { status: "unavailable" };
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (!signal.aborted) {
        const chunk = Buffer.alloc(
          Math.min(METADATA_READ_CHUNK_BYTES, MAX_PROFILE_METADATA_BYTES + 1 - bytes),
        );
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (signal.aborted) return { status: "unavailable" };
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > MAX_PROFILE_METADATA_BYTES) return { status: "unavailable" };
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (signal.aborted) return { status: "unavailable" };
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        return { status: "unavailable" };
      metadata = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)),
      );
    } finally {
      // Retain ownership through cancellation until a late-opened handle closes.
      await handle.close();
    }
    if (
      signal.aborted ||
      !record(metadata) ||
      !record(metadata.profile) ||
      !record(metadata.profile.info_cache)
    )
      return { status: "unavailable" };
    const profiles = Object.entries(metadata.profile.info_cache);
    if (profiles.length === 0 || profiles.length > MAX_READ_ACCESS_PROFILES)
      return { status: "unavailable" };
    const paths: string[] = [];
    for (const [dir, info] of profiles) {
      if (
        !dir ||
        dir === "." ||
        dir === ".." ||
        basename(dir) !== dir ||
        dir.includes("\\") ||
        dir.includes("\0") ||
        !record(info)
      )
        return { status: "unavailable" };
      if (
        (info.user_name !== undefined && typeof info.user_name !== "string") ||
        (info.name !== undefined && typeof info.name !== "string")
      )
        return { status: "unavailable" };
      const name = info.user_name || info.name || dir;
      if (typeof name !== "string") return { status: "unavailable" };
      if (!excludedProfiles.includes(name)) paths.push(join(baseDir, dir, "History"));
    }
    if (paths.length === 0) return { status: "unavailable" };
    for (const path of paths) {
      const result = await probeFileReadAccess(path, { signal });
      if (result.status !== "readable") return result;
    }
    return { status: signal.aborted ? "unavailable" : "readable" };
  } catch (error) {
    const code = record(error) ? error.code : undefined;
    return {
      status: !signal.aborted && (code === "EACCES" || code === "EPERM") ? "denied" : "unavailable",
    };
  }
}

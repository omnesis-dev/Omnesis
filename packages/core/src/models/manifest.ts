// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Local model manifest — `<modelsDir>/manifest.json`. Records which
 * GGUF files are actually on disk, with their hashes, sizes, and
 * provenance. The catalog is "what models exist that we know about";
 * the manifest is "what's on this machine right now."
 *
 * Anthropic API entries don't appear in the manifest — there's nothing
 * on disk to record. Their assignment lives in `inference.assignments`.
 *
 * Format is intentionally simple and forward-compatible:
 *   { version: 1, models: [{ id, filename, sizeBytes, sha256, ... }] }
 *
 * Reads are crash-safe: a missing file yields the empty manifest, a
 * malformed file yields the empty manifest plus a single warning. We
 * never throw on read — model management has to keep working even if
 * the manifest got truncated by a power loss.
 */

import { readFileSync, existsSync } from "node:fs";
import { createLogger } from "../logger.js";
import { atomicWriteFileSync } from "../atomic-write.js";
import type { Manifest, ManifestEntry } from "./types.js";

const log = createLogger("core:models:manifest");

const EMPTY: Manifest = { version: 1, models: [] };

export interface LoadResult {
  manifest: Manifest;
  /**
   * @deprecated The corruption case is now logged at the point of
   * detection inside `loadManifest`. Callers no longer need to surface
   * this — the field is kept on the type so existing call sites keep
   * compiling, but newly-written code shouldn't read it. Will be
   * removed once all callers are audited.
   */
  warning?: string;
}

/**
 * Read the manifest at `path`. Never throws — a missing or malformed
 * file yields `EMPTY`. Corruption is logged here (not returned as a
 * `warning` string the caller has to remember to log) so a
 * power-loss-truncated `manifest.json` produces an operator-visible
 * signal even when a caller forgets to plumb the field through. Pre-fix
 * the resolver consumed `ctx.manifest` without ever surfacing the
 * corruption warning, so a missing model could equally be "GGUF file
 * deleted" or "manifest itself is corrupted" — operators had no way
 * to disambiguate.
 */
export function loadManifest(path: string): LoadResult {
  if (!existsSync(path)) return { manifest: EMPTY };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const warning = `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(warning);
    return { manifest: EMPTY, warning };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const warning = `manifest at ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); treating as empty`;
    log.warn(warning);
    return { manifest: EMPTY, warning };
  }
  if (!isManifest(parsed)) {
    const warning = `manifest at ${path} has unexpected shape; treating as empty`;
    log.warn(warning);
    return { manifest: EMPTY, warning };
  }
  return { manifest: parsed };
}

/**
 * Atomically write the manifest. Creates parent dir if needed.
 * `atomicWriteFileSync` adds the fsync-then-rename-then-fsync-dir
 * sequence so a power loss after `omnesis cli model add` can't leave
 * the manifest pointing at a partially-written file (and inverse: the
 * GGUF download is durable on disk before the manifest entry, so a
 * crash mid-write doesn't lose the just-downloaded model — just makes
 * it look unrecorded, which a `cli model verify` rebuilds).
 */
export function saveManifest(path: string, manifest: Manifest): void {
  atomicWriteFileSync(path, JSON.stringify(manifest, null, 2), {
    ensureDir: true,
  });
}

/** Add or replace an entry by id. Returns the new manifest (does not mutate). */
export function upsertManifestEntry(manifest: Manifest, entry: ManifestEntry): Manifest {
  const others = manifest.models.filter((m) => m.id !== entry.id);
  return { ...manifest, models: [...others, entry] };
}

/** Remove an entry by id. Returns the new manifest (does not mutate). */
export function removeManifestEntry(manifest: Manifest, id: string): Manifest {
  return {
    ...manifest,
    models: manifest.models.filter((m) => m.id !== id),
  };
}

/** Find a manifest entry by id. */
export function findManifestEntry(manifest: Manifest, id: string): ManifestEntry | undefined {
  return manifest.models.find((m) => m.id === id);
}

/**
 * Find the manifest entry whose filename matches. Used when resolving
 * a GGUF filename to the installed model's manifest record.
 */
export function findManifestEntryByFilename(
  manifest: Manifest,
  filename: string,
): ManifestEntry | undefined {
  return manifest.models.find((m) => m.filename === filename);
}

function isManifest(x: unknown): x is Manifest {
  if (!x || typeof x !== "object") return false;
  const m = x as { version?: unknown; models?: unknown };
  if (m.version !== 1) return false;
  if (!Array.isArray(m.models)) return false;
  return m.models.every(isManifestEntry);
}

function isManifestEntry(x: unknown): x is ManifestEntry {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.filename === "string" &&
    typeof m.sizeBytes === "number" &&
    typeof m.sha256 === "string" &&
    typeof m.downloadedAt === "string"
  );
}

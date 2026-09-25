// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Versioned vector-read router.
 *
 * The search read path obtains its HNSW handle here instead of opening one
 * fixed file at a hardcoded dimension. The registry follows the
 * `active_version` pointer in `index_meta`: before each search it does one
 * cheap PK lookup of the active generation and, when the pointer moves (a
 * future atomic flip after a double-buffered rebuild), lazily opens a fresh
 * {@link UsearchReadHandle} on that generation's own usearch file at that
 * generation's OWN embedding dimension — never a global constant. This is
 * the structural piece that lets a later chunk hot-swap which model serves
 * reads with no gateway restart and no stale-dimension read.
 *
 * With a single active generation (today) it is behaviour-identical to
 * opening `index.usearch` directly: version 1 resolves to the legacy path
 * (see `usearchPathForVersion`) and the worker still writes there. When no
 * generation has been adopted yet (a brand-new install before the worker's
 * first stamp), it serves the legacy path at the default dimension — exactly
 * the prior behaviour — and self-fills once the writer produces a file.
 */

import { createLogger } from "@omnesis/core";

import {
  EMBEDDING_DIM,
  getActiveIndexVersion,
  getIndexVersion,
  usearchPathForVersion,
} from "./db.js";
import { UsearchReadHandle, type VectorReadSource } from "./usearch-index.js";
import type Database from "better-sqlite3";

const log = createLogger("gateway:usearch").child("registry");

/**
 * Resolve the on-disk usearch file + embedding dimension for a given index
 * generation (or the legacy path + default dim when `version` is null). Shared
 * by the read registry and the boot-time crash-safe guard so both agree on
 * exactly which file/dim the gateway is about to open.
 */
function usearchTargetForVersion(
  db: Database.Database,
  configDir: string,
  version: number | null,
): { path: string; dim: number } {
  const path = usearchPathForVersion(configDir, version);
  let dim = EMBEDDING_DIM;
  if (version != null) {
    const row = getIndexVersion(db, version);
    if (row) dim = row.embed_dim;
  }
  return { path, dim };
}

/** Resolve the file + dim for the currently active generation (the one boot opens). */
export function resolveActiveUsearchTarget(
  db: Database.Database,
  configDir: string,
): { path: string; dim: number } {
  return usearchTargetForVersion(db, configDir, getActiveIndexVersion(db));
}

export class UsearchReadRegistry implements VectorReadSource {
  private handle: UsearchReadHandle;
  private currentVersion: number | null;
  private readonly activeVersionStmt;

  constructor(
    private readonly db: Database.Database,
    private readonly configDir: string,
  ) {
    this.activeVersionStmt = db.prepare<[], { value: string }>(
      "SELECT value FROM index_meta WHERE key = 'active_version'",
    );
    const active = this.readActiveVersion();
    this.handle = this.openForVersion(active);
    this.currentVersion = active;
  }

  /** Cheap PK lookup of the active generation (null until one is adopted). */
  private readActiveVersion(): number | null {
    const row = this.activeVersionStmt.get();
    if (!row) return null;
    const v = Number(row.value);
    return Number.isInteger(v) && v > 0 ? v : null;
  }

  private targetForVersion(version: number | null): { path: string; dim: number } {
    return usearchTargetForVersion(this.db, this.configDir, version);
  }

  private openForVersion(version: number | null): UsearchReadHandle {
    const { path, dim } = this.targetForVersion(version);
    const handle = UsearchReadHandle.open(path, dim);
    log.info(
      `read handle bound to index generation ${version ?? "(none)"} @ dim ${dim}: ${handle.size()} vectors`,
    );
    return handle;
  }

  /**
   * Re-bind to the active generation if the pointer moved, then re-view the
   * underlying file. The active-version read is a single PK lookup; in the
   * steady state (pointer unchanged) this just delegates to the handle's own
   * mtime-gated `maybeRefresh()`.
   */
  maybeRefresh(): void {
    const active = this.readActiveVersion();
    if (active !== this.currentVersion) {
      const { path, dim } = this.targetForVersion(active);
      if (this.handle.rebind(path, dim)) {
        this.currentVersion = active;
        log.info(
          `read handle bound to index generation ${active ?? "(none)"} @ dim ${dim}: ${this.handle.size()} vectors`,
        );
      }
    }
    this.handle.maybeRefresh();
  }

  search(vector: Float32Array, k: number): Array<{ key: bigint; distance: number }> {
    return this.handle.search(vector, k);
  }

  /**
   * Embedding-model identifier of the currently-bound active generation, read
   * from its `index_versions` row, or null before any generation is adopted.
   * The candidate-generation core uses it to detect a same-dimension embedder
   * swap (two models sharing a dim won't make `usearch.search` throw) and
   * degrade to BM25 instead of ranking against a stale generation's vectors.
   */
  activeModelId(): string | null {
    if (this.currentVersion == null) return null;
    const row = getIndexVersion(this.db, this.currentVersion);
    return row?.embed_model ?? null;
  }

  size(): number {
    return this.handle.size();
  }

  close(): void {
    this.handle.close();
  }
}

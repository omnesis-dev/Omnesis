// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boot-time crash-safe validator for an on-disk usearch HNSW sidecar.
 *
 * Spawned as a short-lived subprocess by `quarantineCorruptUsearch` before the
 * gateway opens the sidecar in-process. A structurally corrupt HNSW file makes
 * the native `usearch` `load()`/`view()` *abort the process* (SIGABRT:
 * `free(): corrupted unsorted chunks`) instead of throwing — so the only safe
 * way to probe a suspect file is in a throwaway process whose death the parent
 * can observe. This process exits:
 *
 *   - 0  → the file loaded cleanly at the expected dimension (safe to open)
 *   - 1  → a catchable error (wrong dimension, unreadable) — treat as corrupt
 *   - 2  → bad invocation (missing args)
 *   - (killed by signal) → native abort — the corruption fingerprint
 *
 * Argv: <usearchFilePath> <expectedDimension>. Never import this module; it is
 * only ever the spawned entry point.
 */

import { validateUsearchFile } from "./usearch-index.js";

const path = process.argv[2];
const dimStr = process.argv[3];
const dim = Number(dimStr);

if (!path || !dimStr || !Number.isInteger(dim) || dim <= 0) {
  process.exit(2);
}

try {
  validateUsearchFile(path, dim);
  process.exit(0);
} catch {
  // Catchable failure (wrong dimension / unreadable). A structurally corrupt
  // file never reaches here — it aborts the process inside load().
  process.exit(1);
}

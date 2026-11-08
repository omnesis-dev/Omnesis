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
 *   - `USEARCH_FILE_REJECTED_EXIT_CODE` → the file was refused with a catchable
 *     error (wrong dimension, unreadable); the reason goes to stderr
 *   - 2  → bad invocation (missing args)
 *   - (killed by signal) → native abort — the corruption fingerprint
 *
 * Exit 1 is deliberately not part of this contract: it is what Node reports for
 * anything that goes wrong before this module runs, such as a failed import, and
 * says nothing about the file.
 *
 * Argv: <usearchFilePath> <expectedDimension>. Never import this module; it is
 * only ever the spawned entry point.
 */

import { USEARCH_FILE_REJECTED_EXIT_CODE } from "./usearch-boot-guard.js";
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
} catch (err) {
  // Catchable failure (wrong dimension / unreadable). A structurally corrupt
  // file may never reach here — it can abort the process inside load().
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(USEARCH_FILE_REJECTED_EXIT_CODE);
}

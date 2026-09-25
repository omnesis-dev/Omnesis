// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EMBEDDING_DIM } from "./db.js";
import type { ResolvedAssignment } from "@omnesis/core";

/**
 * The canonical identity of the embedding model an index was built under:
 * the `(name, dim)` pair stamped into `index_meta` and compared on worker
 * boot to decide whether a re-embed is needed.
 *
 * This is the SINGLE producer of that pair. Both the live boot path
 * (`IndexerLifecycle.startIndexer` → the worker's `IndexerInit.modelName` /
 * `embedDim`, which the worker stamps and later compares) and the swap path
 * (`IndexerLifecycle.runEmbedSwap` → the stamp written by
 * `wipeAndRecreateVectorIndex`) call this. Routing both through one function
 * is what makes the writer's stamp and the reader's comparison agree by
 * construction — the class of "the swap stamps a backend-prefixed label
 * while the boot check compares the bare served model, so every boot after an
 * HTTP-embedder swap re-wipes a perfectly valid index" cannot recur.
 *
 * `name` semantics by kind:
 *   - local: the catalog filename (or catalog id) — already stable across
 *     both paths today, kept identical here.
 *   - http: the **served** model id reported by the embedder probe (not the
 *     configured `resolved.model`, which may be empty for auto-discovery, and
 *     not a `<backend>/<model>` composite). The served id is what the boot
 *     path already stamps, so existing installs need no migration.
 *
 * `dim` is the EFFECTIVE embedding dimension — the one vectors are actually
 * produced at — taken consistently on both paths so the dimension axis of the
 * stamp can never drift either:
 *   - local: the catalog `embedDim` (or {@link EMBEDDING_DIM} when unknown).
 *   - http: the native dimension reported by the probe.
 */
export function canonicalEmbedIdentity(
  resolved: ResolvedAssignment,
  opts?: { httpServedModel?: string; httpNativeDim?: number },
): { name: string; dim: number } {
  if (resolved.kind === "local") {
    return {
      name: resolved.catalogEntry?.filename ?? resolved.catalogId,
      dim: resolved.embedDim ?? EMBEDDING_DIM,
    };
  }
  if (resolved.kind === "http") {
    const name = opts?.httpServedModel ?? resolved.model;
    if (!name) {
      throw new Error(
        "canonicalEmbedIdentity(http): no served model id — pass the probe's model (auto-discovery yields an empty resolved.model)",
      );
    }
    if (opts?.httpNativeDim == null) {
      throw new Error(
        "canonicalEmbedIdentity(http): missing httpNativeDim from the embedder probe",
      );
    }
    return { name, dim: opts.httpNativeDim };
  }
  throw new Error(`canonicalEmbedIdentity: unsupported embedder kind "${resolved.kind}"`);
}

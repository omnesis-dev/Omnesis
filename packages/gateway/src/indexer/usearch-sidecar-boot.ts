// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  getIndexEmbedModel,
  getVectorChangesPrunedThrough,
  getVectorWriteSeq,
  purgeUsearchSidecars,
  setUsearchBackfillCursor,
  setUsearchSavedChangeSeq,
  setUsearchSavedSeq,
} from "./db.js";
import { resolveActiveUsearchTarget } from "./usearch-read-registry.js";
import { purgeSidecarTemps, restoreActiveSidecar } from "./usearch-sidecar-crypto.js";
import type Database from "better-sqlite3";

/**
 * Boot step on an encrypted install, before the read registry or the indexer
 * worker opens the graph. Under encryption the plaintext graph is never
 * durable — only its encrypted sidecar is — so every plaintext working file
 * and crypto temp is purged (the purge keeps `.enc`), and the ACTIVE
 * generation's graph is decrypted from its sidecar only when the worker can
 * bring it level with index.db (see `restoreActiveSidecar`). A restored graph
 * is the sidecar's, not whatever the previous process last saved, so the
 * sidecar's fingerprint is stamped as the file's: the worker then catches it
 * up, or resumes its rebuild, from exactly where the sidecar left off, and a
 * shutdown right after an idle restore-boot can still re-encrypt it. Otherwise
 * no plaintext file is left and the worker rebuilds from `chunks.embedding` —
 * never a re-embed, never an index wipe.
 */
export function prepareEncryptedGraphForBoot(
  indexDb: Database.Database,
  configDir: string,
  indexDbKey: Buffer | null,
): ReturnType<typeof restoreActiveSidecar> {
  purgeUsearchSidecars(configDir);
  purgeSidecarTemps(configDir);
  if (!indexDbKey) return { restored: false, reason: "no index-db key" };
  const activeTarget = resolveActiveUsearchTarget(indexDb, configDir);
  const restore = restoreActiveSidecar({
    encPath: `${activeTarget.path}.enc`,
    plaintextPath: activeTarget.path,
    indexDbKey,
    expectedSeq: getVectorWriteSeq(indexDb),
    expectedModel: getIndexEmbedModel(indexDb),
    changesPrunedThrough: getVectorChangesPrunedThrough(indexDb),
  });
  if (restore.restored) {
    setUsearchSavedSeq(indexDb, restore.seq ?? getVectorWriteSeq(indexDb));
    setUsearchSavedChangeSeq(indexDb, restore.changeSeq ?? null);
    setUsearchBackfillCursor(indexDb, restore.backfillCursor ?? null);
  }
  return restore;
}

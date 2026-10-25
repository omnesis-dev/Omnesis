// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseClaimMarkup } from "./claims.js";
import { assertKnowledgeMarkdown } from "./markdown-authoring.js";
import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import { readKnowledgeNodeRow } from "./storage-read.js";
import { validateKnowledgeDependencies } from "./storage-validation.js";
import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import type Database from "better-sqlite3";

/** Shared by cheap admission and the final writer transaction. */
export function assertKnowledgeSaveIdentity(db: Database.Database, input: SaveKnowledgeNodeInput) {
  const existing = readKnowledgeNodeRow(db, input.id);
  // An update receipt must not reveal whether its target was deleted, hidden,
  // withdrawn, or never existed. Apply this before revision/owner diagnostics
  // at both cheap admission and the final writer boundary.
  if (
    db.prepare("SELECT 1 FROM knowledge_node_tombstones WHERE id=?").get(input.id) ||
    (existing && JSON.parse(existing.fields_json).withdrawn === true) ||
    (existing && knowledgeNodeFence(db, input.id).hidden) ||
    (!existing && input.expectedRevision > 0)
  )
    throw new KnowledgeStorageError("reference_invalid", "Synthesis page is unavailable");
  if ((existing?.revision ?? 0) !== input.expectedRevision)
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Node revision changed; fetch the current page before revising it",
    );
  if (existing && (existing.kind !== input.kind || existing.owner_id !== (input.ownerId ?? null)))
    throw new KnowledgeStorageError(
      "claim_invalid",
      "A node cannot change kind or canonical owner",
    );
  if (
    input.kind === "root" &&
    db.prepare("SELECT 1 FROM knowledge_nodes WHERE kind='root' AND id!=?").get(input.id)
  )
    throw new KnowledgeStorageError("root_conflict", "The Brain already has a root wiki");
  return existing;
}

/** Reject already-stale proposals before any paid gate or entailment call. */
export function assertKnowledgeSavePreflight(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  fence?: KnowledgeRunFence,
): void {
  db.transaction(() => {
    assertKnowledgeRunFence(db, fence);
    assertKnowledgeSaveIdentity(db, input);
    const parsed = parseClaimMarkup(input.markdown);
    assertKnowledgeMarkdown(input.kind, parsed.text);
    validateKnowledgeDependencies(db, input, parsed.claims);
  })();
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import { readKnowledgeNodeRow } from "./storage-read.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import type Database from "better-sqlite3";

/** Full replacement requires explicit intent for every omitted wiki/root claim.
 * This checks identity preservation, not the semantics of retained claim text.
 */
export function assertKnowledgeClaimPreservation(
  db: Database.Database,
  input: Pick<SaveKnowledgeNodeInput, "id" | "kind" | "expectedRevision" | "claimRemovals">,
  nextClaimIds: readonly string[],
  plainText: string,
): void {
  const removals = input.claimRemovals ?? [];
  if (input.kind !== "wiki" && input.kind !== "root") {
    if (removals.length)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "claimRemovals applies only to wiki and root pages",
      );
    return;
  }
  // Check visibility before enumerating IDs or reporting proposal differences.
  // Historical dependency privacy fences apply to an otherwise live page too.
  const current = readKnowledgeNodeRow(db, input.id);
  if (
    (current && knowledgeNodeFence(db, input.id).hidden) ||
    db.prepare("SELECT 1 FROM knowledge_node_tombstones WHERE id=?").get(input.id) ||
    (input.expectedRevision > 0 && !current)
  )
    throw new KnowledgeStorageError("reference_invalid", "Synthesis page is unavailable");
  if ((current?.revision ?? 0) !== input.expectedRevision)
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Node revision changed; fetch the current page before revising it",
    );
  if (input.kind === "wiki" && !plainText.trim())
    throw new KnowledgeStorageError(
      "claim_invalid",
      "A wiki reference page cannot be saved empty. Preserve its existing claim spans; a validation refusal is not permission to erase context. Reread and repair the evidence, or leave the work pending.",
    );
  if (removals.length > 1024 || (input.expectedRevision === 0 && removals.length))
    throw new KnowledgeStorageError(
      "claim_invalid",
      "New pages cannot remove claims; existing pages allow at most 1024 explicit removals",
    );
  const existing = new Set(
    db
      .prepare<[string], { id: string }>("SELECT id FROM knowledge_claims WHERE node_id=?")
      .all(input.id)
      .map((row) => row.id),
  );
  const retained = new Set(nextClaimIds);
  const explicit = new Set<string>();
  for (const removal of removals) {
    if (
      typeof removal.id !== "string" ||
      typeof removal.reason !== "string" ||
      !removal.reason.trim() ||
      removal.reason.length > 1000 ||
      explicit.has(removal.id) ||
      !existing.has(removal.id) ||
      retained.has(removal.id)
    )
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Each claimRemovals entry must name a distinct existing claim omitted from this replacement and give a nonblank reason of at most 1000 characters. Do not declare retained or unknown claims removed.",
      );
    explicit.add(removal.id);
  }
  const omitted = [...existing].filter((id) => !retained.has(id) && !explicit.has(id)).sort();
  if (omitted.length)
    throw new KnowledgeStorageError(
      "claim_invalid",
      `This replacement omits existing claims without explicit removal intent: ${JSON.stringify(omitted)}. Preserve their full claim spans by default. For a deliberately retired claim, add node.claimRemovals:[{id,reason}]; reviewedClaimIds does not authorize deletion. A validation refusal is not permission to drop unrelated context: reread the page and exact references, repair the proposal, or leave the work pending.`,
    );
}

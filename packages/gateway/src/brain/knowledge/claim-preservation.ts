// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import { readKnowledgeNodeRow } from "./storage-read.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import type Database from "better-sqlite3";

/** A save may remove this many of a page's claims before the share rule applies. */
export const MASS_REMOVAL_FLOOR = 3;
/** One removal reason may explain at most this many removed claims in one save. */
export const SHARED_REMOVAL_REASON_LIMIT = 2;

const MASS_REMOVAL_GUIDANCE =
  "Nothing was saved. Being unable to re-check a claim in this run is never a reason to remove it: keep claims you cannot re-ground unchanged and leave their review pending (unreviewed claims stay offered to a later run; a whole-page review may record curationDeferral). If the page as a whole no longer stands, retire it with knowledge_retire and a specific reason. Otherwise remove claims a few at a time, each with a reason specific to that claim.";

/** Normalized for comparison, so spacing or case alone does not make a reason distinct. */
function removalReasonKey(reason: string): string {
  return reason.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A single save may not gut a page: it may not remove more than half of the
 * page's claims once it removes {@link MASS_REMOVAL_FLOOR} or more, retitle
 * the page while removing most of it, or give one reason for more than
 * {@link SHARED_REMOVAL_REASON_LIMIT} removals. Taking a page out of service is
 * `knowledge_retire`; removing a claim is a judgement about that claim.
 */
function assertNoMassClaimRemoval(
  removals: NonNullable<SaveKnowledgeNodeInput["claimRemovals"]>,
  existingCount: number,
  retitled: boolean,
): void {
  const removed = removals.length;
  const most = removed * 2 > existingCount;
  if (removed >= MASS_REMOVAL_FLOOR && most)
    throw new KnowledgeStorageError(
      "claim_invalid",
      `This save removes ${removed} of the page's ${existingCount} claims; one save may not remove more than half of a page's claims once it removes ${MASS_REMOVAL_FLOOR} or more. ${MASS_REMOVAL_GUIDANCE}`,
    );
  if (retitled && removed >= 2 && most)
    throw new KnowledgeStorageError(
      "claim_invalid",
      `This save retitles the page while removing ${removed} of its ${existingCount} claims, which turns it into a page about another subject. Keep the title, or keep the claims. ${MASS_REMOVAL_GUIDANCE}`,
    );
  const counts = new Map<string, number>();
  for (const removal of removals) {
    const key = removalReasonKey(removal.reason);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = Math.max(0, ...counts.values());
  if (shared > SHARED_REMOVAL_REASON_LIMIT)
    throw new KnowledgeStorageError(
      "claim_invalid",
      `This save gives the same removal reason for ${shared} claims; a removal reason explains why that particular claim goes, and one reason may cover at most ${SHARED_REMOVAL_REASON_LIMIT}. ${MASS_REMOVAL_GUIDANCE}`,
    );
}

/** Full replacement requires explicit intent for every omitted wiki/root claim,
 * and no single replacement may gut the page ({@link assertNoMassClaimRemoval}).
 * This checks identity preservation, not the semantics of retained claim text.
 */
export function assertKnowledgeClaimPreservation(
  db: Database.Database,
  input: Pick<
    SaveKnowledgeNodeInput,
    "id" | "kind" | "title" | "expectedRevision" | "claimRemovals"
  >,
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
  if (removals.length)
    assertNoMassClaimRemoval(removals, existing.size, current?.title !== input.title);
  const omitted = [...existing].filter((id) => !retained.has(id) && !explicit.has(id)).sort();
  if (omitted.length)
    throw new KnowledgeStorageError(
      "claim_invalid",
      `This replacement omits existing claims without explicit removal intent: ${JSON.stringify(omitted)}. Preserve their full claim spans by default. For a deliberately retired claim, add node.claimRemovals:[{id,reason}]; reviewedClaimIds does not authorize deletion. A validation refusal is not permission to drop unrelated context: reread the page and exact references, repair the proposal, or leave the work pending.`,
    );
}

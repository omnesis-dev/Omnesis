// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Repository mutations run exclusively through the gateway writer worker. */
import { assertKnowledgeClaimPreservation } from "./claim-preservation.js";
import { recordAcceptedClaimMaintenance } from "./claim-maintenance.js";
import { readKnowledgeCollectionRevision } from "./reconciliation.js";
import { assertKnowledgeRunFence } from "./run-fence.js";
import { parseClaimMarkup } from "./claims.js";
import { snapshotKnowledgeRevision } from "./storage-history.js";
import { invalidateKnowledgeDependents } from "./storage-invalidation.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { isClaimIdentifier } from "./references.js";
import {
  KnowledgeStorageError,
  type KnowledgeNode,
  type SaveKnowledgeNodeInput,
  type KnowledgeSaveResult,
} from "./types.js";
import { appendKnowledgeChange, getKnowledgeNode, readKnowledgeNodeRow } from "./storage-read.js";
import {
  knowledgeClaimFingerprint,
  knowledgeHash,
  validateKnowledgeDependencies,
} from "./storage-validation.js";
import type Database from "better-sqlite3";

export {
  registerKnowledgeEvidence,
  getKnowledgeEvidence,
  type KnowledgeEvidence,
} from "./storage-evidence.js";
export {
  listKnowledgeNodeRevisions,
  type KnowledgeNodeRevision,
  type KnowledgeRevisionDiff,
} from "./storage-history.js";
export { createKnowledgeTables } from "./schema.js";
export {
  getKnowledgeNode,
  getKnowledgeClaims,
  getKnowledgeDependencies,
  listKnowledgeNodes,
  listKnowledgeChanges,
  ackKnowledgeChanges,
} from "./storage-read.js";
export { knowledgeClaimFingerprint, resolveKnowledgeReference } from "./storage-validation.js";
export { isKnowledgeNodeReadable, knowledgeNodeFence } from "./storage-fence.js";
export {
  advanceKnowledgeCascade,
  invalidateKnowledgeDependents,
  purgeKnowledgeBySource,
  purgeKnowledgeNode,
  recordKnowledgeSourceChange,
} from "./storage-invalidation.js";

export function saveKnowledgeNode(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  now: number,
): KnowledgeSaveResult {
  if (
    !isClaimIdentifier(input.id) ||
    input.id.startsWith("source:") ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !input.title.trim() ||
    input.title.length > 1000
  )
    throw new KnowledgeStorageError("claim_invalid", "Invalid node identity, revision or title");
  if (input.kind === "root" && input.markdown.length > Math.min(input.rootMaxChars ?? 8000, 32000))
    throw new KnowledgeStorageError(
      "claim_invalid",
      `Root wiki uses ${input.markdown.length} characters; allowed budget is ${Math.min(input.rootMaxChars ?? 8000, 32000)} characters including claim markup. Compact until it fits.`,
    );
  const parsed = parseClaimMarkup(input.markdown);
  return db.transaction(() => {
    assertKnowledgeRunFence(db, input.runFence);
    assertKnowledgeRunFence(db, input.maintenance);
    if (input.maintenance) {
      const offered = db
        .prepare<[string, string, string], { input_versions_json: string }>(
          `SELECT f.input_versions_json FROM knowledge_frontier f JOIN knowledge_batches b ON b.id=f.batch_id
        WHERE f.batch_id=? AND f.node_id=? AND f.input_fingerprint=? AND f.status='offered'
          AND b.status NOT IN ('completed','abandoned')`,
        )
        .get(input.maintenance.batchId, input.id, input.maintenance.inputFingerprint);
      if (!offered)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Maintenance batch no longer owns this synthesis input",
        );
      // These are trusted offered inputs, not the model's chosen citations.
      // Recheck uncited discovery context after any asynchronous verification.
      const versions = JSON.parse(offered.input_versions_json) as Record<string, string | number>;
      const sourceRevision = db.prepare<[string], { content_hash: string }>(
        "SELECT content_hash FROM documents WHERE id=?",
      );
      for (const [ref, expected] of Object.entries(versions)) {
        if (!ref.startsWith("source:") || ref.includes("#")) continue;
        const sourceId = ref.slice(7);
        const current = sourceRevision.get(sourceId);
        const readable = current && isKnowledgeEvidenceReadable(db, sourceId);
        if ((readable ? current.content_hash : "missing") !== expected)
          throw new KnowledgeStorageError(
            "revision_conflict",
            "Maintenance source inputs changed; request the next frontier again",
          );
      }
    }
    if (input.enforceClaimPreservation)
      assertKnowledgeClaimPreservation(
        db,
        input,
        parsed.claims.map((claim) => claim.id),
        parsed.text,
      );
    if (db.prepare("SELECT 1 FROM knowledge_node_tombstones WHERE id=?").get(input.id))
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Deleted synthesis identities cannot be reused",
      );
    const existing = readKnowledgeNodeRow(db, input.id);
    if (existing && JSON.parse(existing.fields_json).withdrawn === true)
      throw new KnowledgeStorageError("reference_invalid", "Withdrawn synthesis cannot be revised");
    if (existing && knowledgeNodeFence(db, input.id).hidden)
      throw new KnowledgeStorageError("reference_invalid", "Node is pending privacy deletion");
    if ((existing?.revision ?? 0) !== input.expectedRevision)
      throw new KnowledgeStorageError("revision_conflict", "Node revision changed");
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
    const dependencies = validateKnowledgeDependencies(db, input, parsed.claims);
    const oldClaimMeanings = new Map(
      db
        .prepare<[string], { id: string; meaning_revision: number; meaning_hash: string }>(
          "SELECT id,meaning_revision,meaning_hash FROM knowledge_claims WHERE node_id=?",
        )
        .all(input.id)
        .map((claim) => [claim.id, claim]),
    );
    const oldClaims = new Map(
      db
        .prepare<[string], { id: string; fingerprint: string }>(
          "SELECT id,fingerprint FROM knowledge_claims WHERE node_id=?",
        )
        .all(input.id)
        .map((c) => [c.id, c.fingerprint]),
    );
    const oldRefs = new Map(
      db
        .prepare<[string], { ref: string; input_version_json: string }>(
          "SELECT ref,input_version_json FROM knowledge_dependencies WHERE node_id=?",
        )
        .all(input.id)
        .map((r) => [r.ref, r.input_version_json]),
    );

    const fields =
      input.canonicalFields ??
      (existing ? (JSON.parse(existing.fields_json) as Record<string, unknown>) : {});
    const meaningHash = knowledgeHash([
      input.title,
      parsed.text,
      fields,
      parsed.claims.map((claim) => {
        const state = input.claims?.find((value) => value.id === claim.id);
        return [
          claim.id,
          claim.parentId,
          claim.refs.map((ref) => [ref.raw, state?.relations?.[ref.raw] ?? "supports"]),
          state?.supportLogic ?? "all",
          state?.validFrom ?? null,
          state?.validUntil ?? null,
          state?.attribution ?? null,
          state?.modality ?? "observation",
          state?.epistemicStatus ?? "asserted",
        ];
      }),
    ]);
    const meaningChanged = existing?.meaning_hash !== meaningHash;
    const revision = (existing?.revision ?? 0) + 1;
    const meaningRevision = (existing?.meaning_revision ?? 0) + (meaningChanged ? 1 : 0);
    db.prepare(
      `INSERT INTO knowledge_nodes(id,kind,owner_id,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'current',?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,markdown=excluded.markdown,plain_text=excluded.plain_text,revision=excluded.revision,
      meaning_revision=excluded.meaning_revision,meaning_hash=excluded.meaning_hash,validity=excluded.validity,
      metadata_json=excluded.metadata_json,fields_json=excluded.fields_json,updated_at=excluded.updated_at`,
    ).run(
      input.id,
      input.kind,
      input.ownerId ?? null,
      input.title,
      input.markdown,
      parsed.text,
      revision,
      meaningRevision,
      meaningHash,
      JSON.stringify(
        input.metadata ?? (existing ? (JSON.parse(existing.metadata_json) as unknown) : {}),
      ),
      JSON.stringify(fields),
      existing?.created_at ?? now,
      now,
    );
    // Explicit child cleanup also works for isolated repository tests with foreign_keys disabled.
    db.prepare("DELETE FROM knowledge_dependencies WHERE node_id=?").run(input.id);
    db.prepare("DELETE FROM knowledge_claims WHERE node_id=?").run(input.id);
    const insertClaim = db.prepare(
      `INSERT INTO knowledge_claims(node_id,id,text,parent_id,span_start,span_end,support_logic,verification,fingerprint,verifier,valid_from,valid_until,meaning_revision,meaning_hash,witness_refs_json,attribution,modality,epistemic_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const claim of parsed.claims) {
      const state = input.claims?.find((c) => c.id === claim.id);
      const claimMeaningHash = knowledgeHash([
        claim.text,
        claim.parentId,
        claim.refs.map((ref) => [ref.raw, state?.relations?.[ref.raw] ?? "supports"]),
        state?.supportLogic ?? "all",
        state?.validFrom ?? null,
        state?.validUntil ?? null,
        state?.attribution ?? null,
        state?.modality ?? "observation",
        state?.epistemicStatus ?? "asserted",
      ]);
      const priorClaim = oldClaimMeanings.get(claim.id);
      insertClaim.run(
        input.id,
        claim.id,
        claim.text,
        claim.parentId,
        claim.contentSpan.start,
        claim.contentSpan.end,
        state?.supportLogic ?? "all",
        state?.verification?.status ?? "unverified",
        knowledgeClaimFingerprint(claim, input.inputVersions, state),
        state?.verification?.verifier ?? null,
        state?.validFrom ?? null,
        state?.validUntil ?? null,
        priorClaim?.meaning_hash === claimMeaningHash ? priorClaim.meaning_revision : revision,
        claimMeaningHash,
        JSON.stringify(state?.verification?.witnessRefs ?? []),
        state?.attribution ?? null,
        state?.modality ?? "observation",
        state?.epistemicStatus ?? "asserted",
      );
    }
    const insertDependency = db.prepare(
      "INSERT INTO knowledge_dependencies(node_id,claim_id,ref,target_id,target_kind,relation,input_version_json) VALUES(?,?,?,?,?,?,?)",
    );
    for (const dep of dependencies)
      insertDependency.run(
        dep.nodeId,
        dep.claimId,
        dep.ref,
        dep.targetId,
        dep.targetKind,
        dep.relation,
        JSON.stringify(dep.inputVersion),
      );
    recordAcceptedClaimMaintenance(db, input);
    const newClaims = new Map(
      parsed.claims.map((claim) => [
        claim.id,
        knowledgeClaimFingerprint(
          claim,
          input.inputVersions,
          input.claims?.find((c) => c.id === claim.id),
        ),
      ]),
    );
    const newRefs = new Map(dependencies.map((dep) => [dep.ref, JSON.stringify(dep.inputVersion)]));
    const oldFields = existing ? (JSON.parse(existing.fields_json) as Record<string, unknown>) : {};
    snapshotKnowledgeRevision(
      db,
      input.id,
      {
        changedClaimIds: [...new Set([...oldClaims.keys(), ...newClaims.keys()])]
          .filter((id) => oldClaims.get(id) !== newClaims.get(id))
          .sort(),
        changedRefs: [...new Set([...oldRefs.keys(), ...newRefs.keys()])]
          .filter((ref) => oldRefs.get(ref) !== newRefs.get(ref))
          .sort(),
        changedFieldKeys: [...new Set([...Object.keys(oldFields), ...Object.keys(fields)])]
          .filter(
            (key) =>
              Object.hasOwn(oldFields, key) !== Object.hasOwn(fields, key) ||
              knowledgeHash(oldFields[key] ?? null) !== knowledgeHash(fields[key] ?? null),
          )
          .sort(),
        ...(input.enforceClaimPreservation && input.claimRemovals?.length
          ? {
              claimRemovals: input.claimRemovals.map((removal) => ({
                id: removal.id,
                reason: removal.reason.trim(),
              })),
            }
          : {}),
        titleChanged: existing?.title !== input.title,
        validityChanged: existing?.validity !== readKnowledgeNodeRow(db, input.id)?.validity,
      },
      now,
    );
    if (meaningChanged) {
      invalidateKnowledgeDependents(db, { kind: "node", id: input.id }, now);
      appendKnowledgeChange(db, {
        kind: "node_changed",
        entityId: input.id,
        revision: String(revision),
        at: now,
      });
    }
    return {
      node: getKnowledgeNode(db, input.id)!,
      meaningChanged,
      ...(input.runFence?.reconciliation
        ? {
            reconciliationReceipt: {
              collection: "wiki" as const,
              revision: readKnowledgeCollectionRevision(db, "wiki"),
            },
          }
        : {}),
    };
  })();
}

/**
 * A relevance gate may retain the prose against new inputs without attesting
 * entailment. Refresh dependency versions atomically and drop obsolete verifier
 * attestations; an unchanged gate result never becomes a fabricated verification.
 */
export function revalidateKnowledgeNode(
  db: Database.Database,
  input: {
    id: string;
    expectedRevision: number;
    inputVersions: SaveKnowledgeNodeInput["inputVersions"];
  },
  now: number,
): { node: KnowledgeNode; meaningChanged: boolean } {
  return db.transaction(() => {
    const node = getKnowledgeNode(db, input.id);
    if (!node) throw new KnowledgeStorageError("reference_invalid", "Synthesis does not exist");
    const states = db
      .prepare<
        [string],
        {
          id: string;
          support_logic: "all" | "any";
          valid_from: number | null;
          valid_until: number | null;
          attribution: string | null;
          modality: import("./types.js").KnowledgeModality;
          epistemic_status: import("./types.js").KnowledgeEpistemicStatus;
        }
      >(
        "SELECT id,support_logic,valid_from,valid_until,attribution,modality,epistemic_status FROM knowledge_claims WHERE node_id=?",
      )
      .all(input.id);
    const relations = db
      .prepare<
        [string],
        { claim_id: string; ref: string; relation: import("./types.js").KnowledgeRelation }
      >("SELECT claim_id,ref,relation FROM knowledge_dependencies WHERE node_id=?")
      .all(input.id);
    return saveKnowledgeNode(
      db,
      {
        id: node.id,
        kind: node.kind,
        ownerId: node.ownerId,
        title: node.title,
        markdown: node.markdown,
        expectedRevision: input.expectedRevision,
        inputVersions: input.inputVersions,
        metadata: node.metadata,
        canonicalFields: node.canonicalFields,
        claims: states.map((state) => ({
          id: state.id,
          supportLogic: state.support_logic,
          validFrom: state.valid_from,
          validUntil: state.valid_until,
          attribution: state.attribution,
          modality: state.modality,
          epistemicStatus: state.epistemic_status,
          relations: Object.fromEntries(
            relations.filter((r) => r.claim_id === state.id).map((r) => [r.ref, r.relation]),
          ),
        })),
      },
      now,
    );
  })();
}

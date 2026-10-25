// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@omnesis/core";
import { getOpenLoop } from "./storage/open-loops.js";
import { readKnowledgeSourceRevision } from "./knowledge/source-revision.js";
import { isKnowledgeDocumentReadable } from "./knowledge/retrieval-fence.js";
import { knowledgeNodeFence, isKnowledgeOwnerReadable } from "./knowledge/storage-fence.js";
import type Database from "better-sqlite3";
import type {
  LoopListPortResult,
  LoopListReadIdentity,
  LoopListReadOptions,
  LoopListValidationFailure,
} from "@omnesis/agent";

const MAX_RECEIPTS = 32;
const MAX_PACKET_BYTES = 262144;
const MAX_AUTHORITY_ROWS = 4096;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
type Owner = {
  id: string;
  createdAt: number;
  sources: string[];
  nodes: string[];
  authority: string;
  sourceHash: string;
  associationHash: string;
  proofHash: string;
};
class AuthorityCaptureError extends Error {
  constructor(readonly category: LoopListValidationFailure) {
    super(category);
  }
}
type Receipt = { identity: string; payload: string; owners: Owner[] };
const identityKey = (identity: LoopListReadIdentity) =>
  JSON.stringify([identity.sessionId, identity.messageId]);

/** Bounded metadata-only authority capture. It does not read unseen source prose.
 * Root owner summary values are historical system state; source generations and
 * proof/association changes remain strict. Descendant generations are authority.
 */
function captureOwner(db: Database.Database, id: string, remaining: { rows: number }): Owner {
  const owner = getOpenLoop(db, id);
  if (!owner) throw new AuthorityCaptureError("owner_unavailable");
  const sources = new Set(owner.docs);
  const proof: unknown[] = [];
  const nodes: string[] = [];
  const hasKnowledge = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'")
    .get();
  if (hasKnowledge && db.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(id)) {
    const ancestry = db
      .prepare<[string, number], { kind: string; id: string }>(
        `
      WITH RECURSIVE ancestors(kind,id) AS (
        SELECT 'node', ? UNION
        SELECT d.target_kind,d.target_id FROM knowledge_dependencies d JOIN ancestors a ON a.kind='node' AND d.node_id=a.id
        UNION SELECT d.target_kind,d.target_id FROM knowledge_revision_dependencies d JOIN ancestors a ON a.kind='node' AND d.node_id=a.id
        LIMIT ?
      ) SELECT kind,id FROM ancestors ORDER BY kind,id`,
      )
      .all(id, remaining.rows + 1);
    remaining.rows -= ancestry.length;
    if (remaining.rows < 0) throw new AuthorityCaptureError("authority_budget");
    for (const ancestor of ancestry) {
      if (ancestor.kind === "source") {
        sources.add(ancestor.id);
        continue;
      }
      nodes.push(ancestor.id);
      const node = db
        .prepare("SELECT kind,meaning_revision,validity FROM knowledge_nodes WHERE id=?")
        .get(ancestor.id) as
        | { kind: string; meaning_revision: number; validity: string }
        | undefined;
      if (!node) throw new AuthorityCaptureError("owner_unavailable");
      const claims = db
        .prepare(
          `SELECT id,parent_id,meaning_revision,verification,verifier,fingerprint,epistemic_status,modality,attribution,valid_from,valid_until,support_logic FROM knowledge_claims WHERE node_id=? ORDER BY id LIMIT ?`,
        )
        .all(ancestor.id, remaining.rows + 1);
      const dependencies = db
        .prepare(
          `SELECT claim_id,ref,relation,target_kind,target_id,input_version_json FROM knowledge_dependencies WHERE node_id=? ORDER BY claim_id,ref LIMIT ?`,
        )
        .all(ancestor.id, remaining.rows + 1);
      remaining.rows -= claims.length + dependencies.length;
      if (remaining.rows < 0) throw new AuthorityCaptureError("authority_budget");
      proof.push({
        id: ancestor.id,
        node: ancestor.id === id ? { kind: node.kind, validity: node.validity } : node,
        claims,
        dependencies,
      });
    }
  }
  if (nodes.length) proof.push({ fence: knowledgeNodeFence(db, id) });
  remaining.rows -= sources.size;
  if (remaining.rows < 0) throw new AuthorityCaptureError("authority_budget");
  const sourceVersions = [...sources].sort().map((sourceId) => {
    if (!isKnowledgeDocumentReadable(db, sourceId))
      throw new AuthorityCaptureError("source_unavailable");
    const version = readKnowledgeSourceRevision(db, sourceId);
    if (version === null) throw new AuthorityCaptureError("source_unavailable");
    return [sourceId, version];
  });
  return {
    id,
    createdAt: owner.createdAt,
    nodes,
    sources: [...sources].sort(),
    authority: digest({ createdAt: owner.createdAt, docs: owner.docs, proof, sourceVersions }),
    sourceHash: digest(sourceVersions),
    associationHash: digest({ docs: owner.docs, nodes, sources: [...sources].sort() }),
    proofHash: digest(proof),
  };
}

/** Per-port bounded capability registry. Tokens bind exact emitted data and turn;
 * old transcript/model-supplied snapshots cannot acquire new read authority.
 */
export class LoopListReceipts {
  private readonly receipts = new Map<string, Receipt>();
  constructor(private readonly db: Database.Database) {}

  capture(
    result: LoopListPortResult,
    read: LoopListReadOptions,
    now: number,
    limit: number,
  ): LoopListPortResult {
    const remaining = { rows: MAX_AUTHORITY_ROWS };
    const owners = result.loops.map((loop) => captureOwner(this.db, loop.loopId, remaining));
    const observed: LoopListPortResult = {
      ...result,
      observation: {
        receiptId: randomUUID(),
        mode: read.mode,
        observedAt: new Date(now).toISOString(),
        readScope: {
          states: ["open", "snoozed"],
          order: "importance_desc_id_desc",
          limit,
          population: "accessible_stored_records",
        },
      },
    };
    if (
      Buffer.byteLength(JSON.stringify(observed)) > MAX_PACKET_BYTES ||
      Buffer.byteLength(
        JSON.stringify(
          owners.map(
            ({
              sourceHash: _source,
              associationHash: _association,
              proofHash: _proof,
              ...authority
            }) => authority,
          ),
        ),
      ) > MAX_PACKET_BYTES
    )
      throw new Error("Loop observation exceeds its bounded evidence budget");
    this.receipts.set(observed.observation!.receiptId, {
      identity: identityKey(read),
      payload: digest(observed),
      owners,
    });
    while (this.receipts.size > MAX_RECEIPTS)
      this.receipts.delete(this.receipts.keys().next().value!);
    return observed;
  }

  validate(
    result: LoopListPortResult,
    identity: LoopListReadIdentity,
    onRefusal?: (category: LoopListValidationFailure) => void,
  ): boolean {
    return this.validateAuthority(result, identity, false, onRefusal);
  }

  /** Checks original identity/privacy/source generations without lending the
   * snapshot's assertions any authority. Only the finalizer may discard them. */
  validateAsNavigation(result: LoopListPortResult, identity: LoopListReadIdentity): boolean {
    return this.validateAuthority(result, identity, true);
  }

  private validateAuthority(
    result: LoopListPortResult,
    identity: LoopListReadIdentity,
    discardSnapshot: boolean,
    onRefusal?: (category: LoopListValidationFailure) => void,
  ): boolean {
    const refuse = (category: LoopListValidationFailure) => {
      onRefusal?.(category);
      return false;
    };
    const observation = result.observation;
    if (!observation) return refuse("missing_observation");
    const receipt = this.receipts.get(observation.receiptId);
    if (!receipt) return refuse("missing_receipt");
    if (receipt.identity !== identityKey(identity)) return refuse("identity_mismatch");
    if (receipt.payload !== digest(result)) return refuse("payload_mismatch");
    try {
      return this.db.transaction(() => {
        const remaining = { rows: MAX_AUTHORITY_ROWS };
        for (const original of receipt.owners) {
          const owner = getOpenLoop(this.db, original.id);
          if (!owner)
            return refuse(
              this.db.prepare("SELECT 1 FROM open_loops WHERE id=?").get(original.id)
                ? "owner_privacy"
                : "owner_unavailable",
            );
          if (owner.createdAt !== original.createdAt) return refuse("owner_identity_changed");
          // Even navigation cannot expose a previously observed private source
          // after its association was removed from the current canonical row.
          if (original.sources.some((id) => !isKnowledgeDocumentReadable(this.db, id)))
            return refuse("source_unavailable");
          if (
            original.nodes.some(
              (id) =>
                !this.db.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(id) ||
                !isKnowledgeOwnerReadable(this.db, id),
            )
          )
            return refuse("ancestor_unavailable");
          if (observation.mode === "snapshot") {
            const current = captureOwner(this.db, original.id, remaining);
            if (discardSnapshot) {
              // Compare the ORIGINAL source set: changed associations must not
              // hide a simultaneous source edit, deletion or ABA transition.
              const originalVersions = original.sources.map((id) => [
                id,
                readKnowledgeSourceRevision(this.db, id),
              ]);
              if (digest(originalVersions) !== original.sourceHash) return refuse("source_changed");
              if (current.nodes.some((id) => !isKnowledgeOwnerReadable(this.db, id)))
                return refuse("ancestor_unavailable");
              // Proof and association changes may be forgotten, never trusted.
              // Owner identity and all original privacy checks already passed.
              continue;
            }
            if (current.authority !== original.authority)
              return refuse(
                current.associationHash !== original.associationHash
                  ? "association_changed"
                  : current.sourceHash !== original.sourceHash
                    ? "source_changed"
                    : current.proofHash !== original.proofHash
                      ? "proof_changed"
                      : "authority_changed",
              );
          }
        }
        return true;
      })();
    } catch (error) {
      return refuse(error instanceof AuthorityCaptureError ? error.category : "validation_error");
    }
  }
}

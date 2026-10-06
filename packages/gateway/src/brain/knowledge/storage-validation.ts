// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { parseClaimReference, type ClaimReference } from "./references.js";
import {
  KnowledgeStorageError,
  type KnowledgeClaimState,
  type KnowledgeDependency,
  type KnowledgeRevision,
  type SaveKnowledgeNodeInput,
} from "./types.js";
import { readKnowledgeNodeRow } from "./storage-read.js";

import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { assertAcyclicKnowledgeClaims } from "./storage-cycles.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import type { ParsedClaim } from "./claims.js";
import type Database from "better-sqlite3";

type Db = Database.Database;
export function knowledgeHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const object = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, object[key]]),
    );
  });
  return createHash("sha256").update(canonical).digest("hex");
}
/** Bind an entailment verdict to its precise text, dependency versions and support semantics. */
export function knowledgeClaimFingerprint(
  claim: Pick<ParsedClaim, "text" | "refs">,
  versions: Record<string, KnowledgeRevision>,
  state?: KnowledgeClaimState,
): string {
  return knowledgeHash([
    claim.text,
    [...claim.refs]
      .sort((a, b) => a.raw.localeCompare(b.raw))
      .map((ref) => [ref.raw, versions[ref.raw], state?.relations?.[ref.raw] ?? "supports"]),
    state?.supportLogic ?? "all",
    state?.validFrom ?? null,
    state?.validUntil ?? null,
  ]);
}

function targetNode(db: Db, ref: ClaimReference): ReturnType<typeof readKnowledgeNodeRow> {
  const direct = readKnowledgeNodeRow(db, ref.id);
  const kinds =
    ref.kind === "wiki"
      ? ["wiki", "root"]
      : ref.kind === "annotation"
        ? ["doc_annotation", "person_annotation"]
        : [ref.kind];
  if (direct && kinds.includes(direct.kind)) return direct;
  // Owner IDs of existing loops/annotations remain stable when their prose is mirrored.
  const matches = db
    .prepare<[string], { id: string; kind: string }>(
      "SELECT id,kind FROM knowledge_nodes WHERE owner_id=?",
    )
    .all(ref.id)
    .filter((row) => kinds.includes(row.kind));
  if (matches.length !== 1) return undefined;
  return readKnowledgeNodeRow(db, matches[0]!.id);
}

export function resolveKnowledgeReference(
  db: Db,
  ref: ClaimReference,
): {
  targetId: string;
  targetKind: "source" | "node";
  revision: KnowledgeRevision;
  stale: boolean;
} {
  if (ref.kind === "source") {
    const deleted = db
      .prepare<
        [string],
        { deleted: number }
      >("SELECT deleted FROM knowledge_source_revisions WHERE document_id=?")
      .get(ref.id);
    if (deleted?.deleted || !isKnowledgeEvidenceReadable(db, ref.id))
      throw new KnowledgeStorageError("reference_invalid", "Evidence has been deleted");
    const row = db
      .prepare<[string], { content_hash: string }>("SELECT content_hash FROM documents WHERE id=?")
      .get(ref.id);
    if (!row)
      throw new KnowledgeStorageError("reference_invalid", "Evidence document does not exist");
    if (
      ref.selector &&
      !db
        .prepare("SELECT 1 FROM knowledge_evidence WHERE id=? AND document_id=? AND content_hash=?")
        .get(ref.selector.id, ref.id, row.content_hash)
    )
      throw new KnowledgeStorageError("reference_invalid", "Evidence passage is missing or stale");
    return { targetId: ref.id, targetKind: "source", revision: row.content_hash, stale: false };
  }
  const node = targetNode(db, ref);
  if (!node || knowledgeNodeFence(db, node.id).hidden)
    throw new KnowledgeStorageError("reference_invalid", "Referenced synthesis does not exist");
  if (JSON.parse(node.fields_json).withdrawn === true)
    throw new KnowledgeStorageError("reference_invalid", "Referenced synthesis was withdrawn");
  if (
    ref.selector?.kind === "claim" &&
    !db
      .prepare("SELECT 1 FROM knowledge_claims WHERE node_id=? AND id=?")
      .get(node.id, ref.selector.id)
  ) {
    throw new KnowledgeStorageError("reference_invalid", "Referenced claim does not exist");
  }
  if (
    ref.selector?.kind === "field" &&
    !Object.hasOwn(JSON.parse(node.fields_json) as object, ref.selector.id)
  ) {
    throw new KnowledgeStorageError(
      "reference_invalid",
      "Referenced canonical field does not exist",
    );
  }
  return {
    targetId: node.id,
    targetKind: "node",
    revision:
      ref.selector?.kind === "claim"
        ? db
            .prepare<
              [string, string],
              { meaning_revision: number }
            >("SELECT meaning_revision FROM knowledge_claims WHERE node_id=? AND id=?")
            .get(node.id, ref.selector.id)!.meaning_revision
        : node.meaning_revision,
    stale:
      (ref.selector ? false : node.validity === "stale") ||
      knowledgeNodeFence(
        db,
        node.id,
        ref.selector?.kind === "claim" || ref.selector?.kind === "field"
          ? { kind: ref.selector.kind, id: ref.selector.id }
          : undefined,
      ).stale,
  };
}

/** Recheck proof status inside the writer transaction after asynchronous verification. */
function referenceHasCurrentSupport(
  db: Db,
  ref: ClaimReference,
  path: Set<string>,
  budget: { left: number },
): boolean {
  if (--budget.left < 0 || path.size >= 32 || path.has(ref.raw)) return false;
  const target = resolveKnowledgeReference(db, ref);
  if (target.stale) return false;
  if (ref.kind === "source" || ref.selector?.kind === "field") return true;
  if (ref.selector?.kind !== "claim") return false;
  const claim = db
    .prepare<
      [string, string],
      { verification: string; support_logic: string; witness_refs_json: string }
    >("SELECT verification,support_logic,witness_refs_json FROM knowledge_claims WHERE node_id=? AND id=?")
    .get(target.targetId, ref.selector.id);
  if (claim?.verification !== "verified") return false;
  const supports = db
    .prepare<
      [string, string],
      { ref: string; input_version_json: string }
    >("SELECT ref,input_version_json FROM knowledge_dependencies WHERE node_id=? AND claim_id=? AND relation='supports'")
    .all(target.targetId, ref.selector.id);
  const next = new Set(path);
  next.add(ref.raw);
  const witnesses = JSON.parse(claim.witness_refs_json) as string[];
  const sufficient =
    claim.support_logic === "any"
      ? supports.filter((support) => witnesses.includes(support.ref))
      : supports;
  if (
    claim.support_logic === "any" &&
    (!witnesses.length || sufficient.length !== witnesses.length)
  )
    return false;
  const valid = sufficient.map((support) => {
    try {
      const reference = parseClaimReference(support.ref);
      return (
        resolveKnowledgeReference(db, reference).revision ===
          JSON.parse(support.input_version_json) &&
        referenceHasCurrentSupport(db, reference, next, budget)
      );
    } catch {
      return false;
    }
  });
  return valid.length > 0 && valid.every(Boolean);
}

export function validateKnowledgeDependencies(
  db: Db,
  input: SaveKnowledgeNodeInput,
  claims: ParsedClaim[],
): KnowledgeDependency[] {
  const states = new Map((input.claims ?? []).map((state) => [state.id, state]));
  if (
    states.size !== (input.claims?.length ?? 0) ||
    [...states.keys()].some((id) => !claims.some((c) => c.id === id))
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Claim state must name unique claims present in the markup",
    );
  const dependencies: KnowledgeDependency[] = [];
  const verificationBudget = { left: 8192 };
  for (const claim of claims) {
    const state = states.get(claim.id);
    if (Object.keys(state?.relations ?? {}).some((ref) => !claim.refs.some((r) => r.raw === ref)))
      throw new KnowledgeStorageError("claim_invalid", "Claim relation names a missing reference");
    for (const ref of claim.refs) {
      const target = resolveKnowledgeReference(db, ref);
      if (input.inputVersions[ref.raw] !== target.revision)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Dependency revision changed or was not supplied",
        );
      const relation = state?.relations?.[ref.raw] ?? "supports";
      if (
        state?.verification?.status === "verified" &&
        state.supportLogic !== "any" &&
        target.stale &&
        relation === "supports"
      )
        throw new KnowledgeStorageError(
          "reference_invalid",
          "Stale synthesis cannot verify a new claim",
        );
      dependencies.push({
        nodeId: input.id,
        claimId: claim.id,
        ref: ref.raw,
        targetId: target.targetId,
        targetKind: target.targetKind,
        relation,
        inputVersion: target.revision,
      });
    }
    if (state?.verification?.status === "verified") {
      const supports = claim.refs.filter(
        (ref) => (state.relations?.[ref.raw] ?? "supports") === "supports",
      );
      const witnesses = state.verification.witnessRefs ?? [];
      const sufficient =
        state.supportLogic === "any"
          ? supports.filter((ref) => witnesses.includes(ref.raw))
          : supports;
      if (state.supportLogic === "any" && (witnesses.length !== 1 || sufficient.length !== 1))
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Any-support verification requires its exact accepted witness",
        );
      const valid = sufficient.map((ref) =>
        referenceHasCurrentSupport(db, ref, new Set(), verificationBudget),
      );
      if (!valid.length || !valid.every(Boolean))
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Claim support changed during verification",
        );
    }
    if (
      state?.verification &&
      state.verification.fingerprint !==
        knowledgeClaimFingerprint(claim, input.inputVersions, state)
    )
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Verification does not match current claim and evidence",
      );
  }
  assertAcyclicKnowledgeClaims(db, input.id, claims, dependencies);
  return dependencies;
}

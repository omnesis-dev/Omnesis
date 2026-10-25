// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ANNOTATION_CONTEXT_VERIFIER } from "../annotation-verification.js";
import {
  CONTEXTUAL_VERIFIER,
  requiresContextualProof,
  contextualKnowledgeClaim,
  knowledgeClaimContexts,
  type KnowledgeClaimContext,
} from "./claim-context.js";
import { readKnowledgeSourceEvidence, type KnowledgeSourceMetadata } from "./source-evidence.js";
import { parseClaimReference, unavailableKnowledgeReference } from "./references.js";
import {
  getKnowledgeNode,
  getKnowledgeClaims,
  getKnowledgeDependencies,
  getKnowledgeEvidence,
  resolveKnowledgeReference,
} from "./storage.js";
import { knowledgeHash } from "./storage-validation.js";
import { KnowledgeStorageError, type KnowledgeRelation, type KnowledgeRevision } from "./types.js";
import type Database from "better-sqlite3";

export interface KnowledgeReferenceView {
  ref: string;
  revision: KnowledgeRevision;
  /** Source body identity for registering quotes; distinct from dependency revision. */
  contentHash?: string;
  sourceMetadata?: KnowledgeSourceMetadata;
  text: string;
  /** Interpretation constraints only, never additional factual evidence. */
  interpretationContext?: KnowledgeClaimContext;
  stale: boolean;
  /** A generated statement cannot become primary evidence just by being cited. */
  verified: boolean;
  /** Authenticated speech only; raw readable body is not world-fact authority. */
  authorityScope?: "attributed_utterances";
}

/** Host-only proof identity; symbol keys never enter tool or verifier JSON. */
export const selectedReferenceAuthority = Symbol("selected reference authority");

export interface VerificationReferenceView extends KnowledgeReferenceView {
  readonly [selectedReferenceAuthority]?: string;
  verifierEvidence?: string;
}

/** Shared read-only support evaluation; all callers retain the same proof/privacy rules. */
export class KnowledgeReferenceReader {
  constructor(
    private readonly db: Database.Database,
    private readonly captureAuthority = false,
  ) {}
  reference(value: string): VerificationReferenceView {
    return this.db.transaction(() =>
      this.readReference(value, new Set(), 0, { remaining: 8192, memo: new Map() }),
    )();
  }
  /** Shared traversal budget for a bounded evidence packet. */
  references(values: readonly string[]): VerificationReferenceView[] {
    if (values.length > 16)
      throw new KnowledgeStorageError("reference_invalid", "Too many support references");
    return this.db.transaction(() => {
      const evaluation = { remaining: 8192, memo: new Map<string, VerificationReferenceView>() };
      return values.flatMap((value) => {
        try {
          return [this.readReference(value, new Set(), 0, evaluation)];
        } catch {
          return [];
        }
      });
    })();
  }

  private readReference(
    value: string,
    seen: Set<string>,
    depth: number,
    evaluation: { remaining: number; memo: Map<string, VerificationReferenceView> },
  ): VerificationReferenceView {
    if (depth > 32 || seen.has(value))
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Cyclic or excessively deep claim support",
      );
    // Depth participates in the key: reuse must never bypass the path depth limit.
    const key = `${depth}:${value}`;
    const cached = evaluation.memo.get(key);
    if (cached) return cached;
    if (--evaluation.remaining < 0)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Claim support exceeds the bounded read budget",
      );
    const result = this.evaluateReference(value, seen, depth, evaluation);
    evaluation.memo.set(key, result);
    return result;
  }

  private evaluateReference(
    value: string,
    seen: Set<string>,
    depth: number,
    evaluation: { remaining: number; memo: Map<string, VerificationReferenceView> },
  ): VerificationReferenceView {
    const path = new Set(seen);
    path.add(value);
    const ref = parseClaimReference(value);
    const target = resolveKnowledgeReference(this.db, ref);
    if (ref.kind === "source") {
      const evidence = ref.selector ? getKnowledgeEvidence(this.db, ref.selector.id) : null;
      const doc = readKnowledgeSourceEvidence(this.db, ref.id, evidence?.quote);
      if (!doc || (ref.selector && !evidence)) throw unavailableKnowledgeReference(ref);
      return {
        ...(this.captureAuthority
          ? {
              [selectedReferenceAuthority]: knowledgeHash([
                value,
                target.revision,
                doc.contentHash,
                doc.sourceMetadata,
                doc.authorityAvailable,
                doc.authorityScope,
                doc.verifierEvidence,
              ]),
            }
          : {}),
        ref: value,
        revision: target.revision,
        contentHash: doc.contentHash,
        sourceMetadata: doc.sourceMetadata,
        text: evidence?.quote ?? doc.content,
        verifierEvidence: doc.verifierEvidence,
        stale: false,
        verified: doc.authorityAvailable,
        ...(doc.authorityScope ? { authorityScope: doc.authorityScope } : {}),
      };
    }
    const node = getKnowledgeNode(this.db, target.targetId)!;
    if (ref.selector?.kind === "field") {
      return {
        ...(this.captureAuthority
          ? {
              [selectedReferenceAuthority]: knowledgeHash([
                value,
                target.revision,
                node.id,
                node.kind,
                node.ownerId,
                node.createdAt,
                node.canonicalFields[ref.selector.id],
              ]),
            }
          : {}),
        ref: value,
        revision: target.revision,
        text: JSON.stringify(node.canonicalFields[ref.selector.id]),
        stale: target.stale,
        verified: !target.stale,
      };
    }
    const claims = getKnowledgeClaims(this.db, node.id);
    const selected = ref.selector
      ? claims.filter((claim) => claim.id === ref.selector!.id)
      : claims;
    let verified = false;
    const supportAuthorities: unknown[] = [];
    let completeAuthority = true;
    let parentAuthority: string | undefined;
    // A whole page may contain untagged assertions. Only exact verified spans
    // can support entailment; generated prose never becomes primary evidence.
    if (
      ref.selector?.kind === "claim" &&
      !target.stale &&
      selected[0]?.verification === "verified" &&
      selected[0]?.epistemicStatus === "asserted" &&
      (!requiresContextualProof(node.kind) || selected[0]?.verifier === CONTEXTUAL_VERIFIER) &&
      ((node.kind !== "doc_annotation" && node.kind !== "person_annotation") ||
        selected[0]?.verifier === ANNOTATION_CONTEXT_VERIFIER)
    ) {
      const claim = selected[0];
      const supports = getKnowledgeDependencies(this.db, node.id).filter(
        (dep) =>
          dep.claimId === claim.id &&
          dep.relation === "supports" &&
          (claim.supportLogic !== "any" || claim.witnessRefs.includes(dep.ref)),
      );
      const supported = supports.map((dep) => {
        try {
          const view = this.readReference(dep.ref, path, depth + 1, evaluation);
          if (this.captureAuthority) {
            completeAuthority &&= view[selectedReferenceAuthority] !== undefined;
            supportAuthorities.push([
              dep.ref,
              dep.relation,
              dep.inputVersion,
              view[selectedReferenceAuthority],
            ]);
          }
          return view.verified && !view.stale && view.revision === dep.inputVersion;
        } catch {
          return false;
        }
      });
      verified = supported.length > 0 && supported.every(Boolean);
      // Placement can include surrounding assertions. A child's proof must not
      // promote unverified enclosing prose into evidence for another synthesis.
      if (verified && claim.parentId && requiresContextualProof(node.kind)) {
        try {
          const parent = this.readReference(
            `${node.kind === "loop" ? "loop" : "wiki"}:${node.id}#claim:${claim.parentId}`,
            path,
            depth + 1,
            evaluation,
          );
          verified = parent.verified && !parent.stale;
          if (this.captureAuthority) {
            parentAuthority = parent[selectedReferenceAuthority];
            completeAuthority &&= parentAuthority !== undefined;
          }
        } catch {
          verified = false;
        }
      }
    }
    const referenceRelations = new Map<string, Record<string, KnowledgeRelation>>();
    if (ref.selector) {
      for (const dependency of getKnowledgeDependencies(this.db, node.id)) {
        const relations = referenceRelations.get(dependency.claimId) ?? {};
        relations[dependency.ref] = dependency.relation;
        referenceRelations.set(dependency.claimId, relations);
      }
    }
    const contexts = ref.selector
      ? knowledgeClaimContexts({
          ...node,
          claims: claims.map((claim) => ({
            id: claim.id,
            supportLogic: claim.supportLogic,
            validFrom: claim.validFrom,
            validUntil: claim.validUntil,
            attribution: claim.attribution,
            modality: claim.modality,
            epistemicStatus: claim.epistemicStatus,
            relations: referenceRelations.get(claim.id) ?? {},
          })),
        })
      : undefined;
    const selectedScopedNote =
      ref.selector &&
      (node.kind === "doc_annotation" || node.kind === "person_annotation" || node.kind === "loop");
    const scopedEvidence = selectedScopedNote
      ? JSON.stringify({
          sources: selected.map((claim) => ({
            authority: "selected_quote",
            title: null,
            text: contextualKnowledgeClaim(claim.text, contexts?.get(claim.id)),
            selectedQuotes: [claim.text],
          })),
          verifiedReferences: [],
          limitation:
            "Only the selected verified assertions authorize witnesses. Enclosing prose constrains interpretation and does not establish additional facts.",
        })
      : undefined;
    const claim = selected[0];
    const authority =
      this.captureAuthority && verified && completeAuthority && claim
        ? knowledgeHash({
            ref: value,
            revision: target.revision,
            node: [node.id, node.kind, node.ownerId, node.createdAt],
            claim: [
              claim.text,
              claim.parentId,
              claim.supportLogic,
              claim.fingerprint,
              claim.verifier,
              claim.witnessRefs,
              claim.validFrom,
              claim.validUntil,
              claim.attribution,
              claim.modality,
              claim.epistemicStatus,
            ],
            context: contexts?.get(claim.id),
            supports: supportAuthorities.sort((a, b) =>
              JSON.stringify(a).localeCompare(JSON.stringify(b)),
            ),
            parentAuthority,
          })
        : undefined;
    return {
      ...(authority === undefined ? {} : { [selectedReferenceAuthority]: authority }),
      ref: value,
      revision: target.revision,
      ...(scopedEvidence === undefined
        ? {}
        : {
            verifierEvidence: scopedEvidence,
            interpretationContext: contexts?.get(selected[0]!.id),
          }),
      text: selectedScopedNote
        ? selected.map((claim) => claim.text).join("\n")
        : ref.selector
          ? selected
              .map((claim) => contextualKnowledgeClaim(claim.text, contexts?.get(claim.id)))
              .join("\n")
          : node.plainText,
      stale: target.stale,
      verified,
    };
  }
}

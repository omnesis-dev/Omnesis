// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Model-facing synthesis boundary. Verification attestations never come from tool arguments. */
import { readKnowledgeOwner } from "./owner-adapters.js";
import { parseClaimMarkup } from "./claims.js";
import { assertKnowledgeClaimPreservation } from "./claim-preservation.js";
import { assertKnowledgeNavigation } from "./navigation.js";
import { readKnowledgeHistory, type KnowledgeHistoryRequest } from "./history-view.js";
import { uncoveredKnowledgeSpans } from "./coverage.js";
import { parseClaimReference, unavailableKnowledgeReference } from "./references.js";
import {
  getKnowledgeNode,
  getKnowledgeClaims,
  getKnowledgeDependencies,
  getKnowledgeEvidence,
  listKnowledgeNodes,
  resolveKnowledgeReference,
  knowledgeClaimFingerprint,
} from "./storage.js";
import {
  KnowledgeStorageError,
  type KnowledgeClaimState,
  type KnowledgeRelation,
  type KnowledgeNode,
  type KnowledgeRevision,
  type SaveKnowledgeNodeInput,
} from "./types.js";
import type { KnowledgeEditingSnapshot } from "./dependency-receipts.js";
import type { EntailCapability, Logger } from "@omnesis/core";
import type Database from "better-sqlite3";
import type { KnowledgeRunFence } from "./run-fence.js";
import type { KnowledgeWriteGate } from "./writer.js";
import type { ResolvedBrainSettings } from "../config.js";

export type KnowledgeProposal = Omit<
  SaveKnowledgeNodeInput,
  "claims" | "canonicalFields" | "rootMaxChars" | "enforceClaimPreservation"
> & {
  claims?: Omit<KnowledgeClaimState, "verification">[];
};
export interface KnowledgeServiceDeps {
  db: Database.Database;
  writeGate: KnowledgeWriteGate;
  getSettings: () => ResolvedBrainSettings;
  getEntailmentVerifier?: () => Promise<EntailCapability | null>;
  clock: () => number;
  log: Logger;
  mirror?: { refresh: (id: string) => Promise<void> };
}
export interface KnowledgeReferenceView {
  ref: string;
  revision: KnowledgeRevision;
  text: string;
  stale: boolean;
  /** A generated statement cannot become primary evidence just by being cited. */
  verified: boolean;
}

export class KnowledgeService {
  constructor(readonly deps: KnowledgeServiceDeps) {}

  history(input: KnowledgeHistoryRequest) {
    return readKnowledgeHistory(this.deps.db, input);
  }

  fetch(
    id: string,
    editing = false,
  ): (KnowledgeNode & { claims: ReturnType<typeof getKnowledgeClaims> }) | null {
    const node = getKnowledgeNode(this.deps.db, id);
    if (!node) return null;
    return {
      ...node,
      markdown: editing ? node.markdown : node.plainText,
      claims: getKnowledgeClaims(this.deps.db, id),
    };
  }

  /** The editing body and inherited dependency versions belong to one DB snapshot. */
  editingSnapshot(id: string): KnowledgeEditingSnapshot | null {
    return this.deps.db.transaction(() => {
      const node = this.fetch(id, true);
      return node ? { node, dependencies: getKnowledgeDependencies(this.deps.db, id) } : null;
    })();
  }

  list(options: Parameters<typeof listKnowledgeNodes>[1] = {}): KnowledgeNode[] {
    return listKnowledgeNodes(this.deps.db, options).map((node) => ({
      ...node,
      markdown: node.plainText,
    }));
  }

  reference(value: string): KnowledgeReferenceView {
    return this.readReference(value, new Set(), 0, { remaining: 8192, memo: new Map() });
  }

  private readReference(
    value: string,
    seen: Set<string>,
    depth: number,
    evaluation: { remaining: number; memo: Map<string, KnowledgeReferenceView> },
  ): KnowledgeReferenceView {
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
    evaluation: { remaining: number; memo: Map<string, KnowledgeReferenceView> },
  ): KnowledgeReferenceView {
    const path = new Set(seen);
    path.add(value);
    const ref = parseClaimReference(value);
    const target = resolveKnowledgeReference(this.deps.db, ref);
    if (ref.kind === "source") {
      const evidence = ref.selector ? getKnowledgeEvidence(this.deps.db, ref.selector.id) : null;
      const doc = this.deps.db
        .prepare<[string], { content: string }>("SELECT content FROM documents WHERE id=?")
        .get(ref.id);
      if (!doc || (ref.selector && !evidence)) throw unavailableKnowledgeReference(ref);
      return {
        ref: value,
        revision: target.revision,
        text: evidence?.quote ?? doc.content,
        stale: false,
        verified: true,
      };
    }
    const node = getKnowledgeNode(this.deps.db, target.targetId)!;
    if (ref.selector?.kind === "field") {
      return {
        ref: value,
        revision: target.revision,
        text: JSON.stringify(node.canonicalFields[ref.selector.id]),
        stale: target.stale,
        verified: !target.stale,
      };
    }
    const claims = getKnowledgeClaims(this.deps.db, node.id);
    const selected = ref.selector
      ? claims.filter((claim) => claim.id === ref.selector!.id)
      : claims;
    let verified = false;
    // A whole page may contain untagged assertions. Only exact verified spans
    // can support entailment; generated prose never becomes primary evidence.
    if (
      ref.selector?.kind === "claim" &&
      !target.stale &&
      selected[0]?.verification === "verified" &&
      selected[0]?.epistemicStatus === "asserted"
    ) {
      const claim = selected[0];
      const supports = getKnowledgeDependencies(this.deps.db, node.id).filter(
        (dep) =>
          dep.claimId === claim.id &&
          dep.relation === "supports" &&
          (claim.supportLogic !== "any" || claim.witnessRefs.includes(dep.ref)),
      );
      const supported = supports.map((dep) => {
        try {
          const view = this.readReference(dep.ref, path, depth + 1, evaluation);
          return view.verified && !view.stale && view.revision === dep.inputVersion;
        } catch {
          return false;
        }
      });
      verified = supported.length > 0 && supported.every(Boolean);
    }
    return {
      ref: value,
      revision: target.revision,
      text: ref.selector ? selected.map((claim) => claim.text).join("\n") : node.plainText,
      stale: target.stale,
      verified,
    };
  }

  async evidence(
    input: {
      documentId: string;
      contentHash: string;
      quote: string;
      start?: number;
    },
    runFence?: KnowledgeRunFence,
  ) {
    const evidence = await this.deps.writeGate["knowledge.evidence"](
      input,
      this.deps.clock(),
      runFence,
    );
    return {
      ...evidence,
      ref: `source:${evidence.documentId}#evidence:${evidence.id}`,
      revision: evidence.contentHash,
    };
  }

  async save(
    input: KnowledgeProposal,
    publication?: { candidateId: string; expectedCandidateRevision: number },
    runFence?: KnowledgeRunFence,
  ): Promise<import("./types.js").KnowledgeSaveResult> {
    if (publication && (input.kind !== "wiki" || input.expectedRevision !== 0))
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Candidate publication must create a new wiki",
      );
    const parsed = parseClaimMarkup(input.markdown);
    if (uncoveredKnowledgeSpans(parsed).length)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Every nonblank synthesis text span must be inside a claim tag; structural coverage is checked separately from factual support",
      );
    assertKnowledgeClaimPreservation(
      this.deps.db,
      input,
      parsed.claims.map((claim) => claim.id),
      parsed.text,
    );
    assertKnowledgeNavigation(this.deps.db, input, parsed.text);
    const owner =
      input.kind === "wiki" || input.kind === "root"
        ? null
        : readKnowledgeOwner(this.deps.db, input.kind, input.ownerId ?? input.id);
    if (owner && (input.id !== owner.id || input.ownerId !== owner.id))
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Owned synthesis must preserve its canonical identity",
      );
    const states: KnowledgeClaimState[] = [];
    const previousClaims = new Map(
      getKnowledgeClaims(this.deps.db, input.id).map((claim) => [claim.id, claim]),
    );
    const previousRelations = new Map<string, Map<string, KnowledgeRelation>>();
    for (const dependency of getKnowledgeDependencies(this.deps.db, input.id)) {
      let relations = previousRelations.get(dependency.claimId);
      if (!relations) {
        relations = new Map();
        previousRelations.set(dependency.claimId, relations);
      }
      relations.set(dependency.ref, dependency.relation);
    }
    let performedVerification = false;
    let verifier: EntailCapability | null = null;
    try {
      verifier = (await this.deps.getEntailmentVerifier?.()) ?? null;
    } catch {
      this.deps.log.warn("Knowledge verifier unavailable; retaining unverified claims");
    }
    for (const claim of parsed.claims) {
      const proposed = input.claims?.find((state) => state.id === claim.id);
      const previous = previousClaims.get(claim.id);
      const state: KnowledgeClaimState = {
        id: claim.id,
        supportLogic: proposed?.supportLogic ?? previous?.supportLogic,
        relations:
          proposed?.relations ??
          Object.fromEntries(
            claim.refs.flatMap<[string, KnowledgeRelation]>((ref) => {
              const relation = previousRelations.get(claim.id)?.get(ref.raw);
              return relation ? [[ref.raw, relation]] : [];
            }),
          ),
        validFrom: proposed?.validFrom === undefined ? previous?.validFrom : proposed.validFrom,
        validUntil: proposed?.validUntil === undefined ? previous?.validUntil : proposed.validUntil,
        attribution:
          proposed?.attribution === undefined ? previous?.attribution : proposed.attribution,
        modality: proposed?.modality ?? previous?.modality,
        epistemicStatus: proposed?.epistemicStatus ?? previous?.epistemicStatus,
      };
      const support: KnowledgeReferenceView[] = [];
      for (const ref of claim.refs) {
        const view = this.reference(ref.raw);
        if (input.inputVersions[ref.raw] !== view.revision) {
          const reason = Object.hasOwn(input.inputVersions, ref.raw) ? "Stale" : "Missing";
          const key = JSON.stringify(ref.raw);
          throw new KnowledgeStorageError(
            "revision_conflict",
            `${reason} dependency version for ${key}. Call knowledge_reference with {"ref":${key}}, review the returned evidence, and set node.inputVersions[${key}] to its returned revision before retrying knowledge_save. Reconcile the claim if the evidence changed; refreshing the frontier alone does not supply this dependency version.`,
          );
        }
        if ((state.relations?.[ref.raw] ?? "supports") === "supports") support.push(view);
      }
      if ((state.epistemicStatus ?? "asserted") !== "asserted") {
        states.push(state);
        continue;
      }
      const verifiedSupport = support.filter((view) => view.verified && !view.stale);
      const sufficientSupport =
        verifiedSupport.length > 0 &&
        (state.supportLogic === "any" || verifiedSupport.length === support.length);
      const fingerprint = knowledgeClaimFingerprint(claim, input.inputVersions, state);
      if (
        previous?.verification === "verified" &&
        previous.fingerprint === fingerprint &&
        sufficientSupport &&
        (state.supportLogic !== "any" ||
          (previous.witnessRefs.length > 0 &&
            previous.witnessRefs.every((ref) => verifiedSupport.some((view) => view.ref === ref))))
      ) {
        state.verification = {
          status: "verified",
          fingerprint,
          verifier: "retained-entailment-verifier",
          witnessRefs: previous.witnessRefs,
        };
        states.push(state);
        continue;
      }
      // Verification of a generated prior requires verified support all the way
      // back to evidence. A relation-only or context-only reference is not proof.
      if (verifier && sufficientSupport) {
        const pieces =
          state.supportLogic === "any"
            ? verifiedSupport.map((view) => ({ text: view.text, refs: [view.ref] }))
            : [
                {
                  text: support.map((view) => view.text).join("\n\n"),
                  refs: support.map((view) => view.ref),
                },
              ];
        let accepted = false;
        let witnessRefs: string[] = [];
        let unavailable = false;
        for (const evidence of pieces) {
          try {
            const verdict = await this.verify(verifier, claim.text, evidence.text);
            if (verdict.label === "entailment") {
              accepted = true;
              witnessRefs = evidence.refs;
              break;
            }
          } catch {
            unavailable = true;
          }
        }
        if (!accepted && !unavailable)
          throw new KnowledgeStorageError(
            "claim_invalid",
            `Claim ${claim.id} is not entailed by its cited support`,
          );
        if (accepted) {
          performedVerification = true;
          state.verification = {
            status: "verified",
            fingerprint: knowledgeClaimFingerprint(claim, input.inputVersions, state),
            verifier: "entailment-verifier",
            witnessRefs,
          };
        }
      }
      states.push(state);
    }
    const priorMetadata = getKnowledgeNode(this.deps.db, input.id)?.metadata;
    const metadata = {
      ...priorMetadata,
      ...input.metadata,
      lastVerifiedAt: priorMetadata?.lastVerifiedAt ?? null,
      lastReviewedAt: priorMetadata?.lastReviewedAt ?? null,
      reviewDecision: priorMetadata?.reviewDecision,
      reviewReason: priorMetadata?.reviewReason,
      reviewDecidedAt: priorMetadata?.reviewDecidedAt,
    };
    if (
      performedVerification &&
      states.length > 0 &&
      states.every((state) => state.verification?.status === "verified")
    )
      metadata.lastVerifiedAt = this.deps.clock();
    const node = {
      ...input,
      enforceClaimPreservation: true,
      runFence,
      metadata,
      canonicalFields: owner?.canonicalFields ?? {},
      claims: states,
      rootMaxChars: this.deps.getSettings().knowledge.rootMaxChars,
    };
    const result = owner
      ? await this.deps.writeGate["knowledge.saveOwned"](
          { node, ownerVersion: owner.versionFingerprint },
          this.deps.clock(),
        )
      : publication
        ? await this.deps.writeGate["knowledge.publishCandidate"](
            { ...publication, node },
            this.deps.clock(),
          )
        : await this.deps.writeGate["knowledge.save"](node, this.deps.clock());
    await this.deps.mirror?.refresh(result.node.id);
    // Projection writes can yield to a purge or another synthesis. Never return
    // the captured pre-await prose after its authoritative state has changed.
    const current = getKnowledgeNode(this.deps.db, result.node.id);
    if (!current)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Saved synthesis is no longer available",
      );
    if (current.revision !== result.node.revision)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Saved synthesis changed during projection",
      );
    return { ...result, node: current };
  }

  private async verify(verifier: EntailCapability, claim: string, evidence: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        verifier.verify({ claim, evidence }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Knowledge entailment deadline exceeded")),
            45000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

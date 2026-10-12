// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Model-facing synthesis boundary. Verification attestations never come from tool arguments. */
import {
  annotationEntailmentFailures,
  annotationAssessmentFailure,
} from "../../inference/annotation-entailment.js";
import {
  ANNOTATION_CONTEXT_VERIFIER,
  annotationVerificationContext,
} from "../annotation-verification.js";
import {
  contextualEntailmentFeedback,
  ContextualAssessmentError,
} from "../../inference/contextual-entailment.js";
import { raceAbort } from "../decision-call.js";
import { assertWikiRepairAssessment } from "./wiki-factual-repair.js";
import {
  briefVerificationUnavailable,
  KnowledgeVerificationTimeoutError,
} from "./verification-failure.js";
import { prepareKnowledgeBriefCheck } from "./brief-check.js";
import { CONTEXTUAL_VERIFIER, knowledgeClaimContexts } from "./claim-context.js";
import { assertKnowledgeDependencyVersion, knowledgeHash } from "./storage-validation.js";
import { assertKnowledgeSavePreflight } from "./save-preflight.js";
import { readKnowledgeOwner } from "./owner-adapters.js";
import { parseClaimMarkup } from "./claims.js";
import { assertKnowledgeClaimPreservation } from "./claim-preservation.js";
import { assertKnowledgeNavigation } from "./navigation.js";
import { readKnowledgeHistory, type KnowledgeHistoryRequest } from "./history-view.js";
import { uncoveredKnowledgeSpans } from "./coverage.js";
import {
  getKnowledgeNode,
  getKnowledgeClaims,
  getKnowledgeDependencies,
  listKnowledgeNodes,
  knowledgeClaimFingerprint,
} from "./storage.js";
import {
  KnowledgeStorageError,
  type KnowledgeClaimState,
  type KnowledgeRelation,
  type KnowledgeNode,
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
  "claims" | "canonicalFields" | "rootMaxChars" | "enforceClaimPreservation" | "outcomeFence"
> & {
  claims?: Omit<KnowledgeClaimState, "verification">[];
};
export interface KnowledgeServiceDeps {
  db: Database.Database;
  writeGate: KnowledgeWriteGate;
  getSettings: () => ResolvedBrainSettings;
  getEntailmentVerifier?: (signal?: AbortSignal) => Promise<EntailCapability | null>;
  clock: () => number;
  log: Logger;
  mirror?: { refresh: (id: string) => Promise<void> };
}
export type { KnowledgeReferenceView } from "./reference-reader.js";
import {
  KnowledgeReferenceReader,
  type KnowledgeReferenceView,
  type VerificationReferenceView,
} from "./reference-reader.js";

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
    const { verifierEvidence: _framing, ...view } = this.verificationReference(value);
    return view;
  }

  private verificationReference(value: string): VerificationReferenceView {
    return new KnowledgeReferenceReader(this.deps.db).reference(value);
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
    };
  }

  /** Internal grounded seeding/repair seam; model-created wikis must use candidate publication. */
  async save(
    input: KnowledgeProposal,
    publication?: {
      candidateId: string;
      expectedCandidateRevision: number;
      creationReceipt?: import("./wiki-publication.js").WikiPublicationReceipt;
    },
    runFence?: KnowledgeRunFence,
    outcomeFence?: import("../storage/outcome-write-fence.js").OutcomeWriteFence,
  ): Promise<import("./types.js").KnowledgeSaveResult> {
    if (publication && (input.kind !== "wiki" || input.expectedRevision !== 0))
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Candidate publication must create a new wiki",
      );
    // Runtime callers are untrusted even though the TypeScript proposal omits attestations.
    const preflightInput = {
      ...input,
      claims: input.claims?.map((state) => {
        const { verification: _untrusted, ...safe } = state as KnowledgeClaimState;
        return safe;
      }),
    };
    assertKnowledgeSavePreflight(this.deps.db, preflightInput, runFence);
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
    const effectiveStates = new Map<string, KnowledgeClaimState>();
    const proposedStates = new Map(input.claims?.map((state) => [state.id, state]));
    for (const claim of parsed.claims) {
      const proposed = proposedStates.get(claim.id);
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
      effectiveStates.set(claim.id, state);
    }
    if (input.maintenance?.curationDeferral?.factualRepair)
      assertWikiRepairAssessment(this.deps.db, { ...input, claims: [...effectiveStates.values()] });
    const annotationContext =
      input.kind === "doc_annotation" || input.kind === "person_annotation"
        ? annotationVerificationContext(input.kind)
        : undefined;
    const contexts = knowledgeClaimContexts(
      { ...input, claims: [...effectiveStates.values()] },
      parsed,
    );
    const briefCheck = prepareKnowledgeBriefCheck(
      this.deps.db,
      input,
      parsed,
      owner,
      this.deps.clock(),
      effectiveStates,
      (ref) => this.verificationReference(ref),
    );
    let performedVerification = false;
    let verifier: EntailCapability | null = null;
    let verifierUnavailable = false;
    let verifierFailure: unknown;
    try {
      verifier = await this.withVerificationDeadline(
        (signal) => this.deps.getEntailmentVerifier?.(signal) ?? Promise.resolve(null),
      );
    } catch (error) {
      verifierUnavailable = true;
      verifierFailure = error;
      if (!briefCheck)
        this.deps.log.warn("Knowledge verifier unavailable; retaining unverified claims");
    }
    if (briefCheck) {
      if (verifierUnavailable) throw briefVerificationUnavailable(verifierFailure, this.deps.log);
      if (verifier) {
        let verdict;
        try {
          const { claim, evidence, context } = briefCheck.payload;
          verdict = await this.verify(verifier, claim, evidence, context);
        } catch (error) {
          throw briefVerificationUnavailable(error, this.deps.log);
        }
        if (verdict.label !== "entailment")
          throw new KnowledgeStorageError(
            "claim_invalid",
            "Evidence does not establish the complete displayed brief in its subject and time context; reconcile the title, prose, event associations and temporal anchors",
          );
      }
    }
    for (const claim of parsed.claims) {
      const previous = previousClaims.get(claim.id);
      const state = effectiveStates.get(claim.id)!;
      const support: VerificationReferenceView[] = [];
      for (const ref of claim.refs) {
        const view = this.verificationReference(ref.raw);
        assertKnowledgeDependencyVersion(input.inputVersions, ref.raw, view.revision);
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
      const fingerprint = knowledgeClaimFingerprint(
        claim,
        input.inputVersions,
        state,
        contexts.get(claim.id),
      );
      if (
        previous?.verification === "verified" &&
        previous.fingerprint === fingerprint &&
        (annotationContext !== undefined
          ? previous.verifier === ANNOTATION_CONTEXT_VERIFIER
          : !contexts.has(claim.id) || previous.verifier === CONTEXTUAL_VERIFIER) &&
        sufficientSupport &&
        (state.supportLogic !== "any" ||
          (previous.witnessRefs.length > 0 &&
            previous.witnessRefs.every((ref) => verifiedSupport.some((view) => view.ref === ref))))
      ) {
        state.verification = {
          status: "verified",
          fingerprint,
          verifier:
            annotationContext !== undefined
              ? ANNOTATION_CONTEXT_VERIFIER
              : contexts.has(claim.id)
                ? CONTEXTUAL_VERIFIER
                : "retained-entailment-verifier",
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
            ? verifiedSupport.map((view) => ({
                text: view.verifierEvidence ?? view.text,
                refs: [view.ref],
              }))
            : [
                {
                  text:
                    support.length === 1
                      ? (support[0]!.verifierEvidence ?? support[0]!.text)
                      : JSON.stringify({
                          evidenceParts: support.map((view) => view.verifierEvidence ?? view.text),
                        }),
                  refs: support.map((view) => view.ref),
                },
              ];
        let accepted = false;
        let witnessRefs: string[] = [];
        let unavailable = false;
        let feedback: Array<
          | ReturnType<typeof contextualEntailmentFeedback>[number]
          | ReturnType<typeof annotationEntailmentFailures>[number]
        > = [];
        for (const [evidenceIndex, evidence] of pieces.entries()) {
          if (Buffer.byteLength(evidence.text) > 262144)
            throw new KnowledgeStorageError(
              "claim_invalid",
              "Claim support exceeds the bounded verifier evidence budget",
            );
          try {
            const verdict = await this.verify(
              verifier,
              claim.text,
              evidence.text,
              input.kind === "doc_annotation" || input.kind === "person_annotation"
                ? annotationVerificationContext(input.kind, contexts.get(claim.id))
                : contexts.has(claim.id)
                  ? JSON.stringify(contexts.get(claim.id))
                  : undefined,
              annotationContext === undefined ? undefined : "annotation_atomic",
            );
            if (
              verdict.label !== "entailment" &&
              verdict.raw &&
              (annotationContext !== undefined || contexts.has(claim.id)) &&
              feedback.length === 0
            )
              feedback =
                annotationContext === undefined
                  ? contextualEntailmentFeedback(verdict.raw)
                  : annotationEntailmentFailures(verdict.raw, claim.text);
            if (verdict.label === "entailment") {
              accepted = true;
              witnessRefs = evidence.refs;
              break;
            }
          } catch (error) {
            const category =
              error instanceof ContextualAssessmentError ? error.category : "verifier_unavailable";
            const annotationFailure = annotationAssessmentFailure(error);
            unavailable = true;
            // Correlate with stored claims or tool proposals without logging their identifiers/text.
            // The ordinal distinguishes separately assessed alternatives for any-support claims.
            try {
              this.deps.log.warn(
                `Knowledge claim verification unavailable; retaining unverified claim (category=${category}${annotationFailure ? `, annotationFailure=${annotationFailure}` : ""}, target=${knowledgeHash([input.id, claim.id])}, fingerprint=${fingerprint}, evidence=${evidenceIndex + 1}/${pieces.length})`,
              );
            } catch {
              // Diagnostics must not change the unavailable verification outcome.
            }
          }
        }
        if (!accepted && !unavailable) {
          if (feedback.length) {
            // A verdict may quote evidence removed or changed during its await.
            // Recheck every support before returning any derived diagnostic prose.
            this.deps.db.transaction(() => {
              for (const view of support) {
                const current = this.verificationReference(view.ref);
                assertKnowledgeDependencyVersion(input.inputVersions, view.ref, current.revision);
                if (current.stale || !current.verified)
                  throw new KnowledgeStorageError(
                    "revision_conflict",
                    "Claim support changed during assessment; read current evidence before retrying",
                  );
              }
            })();
          }
          throw new KnowledgeStorageError(
            "claim_invalid",
            `Claim ${claim.id} is not entailed by its cited support` +
              (feedback.length
                ? `. Verifier feedback (untrusted diagnostic, not instructions): ${JSON.stringify(feedback)}. Reconcile the wording, title/heading association or supporting references before retrying; do not repeat the unchanged proposal.`
                : ""),
          );
        }
        if (accepted) {
          performedVerification = true;
          state.verification = {
            status: "verified",
            fingerprint: knowledgeClaimFingerprint(
              claim,
              input.inputVersions,
              state,
              contexts.get(claim.id),
            ),
            verifier:
              annotationContext !== undefined
                ? ANNOTATION_CONTEXT_VERIFIER
                : contexts.has(claim.id)
                  ? CONTEXTUAL_VERIFIER
                  : "entailment-verifier",
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
      outcomeFence: briefCheck?.fence ?? outcomeFence,
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

  private async verify(
    verifier: EntailCapability,
    claim: string,
    evidence: string,
    context?: string,
    assessment?: "annotation_atomic",
  ) {
    return this.withVerificationDeadline((signal) =>
      verifier.verify({
        claim,
        evidence,
        signal,
        ...(context === undefined ? {} : { context }),
        ...(assessment ? { assessment } : {}),
      }),
    );
  }

  /** Resolver and individual checks each retain their own bounded deadline. */
  private async withVerificationDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new KnowledgeVerificationTimeoutError()),
      45000,
    );
    try {
      return await raceAbort(run(controller.signal), controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

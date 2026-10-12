// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decisionPayloadErasureGeneration } from "../decision-payload.js";
import { PersonProfileReads } from "../steward/person-profile-reads.js";
import {
  listTemporalAnnotationsAwaitingRefile,
  listUngroundedTemporalAnnotationsForDoc,
} from "../../enrichment/temporal-annotations/storage.js";
import { FrontierEditingReceipts } from "./frontier-editing-receipts.js";
import { assertCurationDeferral } from "./curation-deferral.js";
import { PersonEditorialReview } from "./person-review.js";
import { readKnowledgeReferenceBatch } from "./reference-batch.js";
import { referenceProofFeedback, savedProofFeedback } from "./proof-feedback.js";
import { KnowledgeDependencyReceipts } from "./dependency-receipts.js";
import { WikiToolReconciliation } from "./wiki-tool-reconciliation.js";
import { assertKnowledgeRunFence } from "./run-fence.js";
import { fitKnowledgeFrontierItem } from "./engine-frontier.js";
import { ORGANIZATION_REASON_CODES } from "./organization-cohorts.js";
import { WikiPublicationReads, assertWikiPublicationReceipt } from "./wiki-publication.js";
import { WikiValueCheck } from "./wiki-value-check.js";
import {
  assertKnowledgeCandidateEvidenceIds,
  getKnowledgeCandidate,
  listKnowledgeCandidates,
} from "./discovery.js";
import { KnowledgeStorageError } from "./types.js";
import { listKnowledgeLinks } from "./links.js";
import { checkKnowledgeOutcome, KnowledgeOutcomeRejected } from "./outcome-check.js";
import { LOOP_FIELD_REFERENCE_GUIDANCE } from "./references.js";
import { assertKnowledgeSavePreflight } from "./save-preflight.js";
import { ClaimMarkupError } from "./claims.js";
import type { CheckRecord } from "../record-check/check.js";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
import type { KnowledgeService } from "./service.js";
import type { KnowledgeEngine, KnowledgeFrontierView } from "./engine.js";

const id = z.string().min(1).max(256);
const versions = z.record(z.string(), z.union([z.string(), z.number().int().nonnegative()]));
const claimState = z
  .object({
    id,
    supportLogic: z
      .enum(["all", "any"])
      .optional()
      .describe("Omit to preserve the existing claim support logic; new claims default to all."),
    attribution: z.string().trim().min(1).max(1000).nullable().optional(),
    modality: z
      .enum([
        "observation",
        "reported",
        "proposal",
        "commitment",
        "inference",
        "recommendation",
        "question",
      ])
      .optional(),
    epistemicStatus: z.enum(["asserted", "disputed", "unsupported"]).optional(),
    relations: z
      .record(z.string(), z.enum(["supports", "contradicts", "context", "depends_on"]))
      .optional()
      .describe(
        "Omit to preserve relations for retained refs, including context-only converted owner refs; new refs default to supports. After reading the evidence, explicitly map each entailing ref to supports for verifier checking and keep merely related refs as context. An explicit map replaces the previous map; {} resets every ref to supports, so do not use it to promote unreviewed context. Claim markup alone is not verification.",
      ),
    validFrom: z
      .number()
      .optional()
      .nullable()
      .describe("Omit to retain the existing bound; null clears it."),
    validUntil: z
      .number()
      .optional()
      .nullable()
      .describe("Omit to retain the existing bound; null clears it."),
  })
  .strict();
const proposal = z
  .object({
    id,
    kind: z.enum(["wiki", "root", "loop", "doc_annotation", "person_annotation", "brief"]),
    ownerId: id.nullable().optional(),
    title: z.string().min(1).max(1000),
    markdown: z.string().max(262144),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Stored node revision, never a candidate revision. Use 0 when creating a new node. For an existing wiki, read knowledge_fetch({id,editing:true}) and copy its returned node revision; do not guess or copy the publication candidate revision.",
      ),
    inputVersions: versions.describe(
      "Inside node: map EVERY claim ref in the proposed markdown to the exact revision returned by knowledge_reference for that ref. Include newly added dependencies: the offered frontier only includes existing input context and does not supply versions for all new citations. Reading a wiki does not automatically read its cited sources. Fetch each new ref or cite a fetched wiki claim directly; never invent a version or drop useful grounded context merely to avoid fetching it.",
    ),
    claims: z.array(claimState).max(1024).optional(),
    claimRemovals: z
      .array(z.object({ id, reason: z.string().trim().min(1).max(1000) }).strict())
      .max(1024)
      .optional()
      .describe(
        "Wiki/root full replacement only: explicitly name each existing claim deliberately omitted and explain why. Preserve all other claim spans. reviewedClaimIds does not authorize removal. New pages cannot remove claims; empty wiki replacements are refused.",
      ),
    navigationRemovals: z
      .array(z.object({ targetId: id, reason: z.string().trim().min(1).max(1000) }).strict())
      .max(128)
      .optional()
      .describe(
        "Existing root only: name each previously linked readable wiki deliberately omitted, with a local orientation, association, replacement or budget reason. Retained links need no entry. Factual repair does not require dropping independently useful navigation; links never establish facts. Unavailable targets need no removal entry.",
      ),
    metadata: z
      .object({
        importance: z.number().min(0).max(1).optional(),
        volatility: z.number().min(0).max(1).optional(),
        uncertainty: z.number().min(0).max(1).optional(),
        activity: z.enum(["active", "quiet", "historical"]).optional(),
        nextReviewAt: z.number().optional().nullable(),
        checkpointAt: z.number().optional().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  mutates: boolean,
  run: (input: z.output<S>, signal?: AbortSignal) => unknown | Promise<unknown>,
): ToolHandle {
  return {
    name,
    description,
    schema,
    mutates,
    async invoke(args, invocation): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success)
        return { kind: "error", code: "invalid_arguments", message: parsed.error.message };
      try {
        return {
          kind: "structured",
          resultType: name,
          data: await run(parsed.data, invocation.abortSignal),
        };
      } catch (error) {
        if (error instanceof KnowledgeOutcomeRejected)
          return {
            kind: "structured",
            resultType: "record.not_saved",
            data: {
              reason: `Outcome revision not supported (${error.questionId ?? "belongs"} score ${error.score.toFixed(2)}, below ${error.threshold})`,
              guidance:
                error.questionId === "deadline_support"
                  ? "Keep the useful outcome: use open_loop_update with deadline:null to clear an unsupported deadline, or retrieve evidence establishing this exact action due time before updating it. Then fetch the fresh canonical loop projection and frontier before knowledge_save. Deadline is a canonical loop field, not a knowledge node field. Preserve precision and conditions; expected events and review times are not action deadlines. Existing content and work remain unchanged until a corrected save."
                  : error.questionId === "transition_integrity"
                    ? "Existing canonical content and maintenance work remain unchanged. Re-read the current outcome and original evidence; preserve the supported action, progress and scope or establish the correction with evidence. Submit a substantively corrected revision, not the same proposal rephrased to bypass the check."
                    : "Not saved. Do not retry or reword this proposal. Existing canonical content and maintenance work remain unchanged. Complete unchanged proof maintenance only if current evidence supports it; otherwise leave the unsupported work pending.",
            },
          };
        if (error instanceof KnowledgeStorageError || error instanceof ClaimMarkupError)
          return { kind: "error", code: error.code, message: error.message };
        throw error;
      }
    },
  };
}
export const KNOWLEDGE_MUTATING_TOOLS = new Set([
  "loop_synthesis_save",
  "brief_synthesis_save",
  "doc_annotation_synthesis_save",
  "person_annotation_synthesis_save",
  "knowledge_link",
  "knowledge_evidence",
  "knowledge_save",
  "knowledge_propose_page",
  "knowledge_candidate_decide",
  "knowledge_next_frontier",
  "knowledge_discovery_complete",
  "knowledge_organization_complete",
  "knowledge_temporal_context",
]);

export function buildKnowledgeTools(
  service: KnowledgeService,
  context: {
    runId: string;
    checkRecord?: CheckRecord;
    personProfileReads?: PersonProfileReads;
    incompleteRetrievalBoundary?: () => string | undefined;
    /** Narrow workflows receive only artifact-scoped owner mutation variants. */
    scopedOwnersOnly?: boolean;
    /** Capture collection read receipts for independently executing maintenance. */
    parallel?: boolean;
    engine?: KnowledgeEngine;
    batchId?: string;
    markTemporalPresented?: (ids: readonly string[], runId: string) => Promise<void>;
  },
): ToolHandle[] {
  const personReview = new PersonEditorialReview(
    service.deps.db,
    context.personProfileReads ?? new PersonProfileReads(service.deps.db),
  );
  const dependencyReceipts = new KnowledgeDependencyReceipts();
  const frontierEditing = new FrontierEditingReceipts(() =>
    decisionPayloadErasureGeneration(service.deps.db),
  );
  const publicationReads = new WikiPublicationReads(service.deps.db);
  const wikiValue = new WikiValueCheck(service, context.checkRecord);
  const runFence = context.batchId ? { batchId: context.batchId, runId: context.runId } : undefined;
  const placementReads = runFence
    ? new WikiToolReconciliation(service.deps.db, runFence)
    : undefined;
  const reconciliation = context.parallel ? placementReads : undefined;
  const guarded = (entries: ToolHandle[]): ToolHandle[] =>
    entries.map((entry) =>
      !entry.mutates || !runFence || entry.name === "knowledge_next_frontier"
        ? entry
        : {
            ...entry,
            async invoke(args, invocation) {
              try {
                assertKnowledgeRunFence(service.deps.db, runFence);
              } catch (error) {
                if (error instanceof KnowledgeStorageError)
                  return { kind: "error", code: error.code, message: error.message };
                throw error;
              }
              return entry.invoke(args, invocation);
            },
          },
    );
  const tools: ToolHandle[] = [
    tool(
      "knowledge_candidates",
      "Inspect page candidates before creating or organizing a subject. Follow nextCursor even when a privacy-filtered page has no items.",
      z
        .object({
          afterId: id.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          status: z.enum(["proposed", "deferred", "published", "merged", "dismissed"]).optional(),
        })
        .strict(),
      false,
      (input) =>
        publicationReads.snapshot(
          () =>
            reconciliation
              ? reconciliation.read(
                  () => listKnowledgeCandidates(service.deps.db, input),
                  (result) => [
                    ...(input.status === undefined && input.afterId === undefined
                      ? ["candidates"]
                      : []),
                    ...result.items.map((candidate) => `candidate:${candidate.id}`),
                  ],
                )
              : listKnowledgeCandidates(service.deps.db, input),
          (result) => {
            publicationReads.candidatesRead(
              result.items.map((candidate) => candidate.id),
              input.status === undefined && input.afterId === undefined,
            );
          },
        ),
    ),
    tool(
      "knowledge_candidate_decide",
      "Defer or dismiss a candidate, reconsider it, or reconcile it into an existing canonical wiki after updating that page's grounding. Publication of a new wiki is atomic through knowledge_save.",
      z
        .object({
          id,
          expectedRevision: z.number().int().positive(),
          status: z.enum(["proposed", "deferred", "dismissed", "merged"]),
          nodeId: id.optional(),
          reconsiderAt: z.number().optional(),
        })
        .strict(),
      true,
      async (input) => {
        const fence =
          reconciliation?.fence(
            input.status === "merged"
              ? ["pages", `candidate:${input.id}`]
              : [`candidate:${input.id}`],
          ) ?? runFence;
        const result = await service.deps.writeGate["knowledge.settleCandidate"](
          input,
          service.deps.clock(),
          fence,
        );
        return reconciliation && fence
          ? reconciliation.accept(result, fence, [`candidate:${result.id}`])
          : result;
      },
    ),
    tool(
      "knowledge_links",
      "Read organizational links around a synthesis node. These links are distinct from evidence dependencies in claim refs.",
      z.object({ id }).strict(),
      false,
      (input) => listKnowledgeLinks(service.deps.db, input.id),
    ),
    tool(
      "knowledge_link",
      "Organize context and outcomes. belongs_to_project connects a node to its project wiki; part_of connects subloops to loops or pages to parent pages. These are navigation links and do not imply evidential support. Actual hierarchy changes schedule review of affected wiki/root pages. After changing hierarchy during maintenance, call knowledge_next_frontier before saving an affected page so its topology input is current. Change operational blocking through open_loop_update.",
      z
        .object({
          fromId: id,
          toId: id,
          kind: z.enum([
            "related_to",
            "belongs_to_project",
            "part_of",
            "supersedes",
            "duplicate_of",
          ]),
          fromRevision: z.number().int().positive(),
          toRevision: z.number().int().positive(),
          remove: z.boolean().optional(),
        })
        .strict(),
      true,
      (input) => service.deps.writeGate["knowledge.link"](input, runFence, service.deps.clock()),
    ),
    tool(
      "knowledge_fetch",
      "Read a synthesis node. A complete fetch records exact whole-node and returned claim versions for knowledge_save support; it does not read their original source evidence. Set editing=true only to repair its tagged claims; normal reading strips tags.",
      z.object({ id, editing: z.boolean().default(false) }).strict(),
      false,
      (input) => {
        const read = () => {
          if (!input.editing) return service.fetch(input.id, false);
          const snapshot = service.editingSnapshot(input.id);
          if (snapshot) {
            dependencyReceipts.rememberEditing(snapshot);
            if (context.engine && context.batchId)
              frontierEditing.editing(snapshot, (fingerprint) => {
                context.engine!.preflightSaveNode(
                  context.batchId!,
                  context.runId,
                  input.id,
                  fingerprint,
                );
              });
          }
          return snapshot?.node ?? null;
        };
        const result = service.deps.db.transaction(() => {
          const node = placementReads ? placementReads.readNode(read) : read();
          if (node) dependencyReceipts.rememberNode(node);
          return node;
        })();
        publicationReads.nodeRead(result);
        return result;
      },
    ),
    tool(
      "knowledge_list",
      "List synthesis nodes for orientation; use search_many to retrieve their indexed contents.",
      z
        .object({
          kind: z
            .enum(["wiki", "root", "loop", "doc_annotation", "person_annotation", "brief"])
            .optional(),
          afterId: id.optional(),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
      false,
      (input) =>
        publicationReads.snapshot(
          () =>
            placementReads
              ? placementReads.read(
                  () => service.list(input),
                  (nodes) => [
                    ...((input.kind === undefined || input.kind === "wiki") &&
                    input.afterId === undefined
                      ? ["pages"]
                      : []),
                    ...(input.kind === "wiki" && input.afterId === undefined ? ["wikiPages"] : []),
                    ...nodes
                      .filter((node) => node.kind === "wiki")
                      .map((node) => `node:${node.id}`),
                  ],
                )
              : service.list(input),
          () => {
            if ((input.kind === undefined || input.kind === "wiki") && input.afterId === undefined)
              publicationReads.library();
          },
        ),
    ),
    tool(
      "knowledge_reference",
      "Resolve one reference with {ref}, or batch up to 16 with {refs}. Batch results contain complete successful views or per-item errors; retry deferredRefs in another batch and oversized references singly. Only returned successful views grant read receipts. Resolve an exact claim or evidence reference and read its current version. For a fetched document use source:<documentId>, not doc: or document:. Optional selectors: source:<documentId>#evidence:<evidenceId>, wiki:<pageId>#claim:<claimId> (also loop, annotation or brief claims), or loop:<loopId>#field:<fieldName>. Use exact tool-returned IDs. knowledge_save retains this exact read revision for the current run, so you can omit its inputVersions entry. Explicit version overrides remain supported and are never silently refreshed. Scoped owner synthesis tools still require explicit versions. " +
        LOOP_FIELD_REFERENCE_GUIDANCE,
      z.union([
        z.object({ ref: z.string().min(1).max(1024) }).strict(),
        z
          .object({ refs: z.array(z.string().min(1).max(1024)).min(1).max(16) })
          .strict()
          .refine(
            (input) => Buffer.byteLength(JSON.stringify(input.refs)) <= 16 * 1024,
            "Batch references exceed the 16 KiB serialized input budget; use a smaller batch",
          ),
      ]),
      false,
      (input) => {
        if ("refs" in input) {
          const batch = service.deps.db.transaction(() =>
            readKnowledgeReferenceBatch(input.refs, (ref) =>
              referenceProofFeedback(service.reference(ref)),
            ),
          )();
          for (const item of batch.items)
            if (item.ok) dependencyReceipts.rememberReference(item.value);
          return batch;
        }
        const result = service.deps.db.transaction(() =>
          referenceProofFeedback(service.reference(input.ref)),
        )();
        dependencyReceipts.rememberReference(result);
        return result;
      },
    ),
    tool(
      "knowledge_history",
      "Read privacy-fenced historical synthesis context, never current proof. List bounded meaningful revision summaries with {id,beforeRevision?,limit?}: newest snapshot, content/title edits and oldest retained baseline, skipping verification-only repeats. removedClaimCount reports actual prior claim IDs lost, including legacy replacements; declaredRemovalIntentCount is separate. Follow nextBeforeRevision to locate earlier useful context; read a selected snapshot with {id,revision,offset?} and follow nextOffset to reassemble all chunks. Consult history when a wiki review finds missing context or destructive prior changes. Reconcile historical claims with current sources and later developments before restoring warranted knowledge; history does not grant mutation authority or current evidence versions.",
      z.union([
        z
          .object({
            id,
            beforeRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
            limit: z.number().int().min(1).max(5).optional(),
          })
          .strict(),
        z
          .object({
            id,
            revision: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER - 1),
            offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
          })
          .strict(),
      ]),
      false,
      (input) => service.history(input),
    ),
    tool(
      "knowledge_evidence",
      "Register an exact source quote against the contentHash actually read (returned by knowledge_reference or the source frontier). Copy one contiguous passage verbatim, including punctuation and line breaks; do not reconstruct or join excerpts. Registration is optional: the already-read whole source:<documentId> can be cited directly. Do not substitute the semantic revision/sourceRevision: it also versions title and dates. Returns a stable addressable evidence reference and records its exact version for knowledge_save in this run; explicit inputVersions overrides remain authoritative. This reference supplies only the quoted text: surrounding author, date and other document context are not implicitly included. If a claim needs that context, quote a sufficient contextual span or cite the already-read whole source as support as well. Headings inside claim tags must also be supported.",
      z
        .object({
          documentId: id,
          contentHash: z.string().min(1),
          quote: z.string().min(1).max(32000),
          start: z.number().int().nonnegative().optional(),
        })
        .strict(),
      true,
      async (input) => {
        const result = await service.evidence(input, runFence);
        // Registration returns the exact quote and its committed version. This
        // observes only that selected reference, never the whole source.
        dependencyReceipts.rememberReference(result);
        return result;
      },
    ),
    tool(
      "knowledge_propose_page",
      'First call knowledge_list({kind:"wiki"}) and knowledge_candidates({}) without status or afterId filters; follow pagination when needed to inspect relevant scopes. After a revision_conflict, repeat both initial reads and retry if the proposed scope is still useful. Otherwise retain or defer an existing candidate with knowledge_candidate_decide, or record an offered organization cohort as deferred/no_page using knowledge_organization_complete and its supported reasonCode; a failed proposal is not publication or a no-page judgment. Propose a reusable page with a stable identity key, distinct scope and evidence versions keyed by bare document IDs (not source: references). Prefer extending existing context; a document alone does not require its own wiki.',
      z
        .object({
          identityKey: z.string().min(1).max(500),
          title: z.string().min(1).max(1000),
          scope: z.string().min(1).max(8000),
          evidenceVersions: z
            .record(
              z
                .string()
                .describe(
                  'Bare documentId returned by a source read; not a "source:<documentId>" reference.',
                ),
              z
                .string()
                .describe(
                  "Exact observed source revision; never substitute a body hash or guess a version.",
                ),
            )
            .describe(
              "Map bare document IDs to their exact observed source revisions. This key shape differs from knowledge_save inputVersions, which uses reference strings.",
            ),
        })
        .strict(),
      true,
      async (input) => {
        assertKnowledgeCandidateEvidenceIds(Object.keys(input.evidenceVersions));
        const expectedInventoryRevision = publicationReads.assertInspected();
        const fence = runFence;
        const result = await service.deps.writeGate["knowledge.proposeCandidate"](
          { id: `candidate_${randomUUID()}`, ...input, expectedInventoryRevision },
          service.deps.clock(),
          fence,
        );
        publicationReads.acceptProposal(result.id, result.creationInventoryRevision);
        return reconciliation && fence
          ? reconciliation.accept(result, fence, [`candidate:${result.id}`])
          : result;
      },
    ),
    tool(
      "knowledge_save",
      `Replace the full synthesis page, preserving existing claim spans and stable IDs by default. For every deliberately omitted wiki/root claim, supply node.claimRemovals with its exact id and reason; reviewedClaimIds reports review and does not authorize removal. Empty wiki replacements are refused. Create or revise grounded synthesis with nested <claim id="..." refs="..."> spans. Inside those tags, use ordinary Markdown headings such as ## Heading, without an extra opening angle bracket. Every nonblank synthesis text span must be covered by tags; this structural check is separate from entailment. Use refs="" for explicitly unsupported text without inventing evidence; set its claim epistemicStatus to unsupported and preserve modality such as question, proposal or recommendation. Converted owner refs remain context unless explicitly changed: after reviewing evidence, set claims[].relations[ref] to supports only when it establishes the claim; keep merely related evidence as context. The verifier determines verification, not claim tags or asserted status. Never invent verification. For brief nodes, preserve the ## Description and ## Body sections in markdown. New wikis require a reconciled candidate, top-level creationAssessment after library/candidate and relevant page reads, and claim support from at least two distinct current documents. Prefer enriching existing reusable scopes; one-document material belongs in a useful annotation or an unpublished candidate. Root is the compact overview itself and must fit its hard budget. Preserve canonical node.ownerId when revising an owned node. If omitted, an actual knowledge_fetch(editing:true) in this run can supply it only for the exact same id, kind and expectedRevision; explicit null or another owner is never repaired. Never infer or fabricate it. node.inputVersions is optional here: an actual knowledge_fetch(editing:true) lets unchanged claim trees retain their stored dependency versions; new or edited uses need knowledge_reference reads in this run or explicit exact versions. This never marks untouched claims reviewed. In maintenance, existing pages must match an offered frontier. Before revising an existing wiki, read knowledge_fetch({id:targetId,editing:true}) at node.expectedRevision. Neither the embedded frontier node nor an explicit inputFingerprint replaces this target read. After knowledge_next_frontier and then a complete knowledge_fetch(editing:true) for that exact node/revision, omit inputFingerprint to use this run’s bound read receipt. Otherwise include its exact fingerprint at the top level beside node. Explicit wrong or blank fingerprints are never corrected; changed authority requires refreshing the frontier and editing read. An offered review=true person annotation requires annotation_search({personId}) through every nextCursor first. Retention is assessed against the current whole profile; a refused retention must be corrected, consolidated or retracted through canonical person tools before saving. Ordinary proof refresh does not perform this editorial assessment. For an offered canonical owner, operational mutations must succeed BEFORE this terminal save: state, deadline, retirement, and ledger changes. Saving settles offered claim work and can end mutation authority for that owner. After operational changes, use knowledge_next_frontier and knowledge_fetch(editing=true) to refresh the retained owner, input versions, and fingerprint; if retired or removed, follow the refreshed frontier instead. Do not save while a required canonical action is refused or incomplete; reread and reconcile it first. Root budget: ${service.deps.getSettings().knowledge.rootMaxChars} characters including markup.`,
      z
        .object({
          node: proposal.extend({
            inputVersions: versions
              .optional()
              .describe(
                "Optional explicit dependency-version overrides. After knowledge_fetch(editing:true), unchanged tagged claim trees and semantic state can retain that exact snapshot's stored versions. New or edited uses require a successful knowledge_reference read in this run or an explicit exact version. A ref reused by an edited/new claim cannot inherit merely because another claim was unchanged. Explicit stale overrides remain errors. Reading a page does not read its cited sources; no versions are invented or refreshed from current database state.",
              ),
          }),
          candidateId: id
            .optional()
            .describe(
              "Publication candidate ID returned by knowledge_propose_page, separate from node identity and revision. Proposing a candidate does not create a wiki: a new wiki still uses node.expectedRevision: 0.",
            ),
          creationAssessment: z
            .object({
              reason: z.string().trim().min(1).max(1000),
              relatedPageIds: z.array(id).max(16),
            })
            .strict()
            .optional()
            .describe(
              "Required for a NEW wiki only: explain its distinct reusable scope and why enriching considered existing pages is insufficient. Read wiki library and candidates first, and knowledge_fetch each relatedPageIds entry. An empty list is an explicit judgment after retrieval, not proof no related page exists. New wikis need actual claim supports from at least two distinct current source documents; context or declared evidence padding does not count. New and changed wiki prose also undergo the configured synthesis-value check; a source inventory or copied boilerplate is insufficient.",
            ),
          inputFingerprint: z
            .string()
            .optional()
            .describe(
              "Optional after this run actually receives the current frontier offer and then fully reads the same node with editing:true at node.expectedRevision. Otherwise copy the offered inputFingerprint verbatim here. Explicit wrong or blank values are never repaired. Source/privacy/owner changes require a fresh frontier and editing read; final atomic freshness checks always apply.",
            ),
          reviewedClaimIds: z
            .array(id)
            .max(1024)
            .optional()
            .describe(
              "Existing pending claim IDs actually reviewed in this save. Untouched claims omitted here remain pending; changing or removing a claim is recorded automatically. Use the offered pendingClaimIds, or an explicit subset for partial review.",
            ),
          curationDeferral: z
            .object({
              reasonCode: z.literal("insufficient_useful_context"),
              reason: z.string().trim().min(1).max(500),
              factualRepair: z
                .object({ claimIds: z.array(id).min(1).max(8) })
                .strict()
                .optional()
                .describe(
                  "Explicit narrow factual correction/qualification of named existing claims only. Same title/headings/claim identities; no unrelated edits or deletion. Requires an enforced integrity pass and current positive proof; editorial work remains deferred.",
                ),
            })
            .strict()
            .optional()
            .describe(
              "Existing wiki review only: after reviewing every offered claim against current evidence, retain the unchanged title, visible markdown, claim structure and qualifications when no useful synthesis improvement is supported. Defers curation to a bounded routine review without certifying editorial completion. Mutually exclusive with placementAssessment; never permits new pages, changed prose, stale inputs or unreviewed claims. Supporting references may be replaced with a bounded set of current evidence references only with current positive proof for every retained claim; never weaken support relations or qualifiers. Explain the missing useful context in reason; do not retry cosmetic rewrites after a value refusal.",
            ),
          placementAssessment: z
            .discriminatedUnion("status", [
              z
                .object({
                  status: z.literal("integrated"),
                  reason: z.string().trim().min(1).max(500),
                  links: z
                    .array(
                      z
                        .object({
                          fromId: id,
                          toId: id,
                          kind: z.enum(["part_of", "belongs_to_project", "related_to"]),
                          otherRevision: z.number().int().nonnegative(),
                        })
                        .strict(),
                    )
                    .min(1)
                    .max(16),
                })
                .strict(),
              z
                .object({
                  status: z.literal("standalone"),
                  reason: z.string().trim().min(1).max(500),
                })
                .strict(),
              z
                .object({
                  status: z.literal("deferred"),
                  reason: z.string().trim().min(1).max(500),
                })
                .strict(),
            ])
            .optional()
            .describe(
              "Required for terminal review=true wiki saves only. Read the wiki library before integrated or standalone judgment; integrated requires persisted incident links and knowledge_fetch reads of their counterparts. Normal reading is sufficient for placement; editing:true is needed to edit tagged claims. Standalone is an explicit scope judgment, not proof no related page exists. Deferred preserves grounded prose and schedules bounded follow-up. Partial claim repair and other node kinds do not require this field.",
            ),
        })
        .strict(),
      true,
      async (input, signal) => {
        if (
          input.curationDeferral &&
          (!context.batchId ||
            !context.engine ||
            input.node.expectedRevision === 0 ||
            input.placementAssessment)
        )
          throw new KnowledgeStorageError(
            "claim_invalid",
            "Curation deferral requires an existing offered wiki review and no placementAssessment",
          );
        const node = dependencyReceipts.complete(input.node);
        const inputFingerprint =
          context.batchId && context.engine && node.expectedRevision > 0
            ? frontierEditing.resolve(node, input.inputFingerprint)
            : input.inputFingerprint;

        if (input.curationDeferral)
          assertCurationDeferral(service.deps.db, {
            ...node,
            maintenance: {
              batchId: context.batchId!,
              runId: context.runId,
              inputFingerprint: inputFingerprint ?? "",
              curationDeferral: input.curationDeferral,
            },
          });
        if (context.parallel && node.kind === "root")
          throw new KnowledgeStorageError(
            "revision_conflict",
            "Root changes require an exclusive root maintenance run",
          );
        let fence =
          node.kind === "wiki" && reconciliation && node.expectedRevision > 0
            ? reconciliation.nodeFence(node.id, node.expectedRevision)
            : runFence;
        if (node.kind === "root" && context.batchId && context.engine && placementReads && fence)
          fence = placementReads.orientationFence(fence);
        if (
          input.placementAssessment &&
          input.placementAssessment.status !== "deferred" &&
          placementReads &&
          fence
        )
          fence = placementReads.placementFence(fence);
        const candidate = input.candidateId
          ? getKnowledgeCandidate(service.deps.db, input.candidateId)
          : null;
        if (
          node.expectedRevision === 0 &&
          node.kind === "wiki" &&
          (!candidate || candidate.status !== "proposed")
        )
          throw new KnowledgeStorageError(
            "claim_invalid",
            "A new wiki needs a reconciled proposed candidate",
          );
        if (context.batchId && context.engine && node.expectedRevision > 0)
          context.engine.preflightSaveNode(
            context.batchId,
            context.runId,
            node.id,
            inputFingerprint ?? "",
          );
        assertKnowledgeSavePreflight(service.deps.db, node, fence);
        const creationReceipt = candidate
          ? publicationReads.receipt(candidate.id, input.creationAssessment)
          : undefined;
        if (candidate) assertWikiPublicationReceipt(service.deps.db, candidate.id, creationReceipt);
        const wikiRepairAssessment = await wikiValue.assess(
          input.curationDeferral?.factualRepair
            ? {
                ...node,
                maintenance: {
                  batchId: context.batchId!,
                  runId: context.runId,
                  inputFingerprint: inputFingerprint!,
                  curationDeferral: input.curationDeferral,
                },
              }
            : node,
          signal,
        );
        const personReviewFence = await personReview.prepare(
          node,
          runFence,
          inputFingerprint,
          context.checkRecord,
          signal,
        );
        const outcomeFence = await checkKnowledgeOutcome(
          service,
          context.checkRecord,
          node,
          signal,
          runFence,
        );
        const result =
          context.batchId && context.engine && node.expectedRevision > 0
            ? await context.engine.saveNode(
                context.batchId,
                context.runId,
                node.id,
                inputFingerprint ?? "",
                {
                  ...node,
                  personReviewFence,
                  ...(wikiRepairAssessment ? { wikiRepairAssessment } : {}),
                },
                input.reviewedClaimIds,
                fence,
                input.placementAssessment,
                outcomeFence,
                input.curationDeferral,
              )
            : await service.save(
                node,
                candidate
                  ? {
                      candidateId: candidate.id,
                      expectedCandidateRevision: candidate.revision,
                      creationReceipt,
                    }
                  : undefined,
                fence,
                outcomeFence,
              );
        const accepted =
          reconciliation && fence && node.kind === "wiki"
            ? reconciliation.acceptNode(reconciliation.accept(result, fence))
            : placementReads
              ? placementReads.acceptNode(result)
              : result;
        return {
          ...accepted,
          verificationSummary: savedProofFeedback(service.deps.db, accepted.node),
        };
      },
    ),
  ];
  if (context.engine && context.batchId) {
    const engine = context.engine;
    const batchId = context.batchId;
    const temporalContext = async (documentId: string, present = true) => {
      service.reference(`source:${documentId}`);
      const entries = listTemporalAnnotationsAwaitingRefile(
        service.deps.db,
        documentId,
        11,
        context.runId,
      );
      const invalidated = entries.slice(0, 10);
      if (present && invalidated.length && context.markTemporalPresented)
        await context.markTemporalPresented(
          invalidated.map((entry) => entry.id),
          context.runId,
        );
      return {
        invalidated,
        hasMoreInvalidated: entries.length > 10,
        ungrounded: listUngroundedTemporalAnnotationsForDoc(service.deps.db, documentId, 10),
      };
    };
    tools.push(
      tool(
        "knowledge_maintenance_inputs",
        "Read a bounded page of input versions for an offered maintenance item, including newly discovered evidence that may not yet appear in its claims. Call with the offered id when inputVersionsOmitted=true; follow nextAfter until absent. Read each input page once per offered inputFingerprint; on a conflict or changed fingerprint refresh the frontier and restart pagination. Inspect newly selected evidence even if uncited. Do not repeatedly page or transcribe unchanged dependency hashes: knowledge_save can preserve versions from an actual editing read. Fetch supporting content for new or revised assertions. These inputs are context to inspect, not automatically supporting evidence.",
        z
          .object({
            id,
            after: z.string().max(1024).optional(),
            limit: z.number().int().min(1).max(32).optional(),
          })
          .strict(),
        false,
        (input) =>
          engine.maintenanceInputs(batchId, context.runId, input.id, input.after, input.limit),
      ),
      tool(
        "knowledge_temporal_context",
        "Read the next page of time-index entries invalidated by this source change. Account for each: re-file only facts still supported by current evidence, or explain why they no longer hold. Repeat while hasMoreInvalidated=true. Ungrounded live entries require evidence review too.",
        z.object({ documentId: id }).strict(),
        true,
        (input) => temporalContext(input.documentId),
      ),
    );
    tools.push(
      tool(
        "knowledge_next_frontier",
        "Call with {} only: this tool is already bound to the current run and batch. Read the next bounded maintenance frontier. Copy offered IDs and fingerprints verbatim into save/completion calls; request a fresh frontier after revision conflicts. Follow fetchRequired to retrieve complete nodes or sources; inputVersionsOmitted requires paging knowledge_maintenance_inputs for the offered id, then fetching the actual references. If source.contentTruncated is true, fetch the complete source before synthesizing claims. If temporal.contextOmitted is true, call knowledge_temporal_context before completing the source. Continue until done=true, even when items is empty.",
        z.object({}).strict(),
        true,
        async () => {
          const frontier = await engine.next(batchId, context.runId);
          const items: Array<
            KnowledgeFrontierView["items"][number] & {
              temporal?: Awaited<ReturnType<typeof temporalContext>> & { contextOmitted?: boolean };
            }
          > = [];
          const limit = service.deps.getSettings().knowledge.maxFrontierChars;
          const responseSize = (nextItems: unknown[]) =>
            JSON.stringify({
              kind: "structured",
              resultType: "knowledge_next_frontier",
              data: { ...frontier, items: nextItems },
            }).length;
          const fits = (item: unknown) => responseSize([...items, item]) <= limit;
          for (const item of frontier.items) {
            if (!item.source) {
              const fitted = fitKnowledgeFrontierItem(
                item,
                limit - responseSize(items) - 1,
                items.length === 0,
              );
              if (!fitted) break;
              items.push(fitted);
              continue;
            }
            const temporal = await temporalContext(item.source.id, false);
            const decorated = { ...item, temporal };
            if (fits(decorated)) {
              if (temporal.invalidated.length && context.markTemporalPresented)
                await context.markTemporalPresented(
                  temporal.invalidated.map((entry) => entry.id),
                  context.runId,
                );
              items.push(decorated);
              continue;
            }
            const omitted = {
              invalidated: [],
              hasMoreInvalidated: temporal.invalidated.length > 0 || temporal.hasMoreInvalidated,
              ungrounded: [],
              contextOmitted: true,
            };
            let compact = { ...item, temporal: omitted };
            if (!fits(compact)) {
              if (items.length) break;
              const descriptor = fitKnowledgeFrontierItem(
                item,
                limit - responseSize([]) - JSON.stringify(omitted).length - 20,
                true,
              );
              if (!descriptor)
                throw new Error("Knowledge frontier descriptor exceeds context budget");
              compact = { ...descriptor, temporal: omitted };
            }
            if (!fits(compact))
              throw new Error("Knowledge frontier descriptor exceeds context budget");
            items.push(compact);
          }
          frontierEditing.offered(items);
          return {
            ...frontier,
            items,
          };
        },
      ),
    );
    tools.push(
      tool(
        "knowledge_organization_complete",
        "Record the joint organization outcome only after all offered sources and synthesis repairs are settled. Copy organization.id and inputFingerprint from knowledge_next_frontier. organized requires the actual wiki target IDs and targetVersions you read, created or updated, with a supports path to this evidence; Use an outcome-compatible reasonCode: organized uses new_context_published, existing_context_updated or already_organized; no_page uses insufficient_shared_context or insufficient_evidence; deferred uses awaiting_more_evidence or insufficient_evidence. Explain richer reasoning in the normal run transcript, not this durable ledger. This does not create dependencies or certify claims. Then call knowledge_next_frontier until done=true.",
        z
          .object({
            id,
            inputFingerprint: z.string().min(1),
            outcome: z.enum(["organized", "no_page", "deferred"]),
            reasonCode: z.enum(ORGANIZATION_REASON_CODES),
            targetIds: z.array(id).max(32).optional(),
            targetVersions: z.record(z.string(), z.number().int().positive()).optional(),
          })
          .strict(),
        true,
        (input) =>
          service.deps.writeGate["knowledge.completeOrganization"](
            {
              ...input,
              batchId,
              runId: context.runId,
              retrievalBoundary: context.incompleteRetrievalBoundary?.(),
              retryAt:
                service.deps.clock() +
                (input.outcome === "deferred"
                  ? Math.max(60000, service.deps.getSettings().knowledge.routineDelayMs)
                  : Math.max(60000, service.deps.getSettings().knowledge.maxReviewIntervalMs)),
            },
            service.deps.clock(),
          ),
      ),
    );
    tools.push(
      tool(
        "knowledge_discovery_complete",
        "Source frontier items only: sourceRead reports this run’s current-generation read progress. complete needs no reread; partial.nextOffset identifies the first unread UTF-16 offset for fetch_many; required needs a full read; unavailable requires refreshing the frontier. Deferred batch references are unread. Finish the presented source chunk before requesting more work. Read the complete source before recording considered coverage in any phase. Untruncated source offers count; truncated offers require a successful full fetch_many or whole-source knowledge_reference at the same generation. A source_read_required refusal names the needed read; perform it and retry, rather than dropping the source. After interpreting an offered source, reconcile existing loops, annotations and pages; optionally propose a reusable page. A synthesis node is settled by knowledge_save, then knowledge_next_frontier; never complete a node or pair its fingerprint with a cited source ID. Copy the offered id including source: and the entire inputFingerprint verbatim. Include canonical owners needing grounded prose as targets; fresh owners are materialized before repair. Resolve unavailable target errors rather than dropping intended repairs. On revision conflict, fetch the frontier again. Known dependents are then inspected by the engine.",
        z
          .object({
            id,
            inputFingerprint: z.string().min(1),
            targets: z.array(id).max(32).optional(),
            phases: z
              .array(z.enum(["interpretation", "organization", "conversion"]))
              .optional()
              .describe(
                "Phases actually reviewed in this call. Defaults to interpretation and organization; an explicit subset is valid only when the other required phases already have current coverage. Use [] only when the offered completionRequirements.requiredPhases is empty; the server rechecks current coverage before settlement. Review completionRequirements.requiredPhases before completing. Conversion is optional. Never attest an unreviewed phase.",
              ),
          })
          .strict(),
        true,
        (input) => {
          if (
            context.markTemporalPresented &&
            listTemporalAnnotationsAwaitingRefile(
              service.deps.db,
              input.id.startsWith("source:") ? input.id.slice(7) : input.id,
              1,
              context.runId,
            ).length
          )
            throw new KnowledgeStorageError(
              "claim_invalid",
              "Read and account for remaining temporal casualties with knowledge_temporal_context before completing this source",
            );
          return engine.completeSource(
            batchId,
            context.runId,
            input.id,
            input.inputFingerprint,
            false,
            input.phases,
            input.targets,
            context.incompleteRetrievalBoundary?.(),
          );
        },
      ),
    );
  }
  if (context.scopedOwnersOnly) {
    const owners = [
      ["loop_synthesis_save", "loop"],
      ["brief_synthesis_save", "brief"],
      ["doc_annotation_synthesis_save", "doc_annotation"],
      ["person_annotation_synthesis_save", "person_annotation"],
    ] as const;
    return guarded([
      ...tools.filter((entry) => !entry.mutates),
      ...owners.map(([name, kind]) =>
        tool(
          name,
          `Revise tagged claims on an existing canonical ${kind}. The ID must name the existing owner; read its current synthesis revision with knowledge_fetch and current evidence versions with knowledge_reference. This changes prose only, preserving operational fields. Briefs must preserve ## Description and ## Body sections. It cannot create wiki pages or change another artifact kind.`,
          proposal.omit({ kind: true, ownerId: true }),
          true,
          async (input, signal) => {
            const node = { ...input, kind, ownerId: input.id };
            assertKnowledgeSavePreflight(service.deps.db, node, runFence);
            const outcomeFence = await checkKnowledgeOutcome(
              service,
              context.checkRecord,
              node,
              signal,
              runFence,
            );
            return service.save(node, undefined, runFence, outcomeFence);
          },
        ),
      ),
    ]);
  }
  return guarded(tools);
}

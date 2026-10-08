// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  listTemporalAnnotationsAwaitingRefile,
  listUngroundedTemporalAnnotationsForDoc,
} from "../../enrichment/temporal-annotations/storage.js";
import { KnowledgeDependencyReceipts } from "./dependency-receipts.js";
import { WikiToolReconciliation } from "./wiki-tool-reconciliation.js";
import { assertKnowledgeRunFence } from "./run-fence.js";
import { fitKnowledgeFrontierItem } from "./engine-frontier.js";
import { ORGANIZATION_REASON_CODES } from "./organization-cohorts.js";
import { WikiPublicationReads } from "./wiki-publication.js";
import { getKnowledgeCandidate, listKnowledgeCandidates } from "./discovery.js";
import { KnowledgeStorageError } from "./types.js";
import { listKnowledgeLinks } from "./links.js";
import { ClaimMarkupError } from "./claims.js";
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
    expectedRevision: z.number().int().nonnegative(),
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
  run: (input: z.output<S>) => unknown | Promise<unknown>,
): ToolHandle {
  return {
    name,
    description,
    schema,
    mutates,
    async invoke(args): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success)
        return { kind: "error", code: "invalid_arguments", message: parsed.error.message };
      try {
        return { kind: "structured", resultType: name, data: await run(parsed.data) };
      } catch (error) {
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
    /** Narrow workflows receive only artifact-scoped owner mutation variants. */
    scopedOwnersOnly?: boolean;
    /** Capture collection read receipts for independently executing maintenance. */
    parallel?: boolean;
    engine?: KnowledgeEngine;
    batchId?: string;
    markTemporalPresented?: (ids: readonly string[], runId: string) => Promise<void>;
  },
): ToolHandle[] {
  const dependencyReceipts = new KnowledgeDependencyReceipts();
  const publicationReads = new WikiPublicationReads(service.deps.db);
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
      "Read a synthesis node. Set editing=true only to repair its tagged claims; normal reading strips tags.",
      z.object({ id, editing: z.boolean().default(false) }).strict(),
      false,
      (input) => {
        const read = () => {
          if (!input.editing) return service.fetch(input.id, false);
          const snapshot = service.editingSnapshot(input.id);
          if (snapshot) dependencyReceipts.rememberEditing(snapshot);
          return snapshot?.node ?? null;
        };
        const result = placementReads ? placementReads.readNode(read) : read();
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
      "Resolve an exact claim or evidence reference and read its current version. For a fetched document use source:<documentId>, not doc: or document:. Optional selectors: source:<documentId>#evidence:<evidenceId>, wiki:<pageId>#claim:<claimId> (also loop, annotation or brief claims), or loop:<loopId>#field:<fieldName>. Use exact tool-returned IDs. knowledge_save retains this exact read revision for the current run, so you can omit its inputVersions entry. Explicit version overrides remain supported and are never silently refreshed. Scoped owner synthesis tools still require explicit versions.",
      z.object({ ref: z.string().min(1).max(1024) }).strict(),
      false,
      (input) => {
        const result = service.deps.db.transaction(() => service.reference(input.ref))();
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
      "Register an exact source quote against the content hash actually read. Returns a stable addressable evidence reference. This reference supplies only the quoted text: surrounding author, date and other document context are not implicitly included. If a claim needs that context, quote a sufficient contextual span or cite the already-read whole source as support as well. Headings inside claim tags must also be supported.",
      z
        .object({
          documentId: id,
          contentHash: z.string().min(1),
          quote: z.string().min(1).max(32000),
          start: z.number().int().nonnegative().optional(),
        })
        .strict(),
      true,
      (input) => service.evidence(input, runFence),
    ),
    tool(
      "knowledge_propose_page",
      "After inspecting existing pages with knowledge_list and candidates with knowledge_candidates, propose a reusable page with a stable identity key, distinct scope and evidence versions. Prefer extending existing context; a document alone does not require its own wiki.",
      z
        .object({
          identityKey: z.string().min(1).max(500),
          title: z.string().min(1).max(1000),
          scope: z.string().min(1).max(8000),
          evidenceVersions: z.record(z.string(), z.string()),
        })
        .strict(),
      true,
      async (input) => {
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
      `Replace the full synthesis page, preserving existing claim spans and stable IDs by default. For every deliberately omitted wiki/root claim, supply node.claimRemovals with its exact id and reason; reviewedClaimIds reports review and does not authorize removal. Empty wiki replacements are refused. Create or revise grounded synthesis with nested <claim id="..." refs="..."> spans. Every nonblank synthesis text span must be covered by tags; this structural check is separate from entailment. Use refs="" for explicitly unsupported text without inventing evidence; set its claim epistemicStatus to unsupported and preserve modality such as question, proposal or recommendation. Converted owner refs remain context unless explicitly changed: after reviewing evidence, set claims[].relations[ref] to supports only when it establishes the claim; keep merely related evidence as context. The verifier determines verification, not claim tags or asserted status. Never invent verification. For brief nodes, preserve the ## Description and ## Body sections in markdown. New wikis require a reconciled candidate, top-level creationAssessment after library/candidate and relevant page reads, and claim support from at least two distinct current documents. Prefer enriching existing reusable scopes; one-document material belongs in a useful annotation or an unpublished candidate. Root is the compact overview itself and must fit its hard budget. Preserve the supplied canonical node.ownerId when revising an owned node; never infer or fabricate it. node.inputVersions is optional here: an actual knowledge_fetch(editing:true) lets unchanged claim trees retain their stored dependency versions; new or edited uses need knowledge_reference reads in this run or explicit exact versions. This never marks untouched claims reviewed. In maintenance, existing pages must match an offered frontier and include its exact inputFingerprint at the top level beside node. For an offered canonical owner, operational mutations must succeed BEFORE this terminal save: state, deadline, retirement, and ledger changes. Saving settles offered claim work and can end mutation authority for that owner. After operational changes, use knowledge_next_frontier and knowledge_fetch(editing=true) to refresh the retained owner, input versions, and fingerprint; if retired or removed, follow the refreshed frontier instead. Do not save while a required canonical action is refused or incomplete; reread and reconcile it first. Root budget: ${service.deps.getSettings().knowledge.rootMaxChars} characters including markup.`,
      z
        .object({
          node: proposal.extend({
            inputVersions: versions
              .optional()
              .describe(
                "Optional explicit dependency-version overrides. After knowledge_fetch(editing:true), unchanged tagged claim trees and semantic state can retain that exact snapshot's stored versions. New or edited uses require a successful knowledge_reference read in this run or an explicit exact version. A ref reused by an edited/new claim cannot inherit merely because another claim was unchanged. Explicit stale overrides remain errors. Reading a page does not read its cited sources; no versions are invented or refreshed from current database state.",
              ),
          }),
          candidateId: id.optional(),
          creationAssessment: z
            .object({
              reason: z.string().trim().min(1).max(1000),
              relatedPageIds: z.array(id).max(16),
            })
            .strict()
            .optional()
            .describe(
              "Required for a NEW wiki only: explain its distinct reusable scope and why enriching considered existing pages is insufficient. Read wiki library and candidates first, and knowledge_fetch each relatedPageIds entry. An empty list is an explicit judgment after retrieval, not proof no related page exists. New wikis need actual claim supports from at least two distinct current source documents; context or declared evidence padding does not count.",
            ),
          inputFingerprint: z
            .string()
            .optional()
            .describe(
              "Required when revising an existing node in maintenance: copy the offered inputFingerprint verbatim at the top level beside node, not inside node. Optional for new nodes and saves outside maintenance.",
            ),
          reviewedClaimIds: z
            .array(id)
            .max(1024)
            .optional()
            .describe(
              "Existing pending claim IDs actually reviewed in this save. Untouched claims omitted here remain pending; changing or removing a claim is recorded automatically. Use the offered pendingClaimIds, or an explicit subset for partial review.",
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
      async (input) => {
        const node = dependencyReceipts.complete(input.node);
        if (context.parallel && node.kind === "root")
          throw new KnowledgeStorageError(
            "revision_conflict",
            "Root changes require an exclusive root maintenance run",
          );
        let fence =
          node.kind === "wiki" && reconciliation && node.expectedRevision > 0
            ? reconciliation.nodeFence(node.id, node.expectedRevision)
            : runFence;
        if (
          input.placementAssessment &&
          input.placementAssessment.status !== "deferred" &&
          placementReads &&
          fence
        )
          fence = placementReads.placementFence(fence);
        if (
          context.batchId &&
          context.engine &&
          node.expectedRevision > 0 &&
          !input.inputFingerprint?.trim()
        )
          throw new KnowledgeStorageError(
            "claim_invalid",
            "Maintenance saves of existing nodes require inputFingerprint at the top level beside node. Copy the offered frontier inputFingerprint verbatim; call knowledge_next_frontier if it is unavailable.",
          );
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
        const result =
          context.batchId && context.engine && node.expectedRevision > 0
            ? await context.engine.saveNode(
                context.batchId,
                context.runId,
                node.id,
                input.inputFingerprint ?? "",
                node,
                input.reviewedClaimIds,
                fence,
                input.placementAssessment,
              )
            : await service.save(
                node,
                candidate
                  ? {
                      candidateId: candidate.id,
                      expectedCandidateRevision: candidate.revision,
                      creationReceipt: publicationReads.receipt(
                        candidate.id,
                        input.creationAssessment,
                      ),
                    }
                  : undefined,
                fence,
              );
        return reconciliation && fence && node.kind === "wiki"
          ? reconciliation.acceptNode(reconciliation.accept(result, fence))
          : placementReads
            ? placementReads.acceptNode(result)
            : result;
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
        "Source frontier items only: read the complete source before recording considered coverage in any phase. Untruncated source offers count; truncated offers require a successful full fetch_many or whole-source knowledge_reference at the same generation. A source_read_required refusal names the needed read; perform it and retry, rather than dropping the source. After interpreting an offered source, reconcile existing loops, annotations and pages; optionally propose a reusable page. A synthesis node is settled by knowledge_save, then knowledge_next_frontier; never complete a node or pair its fingerprint with a cited source ID. Copy the offered id including source: and the entire inputFingerprint verbatim. Include canonical owners needing grounded prose as targets; fresh owners are materialized before repair. Resolve unavailable target errors rather than dropping intended repairs. On revision conflict, fetch the frontier again. Known dependents are then inspected by the engine.",
        z
          .object({
            id,
            inputFingerprint: z.string().min(1),
            targets: z.array(id).max(32).optional(),
            phases: z
              .array(z.enum(["interpretation", "organization", "conversion"]))
              .min(1)
              .optional(),
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
          (input) => service.save({ ...input, kind, ownerId: input.id }, undefined, runFence),
        ),
      ),
    ]);
  }
  return guarded(tools);
}

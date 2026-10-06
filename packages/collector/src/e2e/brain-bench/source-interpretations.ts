// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { coverLegacyProse } from "./legacy-prose.js";
import {
  knowledgePuppet,
  type KnowledgePuppetPolicy,
  type PuppetKnowledgeItem,
} from "./knowledge-puppet.js";
import { call, structuredData, type PuppetPlan, type RunContext } from "./puppet-plan.js";

const temporalPage = z.object({ hasMoreInvalidated: z.boolean() }).passthrough();
const legacyClaim = z.object({
  id: z.string().regex(/^legacy(?:-context-\d+)?$/),
  refs: z.array(z.string()),
  supportLogic: z.enum(["all", "any"]),
  validFrom: z.number().nullable(),
  validUntil: z.number().nullable(),
  attribution: z.string().nullable().optional(),
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
});
const reviewMetadata = z.object({
  importance: z.number().optional(),
  volatility: z.number().optional(),
  uncertainty: z.number().optional(),
  activity: z.enum(["active", "quiet", "historical"]).optional(),
  nextReviewAt: z.number().nullable().optional(),
  checkpointAt: z.number().nullable().optional(),
});

/** Preserve current legacy owner context or an empty overview; stale prose needs a scenario-specific repair. */
export const preserveCurrentOwner: KnowledgePuppetPolicy["plan"] = (item) => {
  const node = item.node;
  if (
    !node ||
    (!node.ownerId && !(node.kind === "root" && node.markdown === "")) ||
    node.validity !== "current"
  )
    return { calls: [] };
  const claims = z.array(legacyClaim).safeParse(node.claims);
  if (!claims.success) return { calls: [] };
  const covered = coverLegacyProse(node.markdown);
  return {
    calls: [
      call("knowledge_save", {
        node: {
          id: node.id,
          kind: node.kind,
          ...(node.ownerId ? { ownerId: node.ownerId } : {}),
          title: node.title,
          markdown: covered.markdown,
          expectedRevision: node.revision,
          inputVersions: item.inputVersions,
          claims: [
            ...claims.data.map(({ refs, ...state }) => ({
              ...state,
              relations: Object.fromEntries(refs.map((ref) => [ref, "context"])),
            })),
            ...covered.addedClaims,
          ],
          metadata: reviewMetadata.parse(node.metadata),
        },
        inputFingerprint: item.inputFingerprint,
      }),
    ],
  };
};

/** Re-read a stale owner snapshot; pending canonical reconciliation may have finished since it was offered. */
export const refreshCurrentOwner: KnowledgePuppetPolicy["plan"] = (item, ctx, steps) => {
  if (!item.node?.ownerId || item.node.validity !== "stale")
    return preserveCurrentOwner(item, ctx, steps);
  const frontierAt = steps.map((step) => step.name).lastIndexOf("knowledge_next_frontier");
  const fetched = steps
    .slice(frontierAt + 1)
    .filter(
      (step) =>
        step.name === "knowledge_fetch" && step.args?.id === item.id && step.args?.editing === true,
    )
    .at(-1);
  if (!fetched) return { calls: [call("knowledge_fetch", { id: item.id, editing: true })] };
  const node = z
    .object({
      id: z.literal(item.id),
      kind: z.string(),
      ownerId: z.string(),
      title: z.string(),
      markdown: z.string(),
      revision: z.number(),
      validity: z.literal("current"),
      claims: z.array(z.unknown()),
      metadata: z.record(z.string(), z.unknown()),
    })
    .passthrough()
    .safeParse(structuredData(fetched.result));
  if (!node.success) return { calls: [] };
  const preserved = preserveCurrentOwner({ ...item, node: node.data }, ctx, steps);
  return {
    ...preserved,
    calls: [call("knowledge_fetch", { id: item.id, editing: true }), ...preserved.calls],
  };
};

/** Decisions keyed on the actual evidence offered by the maintenance engine. */
export interface SourceInterpretation {
  documentId?: string;
  docTitle?: string;
  contentContains?: string;
  expectedRefusals?: readonly { tool: string; code: string }[];
  plan: PuppetPlan | ((ctx: RunContext, item: PuppetKnowledgeItem) => PuppetPlan);
}

/**
 * Reuse source-specific scripted decisions without pretending a batched synthesis
 * run is a retired datum run. Source revisions may repeat, so creation/update
 * decisions must inspect evidence or fetch existing owners in their real tools.
 * Node maintenance is a separate explicit policy: an empty source decision is
 * settled normally; an offered node cannot be settled without knowledge_save.
 */
export function sourceInterpretations(options: {
  sources: readonly SourceInterpretation[];
  maintainNode?: KnowledgePuppetPolicy["plan"];
  targets?: KnowledgePuppetPolicy["targets"];
}) {
  const decisionFor = (item: PuppetKnowledgeItem) =>
    options.sources.find(
      (candidate) =>
        item.source &&
        (candidate.documentId === undefined || candidate.documentId === item.source.id) &&
        (candidate.docTitle === undefined || candidate.docTitle === item.source.title) &&
        (candidate.contentContains === undefined ||
          item.source.content.includes(candidate.contentContains)),
    );
  return knowledgePuppet({
    expectedRefusals: (item) => decisionFor(item)?.expectedRefusals ?? [],
    plan: (item, ctx, steps) => {
      if (!item.source) return options.maintainNode?.(item, ctx, steps) ?? { calls: [] };
      const decision = decisionFor(item);
      if (!decision) return { calls: [] };
      const sourceContext = { ...ctx, subject: item.source.id };
      const plan =
        typeof decision.plan === "function" ? decision.plan(sourceContext, item) : decision.plan;
      const frontierAt = steps.map((step) => step.name).lastIndexOf("knowledge_next_frontier");
      const pages = steps
        .slice(frontierAt + 1)
        .filter(
          (step) =>
            step.name === "knowledge_temporal_context" && step.args?.documentId === item.source!.id,
        );
      const lastPage = pages.at(-1);
      const temporal = lastPage ? structuredData(lastPage.result) : item.temporal;
      const parsedTemporal = temporalPage.safeParse(temporal);
      const needsPage =
        parsedTemporal.success &&
        (parsedTemporal.data.hasMoreInvalidated || parsedTemporal.data.contextOmitted === true);
      return {
        ...plan,
        calls: [
          call("fetch_many", { documents: [{ documentId: item.source.id }] }),
          ...plan.calls,
          ...Array.from({ length: pages.length + (needsPage ? 1 : 0) }, () =>
            call("knowledge_temporal_context", { documentId: item.source!.id }),
          ),
        ],
      };
    },
    targets: options.targets,
  });
}

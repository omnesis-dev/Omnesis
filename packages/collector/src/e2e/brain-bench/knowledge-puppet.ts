// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** A deterministic model policy for the real maintenance-tool protocol. No gateway state is mocked. */
import { z } from "zod";
import {
  emitNextPlanned,
  structuredData,
  type NextTurn,
  type PuppetPlan,
  type RunContext,
  type ToolStep,
} from "./puppet-plan.js";

const itemSchema = z
  .object({
    id: z.string(),
    inputFingerprint: z.string(),
    inputVersions: z.record(z.string(), z.union([z.string(), z.number()])),
    pendingClaimIds: z.array(z.string()).optional(),
    depth: z.number(),
    fetchRequired: z.object({ id: z.string(), kind: z.string() }).passthrough().optional(),
    source: z
      .object({ id: z.string(), title: z.string(), content: z.string(), contentHash: z.string() })
      .optional(),
    node: z
      .object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        markdown: z.string(),
        revision: z.number(),
        ownerId: z.string().nullable(),
        claims: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const organizationSchema = z.object({
  id: z.string(),
  inputFingerprint: z.string(),
  sourceIds: z.array(z.string()),
  readyToComplete: z.boolean(),
});
const frontierSchema = z
  .object({
    batchId: z.string(),
    done: z.boolean(),
    items: z.array(itemSchema),
    organization: organizationSchema.optional(),
  })
  .passthrough();
export type PuppetKnowledgeItem = z.infer<typeof itemSchema>;
export interface KnowledgePuppetPolicy {
  organize?: (
    cohort: z.infer<typeof organizationSchema>,
    ctx: RunContext,
    steps: readonly ToolStep[],
  ) => PuppetPlan;
  organizationOutcome?: (
    cohort: z.infer<typeof organizationSchema>,
    steps: readonly ToolStep[],
  ) => {
    outcome: "organized" | "no_page" | "deferred";
    reasonCode:
      | "insufficient_shared_context"
      | "already_organized"
      | "insufficient_evidence"
      | "awaiting_more_evidence"
      | "new_context_published"
      | "existing_context_updated";
    targetIds?: string[];
    targetVersions?: Record<string, number>;
  };
  /** Script decisions from the actual source/node payload offered by the engine. */
  plan: (item: PuppetKnowledgeItem, ctx: RunContext, steps: readonly ToolStep[]) => PuppetPlan;
  /** Explicit negative-path scenarios may continue after an exact canonical-tool refusal. */
  expectedRefusals?: (item: PuppetKnowledgeItem) => readonly { tool: string; code: string }[];
  /** A source may discover existing nodes that had no dependency edge when it arrived. */
  targets?: (item: PuppetKnowledgeItem, steps: readonly ToolStep[]) => string[];
}

export function knowledgePuppet(
  policy: KnowledgePuppetPolicy,
): (ctx: RunContext, steps: readonly ToolStep[]) => NextTurn | null {
  return (ctx, steps) => {
    if (ctx.flavour !== "synthesis.knowledge") return null;
    let frontierAt = -1;
    for (let i = steps.length - 1; i >= 0; i--)
      if (steps[i]!.name === "knowledge_next_frontier") {
        frontierAt = i;
        break;
      }
    if (frontierAt < 0) return { kind: "tool", name: "knowledge_next_frontier", args: {} };
    const parsed = frontierSchema.safeParse(structuredData(steps[frontierAt]!.result));
    if (!parsed.success)
      return {
        kind: "final",
        text: "Maintenance frontier failed validation; preserve the batch for retry.",
      };
    const frontier = parsed.data;
    if (frontier.done) return { kind: "final", text: "The engine reports this batch complete." };
    if (frontier.organization?.readyToComplete) {
      const since = steps.slice(frontierAt + 1);
      if (since.some((step) => step.name === "knowledge_organization_complete"))
        return { kind: "tool", name: "knowledge_next_frontier", args: {} };
      const plan = policy.organize?.(frontier.organization, ctx, since) ?? { calls: [] };
      const next = emitNextPlanned(plan, since, false);
      if (next.kind === "tool") return next;
      return {
        kind: "tool",
        name: "knowledge_organization_complete",
        args: {
          id: frontier.organization.id,
          inputFingerprint: frontier.organization.inputFingerprint,
          ...(policy.organizationOutcome?.(frontier.organization, since) ?? {
            outcome: "no_page",
            reasonCode: "insufficient_shared_context",
          }),
        },
      };
    }
    let after = frontierAt + 1;
    for (const offeredItem of frontier.items) {
      let item = offeredItem;
      const since = steps.slice(after);
      const settledAt = since.findIndex((step) => {
        if (item.source)
          return (
            step.name === "knowledge_discovery_complete" &&
            step.args?.id === item.id &&
            step.args?.inputFingerprint === item.inputFingerprint
          );
        const node = step.args?.node;
        return (
          step.name === "knowledge_save" &&
          node !== null &&
          typeof node === "object" &&
          (node as { id?: unknown }).id === item.id &&
          step.args?.inputFingerprint === item.inputFingerprint
        );
      });
      if (
        (settledAt >= 0 ? since.slice(0, settledAt + 1) : since).some(
          (step) =>
            step.result === null ||
            (typeof step.result === "object" &&
              (step.result as { kind?: unknown }).kind === "error" &&
              (step.name === "knowledge_save" ||
                step.name === "knowledge_discovery_complete" ||
                !policy
                  .expectedRefusals?.(item)
                  .some(
                    (expected) =>
                      expected.tool === step.name &&
                      expected.code === (step.result as { code?: unknown }).code,
                  ))),
        )
      )
        return {
          kind: "final",
          text: "A maintenance tool was refused or its result is missing; preserve pending work for retry.",
        };
      if (settledAt >= 0) {
        after += settledAt + 1;
        continue;
      }
      if (item.fetchRequired?.kind === "source" && item.source) {
        const ref = `source:${item.source.id}`;
        const fetched = [...since]
          .reverse()
          .find((step) => step.name === "knowledge_reference" && step.args?.ref === ref);
        if (!fetched) return { kind: "tool", name: "knowledge_reference", args: { ref } };
        const view = z
          .object({ text: z.string(), revision: z.union([z.string(), z.number()]) })
          .safeParse(structuredData(fetched.result));
        if (!view.success || view.data.revision !== item.source.contentHash)
          return {
            kind: "final",
            text: "Source changed during required fetch; preserve pending work.",
          };
        item = { ...item, source: { ...item.source, content: view.data.text } };
      }
      if (item.fetchRequired && item.fetchRequired.kind !== "source") {
        const fetched = [...since]
          .reverse()
          .find(
            (step) =>
              step.name === "knowledge_fetch" &&
              step.args?.id === item.id &&
              step.args?.editing === true,
          );
        if (!fetched)
          return { kind: "tool", name: "knowledge_fetch", args: { id: item.id, editing: true } };
        const node = itemSchema.shape.node.safeParse(structuredData(fetched.result));
        if (!node.success || !node.data)
          return { kind: "final", text: "Required synthesis fetch failed; preserve pending work." };
        item = { ...item, node: node.data };
      }
      if (item.fetchRequired?.kind === "root" && !item.orientation) {
        const listed = [...since].reverse().find((step) => step.name === "knowledge_list");
        if (!listed)
          return { kind: "tool", name: "knowledge_list", args: { kind: "wiki", limit: 30 } };
        const orientation = z.array(z.unknown()).safeParse(structuredData(listed.result));
        if (!orientation.success)
          return { kind: "final", text: "Root orientation unavailable; preserve pending work." };
        item = { ...item, orientation: orientation.data };
      }
      // Cohort sources were already interpreted; joint organization has its own fixture policy.
      const plan =
        frontier.organization && item.source ? { calls: [] } : policy.plan(item, ctx, steps);
      const planSteps = item.fetchRequired
        ? since.filter(
            (step) =>
              !(
                step.name === "knowledge_fetch" &&
                step.args?.id === item.id &&
                step.args?.editing === true
              ),
          )
        : since;
      const next = emitNextPlanned(plan, planSteps, false);
      if (next.kind === "tool") {
        if (
          next.name === "knowledge_save" &&
          item.node &&
          next.args.reviewedClaimIds === undefined &&
          typeof next.args.node === "object" &&
          next.args.node !== null &&
          (next.args.node as { id?: unknown }).id === item.id
        ) {
          // These policies synthesize the entire offered page. A partial-review
          // scenario names its exact subset explicitly, including an empty set.
          return { ...next, args: { ...next.args, reviewedClaimIds: item.pendingClaimIds ?? [] } };
        }
        return next;
      }
      if (item.source)
        return {
          kind: "tool",
          name: "knowledge_discovery_complete",
          args: {
            id: item.id,
            inputFingerprint: item.inputFingerprint,
            targets: frontier.organization ? [] : (policy.targets?.(item, since) ?? []),
          },
        };
      return {
        kind: "final",
        text: `Scripted synthesis plan did not save offered node ${item.id}; preserve unfinished maintenance.`,
      };
    }
    return { kind: "tool", name: "knowledge_next_frontier", args: {} };
  };
}

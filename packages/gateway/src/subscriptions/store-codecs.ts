// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { assertNever, NOTIFY_IOS_BODY_MAX, NOTIFY_IOS_TITLE_MAX } from "@omnesis/core";
import { WATCH_TARGET_LIVENESS } from "@omnesis/types";
import {
  isWatchV2Plan,
  watchV2PlanSchema,
  WATCH_V2_PLAN_KIND,
  type WatchV2Plan,
} from "./watch-v2-plan.js";
import type { SubscriptionReaction, SubscriptionWatchGrounding } from "@omnesis/types";

/**
 * Stored subscription JSON is an untrusted persistence boundary. These
 * codecs fail closed if a row is corrupt or was produced by incompatible
 * code; callers must never execute a plan or deliver reaction text obtained
 * from an unchecked type assertion.
 */
export class SubscriptionStorageCorruptionError extends Error {
  override readonly name = "SubscriptionStorageCorruptionError";

  constructor(readonly field: string) {
    super(`stored subscription ${field} is invalid`);
  }
}

export const subscriptionConditionCodec = z
  .object({
    kind: z.literal("natural-language"),
    description: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const subscriptionReactionCodec = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agent-workflow"),
      instruction: z
        .string()
        .min(1)
        .max(8_000)
        .refine((value) => value.trim().length > 0),
      bindings: z
        .record(z.string().min(1).max(64), z.string().min(1).max(512))
        .refine((value) => Object.keys(value).length <= 32)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ios-push"),
      title: z.string().max(NOTIFY_IOS_TITLE_MAX).optional(),
      body: z.string().max(NOTIFY_IOS_BODY_MAX).optional(),
    })
    .strict(),
]) satisfies z.ZodType<SubscriptionReaction>;

/**
 * The workflow purpose a reaction implies. An agent-workflow wake IS the
 * workflow, so its instruction is the purpose. An ios-push reaction runs no
 * workflow — its row exists to satisfy the schema every subscription
 * capability hangs off — so it carries one fixed, honest sentence.
 */
export const OPERATOR_WATCH_WORKFLOW_PURPOSE = "Push a notification to the operator's devices.";

export function subscriptionReactionWorkflowPurpose(reaction: SubscriptionReaction): string {
  // Exhaustive on purpose: the purpose names the workflow's identity and
  // drives whether a revision mints a replacement one, so a new reaction kind
  // must say what its workflow is rather than inherit the push's.
  switch (reaction.kind) {
    case "agent-workflow":
      return reaction.instruction;
    case "ios-push":
      return OPERATOR_WATCH_WORKFLOW_PURPOSE;
    default:
      return assertNever(reaction);
  }
}

export const subscriptionInterpretationCodec = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    pushDetail: z.literal("existence"),
  })
  .strict();

export const subscriptionWatchGroundingCodec = z
  .object({
    matchesNow: z.boolean(),
    matchCount: z.number().int().min(0),
    recentMatchCount: z.number().int().min(0).nullable(),
    latestMatchAt: z.number().int().nullable(),
    liveness: z.enum(WATCH_TARGET_LIVENESS),
    horizonMs: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<SubscriptionWatchGrounding>;

/**
 * A plan written by an evaluator that no longer exists.
 *
 * Only ever decoded, never produced. An install that ran the first engine has
 * rows carrying its plan shapes, and those rows are still records: the operator
 * has to be able to list them, see what they were, and revoke them. A codec
 * that refused them would not remove the records — it would make every listing
 * throw, which is a worse answer than an inert row.
 *
 * Deliberately shapeless past `predicate.kind`. Restating the retired schemas
 * would keep the whole plan vocabulary alive to describe things nothing can
 * evaluate; what is needed downstream is the fact that it is legacy, which
 * {@link isLegacyPlan} answers.
 */
const legacyPlanSchema = z
  .object({
    version: z.number(),
    predicate: z.object({ kind: z.string().min(1) }).loose(),
  })
  .loose();

// z.discriminatedUnion cannot discriminate a nested key, so the plan union is
// expressed as strict object branches. Watch V2's is the only one anything
// writes; the legacy branch is last, so a live plan is never read as one.
export const storedSubscriptionCompiledPlanCodec = z.union([
  watchV2PlanSchema,
  legacyPlanSchema,
]) satisfies z.ZodType<SubscriptionCompiledPlan>;

/**
 * What a subscription's stored plan can be.
 *
 * One live shape and one dead one. Everything that decides what a record *does*
 * asks `isWatchV2Plan`; the legacy arm exists so a record written by the
 * retired evaluator still reads, lists and revokes.
 */
export type LegacySubscriptionPlan = z.infer<typeof legacyPlanSchema>;
export type SubscriptionCompiledPlan = WatchV2Plan | LegacySubscriptionPlan;

/** What a firing of a plan must carry as evidence. */
export type PlanEvidenceRule = "none" | "optional";

/**
 * How many documents a firing of this plan is allowed to carry.
 *
 * `none` is a **safety** rule the store enforces in both directions: the
 * operator approved a condition, so a firing that smuggled documents alongside
 * it would release corpus content nobody approved.
 *
 * `optional` is not a rule so much as an admission, and it exists because a
 * watch can be true for more than one reason. One that fires when a message
 * arrives *or* when a deadline passes has documents behind the first and
 * nothing behind the second, and both are correct firings of the same watch.
 * The empty case discloses strictly less than the full one, so it is safe;
 * refusing it would lose the firing at the moment the deadline mattered.
 */
export function planEvidenceRule(plan: SubscriptionCompiledPlan): PlanEvidenceRule {
  if (isWatchV2Plan(plan))
    return plan.predicate.evidence === "condition-only" ? "none" : "optional";
  // A legacy plan has no evaluator, so nothing new fires under one. Its already
  // recorded firings are read, not written, and `none` is what discloses least
  // if this is ever reached for one.
  return "none";
}

/**
 * The evidence shape a firing of this plan falls back to when it carries no
 * documents: the operator's own approved sentence and the instant it came true.
 *
 * Every plan has one. A legacy firing recorded with no documents answers as the
 * catalog watch it was — the alternative is a codec that throws on a row the
 * operator can still see listed, which is the outcome admitting legacy plans at
 * all was meant to avoid.
 */
export function conditionEvidenceKind(
  plan: SubscriptionCompiledPlan,
): typeof WATCH_V2_PLAN_KIND | "catalog-watch" {
  return isWatchV2Plan(plan) ? WATCH_V2_PLAN_KIND : "catalog-watch";
}

export const subscriptionPrivacyCategoriesCodec = z.array(z.string().min(1).max(200)).max(100);
export const subscriptionEvidenceDocumentIdsCodec = z.array(z.string().min(1)).min(1).max(10_000);

export function parseStoredSubscriptionJson<TCodec extends z.ZodType>(
  codec: TCodec,
  value: string,
  field: string,
): z.output<TCodec> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SubscriptionStorageCorruptionError(field);
  }
  const result = codec.safeParse(parsed);
  if (!result.success) throw new SubscriptionStorageCorruptionError(field);
  return result.data;
}

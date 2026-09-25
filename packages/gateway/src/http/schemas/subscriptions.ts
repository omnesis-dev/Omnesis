// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { MAX_SUBSCRIPTION_EXPIRY_MS } from "@omnesis/types";

const subscriptionExpirySchema = z.number().int().positive().max(MAX_SUBSCRIPTION_EXPIRY_MS);

export const subscriptionConditionSchema = z
  .object({
    kind: z.literal("natural-language"),
    description: z.string().trim().min(1).max(4_000),
  })
  .strict();

/**
 * A referent's name or value.
 *
 * No control characters, newlines included: a binding is rendered into the
 * woken agent's prompt beside the instruction and framed as a referent to act
 * on, so a value carrying line breaks could forge prompt structure the agent
 * has just been told to trust.
 */
const reactionBindingText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u, "must not contain control characters");

export const subscriptionReactionSchema = z
  .object({
    kind: z.literal("agent-workflow"),
    instruction: z
      .string()
      .min(1)
      .max(8_000)
      .refine((value) => value.trim().length > 0, "must not be blank"),
    /**
     * What the instruction's words point at, as the caller resolved them: the
     * conversation to post in, the address to write to, the record to update.
     *
     * An integration authors its own watch and is the only party that knows
     * where the workflow it just described should act. Without this the
     * referents could be supplied only by the operator, and taking that route
     * re-mints the anchor as operator-authored — so an agent could obtain them
     * for its own watch only by giving the watch away.
     */
    bindings: z
      .record(reactionBindingText(64), reactionBindingText(512))
      .refine((value) => Object.keys(value).length <= 32, "at most 32 bindings")
      .optional(),
  })
  .strict();

export const createSubscriptionSchema = z
  .object({
    condition: subscriptionConditionSchema,
    reaction: subscriptionReactionSchema,
    workflowId: z.string().trim().min(1).max(200).optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
    expiresAt: subscriptionExpirySchema.optional(),
  })
  .strict();

export const updateSubscriptionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    condition: subscriptionConditionSchema.optional(),
    reaction: subscriptionReactionSchema.optional(),
    expiresAt: subscriptionExpirySchema.nullable().optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.condition !== undefined ||
      value.reaction !== undefined ||
      value.expiresAt !== undefined ||
      value.status !== undefined,
    "At least one change is required.",
  )
  .refine(
    (value) =>
      value.status === undefined ||
      (value.condition === undefined &&
        value.reaction === undefined &&
        value.expiresAt === undefined),
    {
      message: "Change the Watch definition and status in separate requests.",
      path: ["status"],
    },
  );

export const subscriptionApprovalDecisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]) })
  .strict();

/** A privacy-reviewed question bound to one delivered subscription firing. */
export const subscriptionFiringAnswerSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .max(10_000)
      .refine((value) => value.trim().length > 0, "must not be blank"),
    conversationId: z
      .string()
      .regex(/^[A-Za-z0-9_:-]{1,128}$/, "must be a valid conversation id")
      .optional(),
    clientRequestId: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,160}$/, "must be a valid client request id")
      .optional(),
    /**
     * Where to deliver the answer if it cannot be released now.
     *
     * A firing answer can finish as `approval_required`, and the run that
     * asked is a one-shot background turn that ends the moment it gets that
     * reply — so without a route the approved answer has nowhere to go and
     * waits forever. Opaque to the gateway, which never interprets it: it is
     * the integration's own handle for the conversation to resume.
     *
     * Optional, because a caller that stays alive until the decision does not
     * need one, and because an integration that has not learned to send it
     * must keep working rather than start failing.
     */
    nativeConversationId: z.string().min(1).max(256).optional(),
  })
  .strict();

/**
 * What a woken run reports back about the workflow it was asked to carry out.
 *
 * Not a delivery receipt. The instruction may have called for a message, an
 * email, a change to a record, or — legitimately — nothing at all, so the
 * status says which of those happened and the report is the run's own account
 * of it. `deferred` means the run ended waiting on something that will re-enter
 * later, and is expected to be superseded by a further report.
 */
export const subscriptionFiringOutcomeSchema = z
  .object({
    status: z.enum(["completed", "nothing_to_do", "failed", "deferred"]),
    report: z.string().max(8_192).optional(),
  })
  .strict();

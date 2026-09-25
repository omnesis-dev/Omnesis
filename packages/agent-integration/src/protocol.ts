// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Versioned independently from the general Omnesis device-WebSocket protocol.
 *
 * Two numbers, not one. A gateway and the plugins that connect to it are
 * deployed separately — a harness host runs a packed tarball somebody installed
 * once — so the pair is routinely mismatched, and a single pinned literal makes
 * every contract change an outage for whoever upgrades second. The gateway
 * offers this range, each client advertises its own, and a wake is built at the
 * highest version both understand: an old plugin keeps working without the
 * fields it has never heard of, and a new one gets them the moment the gateway
 * can send them.
 */
export const AGENT_INTEGRATION_PROTOCOL_MIN_VERSION = 3 as const;
export const AGENT_INTEGRATION_PROTOCOL_VERSION = 4 as const;

// Zod 4.5 changed string size checks from JavaScript's UTF-16 code units to
// Unicode code points. These are wire-size guards, so retain the protocol's
// established UTF-16 limits independently of Zod's counting semantics.
const boundedString = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((value) => value.length <= max, {
      message: `must contain at most ${max} UTF-16 code units`,
    });

const opaqueHandle = boundedString(1, 256).regex(
  /^[A-Za-z0-9_-]+$/,
  "must be an opaque Omnesis handle",
);

const shortLivedAuthority = z
  .object({
    token: boundedString(1, 512),
    expiresAt: z.number().int().positive(),
    endpoint: boundedString(1, 512),
  })
  .strict();

/**
 * Referents the workflow's instruction names, resolved when the watch was
 * authored: the conversation to post in, the address to write to, the record to
 * update. Opaque to the gateway, which stores and transports them without
 * interpretation — a key here means whatever the instruction says it means.
 *
 * They exist because an instruction is prose. "Reply in the originating
 * conversation" is knowledge the author had and the woken agent does not, and
 * an agent that has to guess a referent either guesses right or does the work
 * and drops it on the floor.
 */
const bindingText = (max: number) =>
  boundedString(1, max)
    // No control characters, newlines included. A binding is rendered into the
    // woken agent's prompt beside the instruction and framed as a referent to
    // act on, so a value carrying line breaks could forge prompt structure the
    // agent has just been told to trust.
    .regex(/^[^\p{Cc}]+$/u, "must not contain control characters");

const reactionBindings = z
  .record(bindingText(64), bindingText(512))
  .refine((value) => Object.keys(value).length <= 32, {
    message: "at most 32 bindings",
  });

export type ReactionBindings = z.infer<typeof reactionBindings>;

/**
 * The complete external wake contract. It is deliberately strict: adding a
 * corpus-derived field anywhere makes parsing fail rather than silently
 * exposing it to a first-party agent integration.
 *
 * Version 3 is the identifier-and-instruction wake. Version 4 adds the
 * author's bindings and the authority to report what the run did — neither
 * carries corpus content, and both are absent rather than empty when the
 * gateway has nothing to say.
 */
const subscriptionDeliveryV3Schema = z
  .object({
    protocolVersion: z.literal(AGENT_INTEGRATION_PROTOCOL_MIN_VERSION),
    deliveryId: opaqueHandle,
    firingId: opaqueHandle,
    subscriptionId: opaqueHandle,
    workflowHandle: opaqueHandle,
    reaction: z
      .object({
        instruction: boundedString(1, 16_384),
      })
      .strict(),
    answer: shortLivedAuthority,
  })
  .strict();

const subscriptionDeliveryV4Schema = z
  .object({
    protocolVersion: z.literal(AGENT_INTEGRATION_PROTOCOL_VERSION),
    deliveryId: opaqueHandle,
    firingId: opaqueHandle,
    subscriptionId: opaqueHandle,
    workflowHandle: opaqueHandle,
    reaction: z
      .object({
        instruction: boundedString(1, 16_384),
        bindings: reactionBindings.optional(),
      })
      .strict(),
    answer: shortLivedAuthority,
    /**
     * Absent when the gateway could not mint one. A wake with nowhere to
     * report is still a wake worth running — refusing to deliver the workflow
     * because its receipt could not be authorized would trade missing
     * bookkeeping for missing work.
     */
    outcome: shortLivedAuthority.optional(),
  })
  .strict();

export const subscriptionDeliverySchema = z
  .union([subscriptionDeliveryV3Schema, subscriptionDeliveryV4Schema])
  .superRefine((delivery, context) => {
    if (delivery.answer.endpoint !== `/subscriptions/firings/${delivery.firingId}/answer`) {
      context.addIssue({
        code: "custom",
        path: ["answer", "endpoint"],
        message: "must be bound to the delivered firing identifier",
      });
    }
    if (
      "outcome" in delivery &&
      delivery.outcome !== undefined &&
      delivery.outcome.endpoint !== `/subscriptions/firings/${delivery.firingId}/outcome`
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "endpoint"],
        message: "must be bound to the delivered firing identifier",
      });
    }
  });

export type SubscriptionDelivery = z.infer<typeof subscriptionDeliverySchema>;

/**
 * One version's wake, named so a caller holding a wake it built itself — a
 * test, a probe — can say which dialect it means. Reading a wake off the wire
 * uses {@link SubscriptionDelivery} and the helpers below, which answer what
 * it carries without asking what version said so.
 */
export type SubscriptionDeliveryV3 = z.infer<typeof subscriptionDeliveryV3Schema>;
export type SubscriptionDeliveryV4 = z.infer<typeof subscriptionDeliveryV4Schema>;

/** The bindings a wake carried, or none when it predates them. */
export function deliveryBindings(delivery: SubscriptionDelivery): ReactionBindings {
  return "bindings" in delivery.reaction ? (delivery.reaction.bindings ?? {}) : {};
}

/** The authority to report this run's outcome, when the wake carried one. */
export function deliveryOutcomeAuthority(
  delivery: SubscriptionDelivery,
): { token: string; expiresAt: number; endpoint: string } | null {
  return "outcome" in delivery ? (delivery.outcome ?? null) : null;
}

/**
 * What a woken run reports back when it ends.
 *
 * Deliberately not a delivery receipt for a notification: a workflow may send
 * a message, file something, change a record, or correctly decide there was
 * nothing to do. The status says which of those happened, and the report is
 * the run's own account of it in its own words.
 */
const WORKFLOW_OUTCOME_STATUSES = [
  /** The instruction was carried out. */
  "completed",
  /**
   * Carried out as far as it goes: the instruction called for nothing here —
   * a match its own escape clause excludes, say.
   *
   * Accepted from any harness, emitted by none of the bundled ones: neither
   * OpenClaw nor Hermes exposes what a run actually invoked, so "it decided
   * there was nothing to do" is not something the plugin can observe rather
   * than take the model's word for. It stays in the vocabulary because the
   * distinction is real to whoever is auditing a firing's silence, and a
   * harness that can see it should be able to say it.
   */
  "nothing_to_do",
  /** The run ended without finishing, and nothing will resume it. */
  "failed",
  /** Ended waiting on something — a held answer — that will re-enter later. */
  "deferred",
] as const;

export type WorkflowOutcomeStatus = (typeof WORKFLOW_OUTCOME_STATUSES)[number];

export const workflowOutcomeReportSchema = z
  .object({
    status: z.enum(WORKFLOW_OUTCOME_STATUSES),
    report: boundedString(0, 8_192).optional(),
  })
  .strict();

export type WorkflowOutcomeReport = z.infer<typeof workflowOutcomeReportSchema>;

/**
 * Identifier-only terminal Answer wake; its route is a native conversation.
 *
 * Protocol v4 removed the v3 one-use bearer and endpoint fields. Requiring the
 * current version keeps an older plugin from interpreting this new shape as
 * an authority-bearing wake.
 */
export const answerCompletionDeliverySchema = z
  .object({
    protocolVersion: z.literal(AGENT_INTEGRATION_PROTOCOL_VERSION),
    deliveryId: opaqueHandle,
    taskId: opaqueHandle,
    nativeConversationId: opaqueHandle,
  })
  .strict();

export type AnswerCompletionDelivery = z.infer<typeof answerCompletionDeliverySchema>;

export const deliveryPreparationSchema = z
  .object({
    status: z.literal("prepared"),
    preparedAt: z.number().int().nonnegative(),
    duplicate: z.boolean(),
  })
  .strict();

export type DeliveryPreparation = z.infer<typeof deliveryPreparationSchema>;

export const deliveryAcceptanceSchema = z
  .object({
    status: z.literal("accepted"),
    acceptedAt: z.number().int().nonnegative(),
    localRunId: boundedString(1, 512),
    duplicate: z.boolean(),
  })
  .strict();

export type DeliveryAcceptance = z.infer<typeof deliveryAcceptanceSchema>;

export const deliveryCancellationSchema = z
  .object({
    status: z.enum(["cancelled", "too_late"]),
    cancelledAt: z.number().int().nonnegative(),
    duplicate: z.boolean(),
  })
  .strict();

export type DeliveryCancellation = z.infer<typeof deliveryCancellationSchema>;

export const agentIntegrationCapabilitySchema = z
  .object({
    harness: z.enum(["openclaw", "hermes"]),
    deliveryProtocolMin: z.number().int().positive().max(64),
    deliveryProtocolMax: z.number().int().positive().max(64),
    maxConcurrentRuns: z.number().int().positive().max(128),
    watchPrivacyPolicyVersion: z.literal(1).optional(),
  })
  .strict()
  .refine((capability) => capability.deliveryProtocolMin <= capability.deliveryProtocolMax, {
    message: "the protocol range must not be inverted",
  });

export type AgentIntegrationCapability = z.infer<typeof agentIntegrationCapabilitySchema>;

/** The agent harnesses an Omnesis plugin binds into. */
export type Harness = AgentIntegrationCapability["harness"];

/**
 * The fleet update reaching a harness plugin. It carries either a release
 * version or an exact source commit; the CLI on this machine validates the
 * target against its own configured remote.
 *
 * The same shape as `device.update` in `@omnesis/core`'s registry, restated
 * because this package deliberately depends on nothing in the workspace at
 * runtime. The half with teeth — which version strings are accepted — is held
 * equal to the registry's by `wake-contract-parity.test.ts`.
 */
/**
 * The longest `device.update.result` detail the gateway accepts; a longer one
 * is dropped with its event. The same number as `@omnesis/core`'s
 * `DEVICE_UPDATE_DETAIL_MAX_CHARS`, held equal by `wake-contract-parity.test.ts`.
 */
export const DEVICE_UPDATE_DETAIL_MAX_CHARS = 2_000;

export const deviceUpdateCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: z.string().min(1),
    type: z.literal("device.update"),
    // `allowRewind` is the operator's permission for a target that is neither a
    // newer release nor a descendant of this build, sent only when granted.
    payload: z.union([
      z
        .object({
          version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][\w.-]+)?$/u),
          allowRewind: z.literal(true).optional(),
        })
        .strict(),
      z
        .object({
          commit: z.string().regex(/^[0-9a-f]{40}$/u),
          allowRewind: z.literal(true).optional(),
        })
        .strict(),
    ]),
  })
  .strict();

export const subscriptionPrepareCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: z.string().min(1),
    type: z.literal("subscription.prepare"),
    payload: subscriptionDeliverySchema,
  })
  .strict();

export type SubscriptionPrepareCommand = z.infer<typeof subscriptionPrepareCommandSchema>;

export const answerCompletionPrepareCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: z.string().min(1),
    type: z.literal("answer-completion.prepare"),
    payload: answerCompletionDeliverySchema,
  })
  .strict();

// Stated in the version its own wake was spoken in, so a commit for a v3
// delivery is not rejected by a plugin that also understands v4.
const deliveryControlPayloadSchema = z
  .object({
    protocolVersion: z.union([
      z.literal(AGENT_INTEGRATION_PROTOCOL_MIN_VERSION),
      z.literal(AGENT_INTEGRATION_PROTOCOL_VERSION),
    ]),
    deliveryId: opaqueHandle,
  })
  .strict();

export const subscriptionCommitCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: z.string().min(1),
    type: z.literal("subscription.commit"),
    payload: deliveryControlPayloadSchema,
  })
  .strict();

export const subscriptionCancelCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: z.string().min(1),
    type: z.literal("subscription.cancel"),
    payload: deliveryControlPayloadSchema,
  })
  .strict();

export const answerCompletionCommitCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: z.string().min(1),
    type: z.literal("answer-completion.commit"),
    payload: deliveryControlPayloadSchema,
  })
  .strict();

export const answerCompletionCancelCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: z.string().min(1),
    type: z.literal("answer-completion.cancel"),
    payload: deliveryControlPayloadSchema,
  })
  .strict();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable delivery identity used for replay protection.
 *
 * The bearer and its expiry are transport authority, not business identity:
 * the gateway rotates them on redelivery after a lost ACK. Everything else,
 * including the firing-bound endpoint, remains conflict-sensitive.
 */
function stableDeliveryHash(delivery: object, answer: { endpoint: string }): string {
  const identity = {
    ...delivery,
    answer: { endpoint: answer.endpoint },
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(identity)))
    .digest("hex");
}

export function deliveryPayloadHash(delivery: SubscriptionDelivery): string {
  const parsed = subscriptionDeliverySchema.parse(delivery);
  // Both bearers are transport authority rather than business identity: the
  // gateway mints fresh ones whenever it re-sends a wake whose acknowledgement
  // was lost. Were either part of the identity, that ordinary redelivery would
  // read as a different wake for the same delivery id — a conflict the plugin
  // refuses, permanently, for a firing that is otherwise perfectly runnable.
  const identity =
    "outcome" in parsed && parsed.outcome !== undefined
      ? { ...parsed, outcome: { endpoint: parsed.outcome.endpoint } }
      : parsed;
  return stableDeliveryHash(identity, parsed.answer);
}

/** Completion wakes carry task identity only; the OAuth principal retrieves content. */
export function answerCompletionDeliveryHash(delivery: AnswerCompletionDelivery): string {
  const parsed = answerCompletionDeliverySchema.parse(delivery);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(parsed)))
    .digest("hex");
}

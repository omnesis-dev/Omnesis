// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed registry of every WebSocket message type that gateway, collector and
 * iOS exchange over `/device/ws`.
 *
 * Both sides import from the same registry so that adding a field on one end
 * and forgetting the other becomes a compile error rather than a runtime
 * payload-shape mismatch. Each entry pairs a zod schema (the runtime
 * validator) with a static type derived from `z.infer`, which lets handlers
 * receive a fully-typed payload instead of `unknown` casts.
 *
 * Three kinds of message:
 *   - **Commands** carry a request payload and expect a single typed response
 *     keyed by correlation id. `wsCommandSchemas` maps the type string to
 *     `{ request, response }` zod schemas.
 *   - **Events** are one-way, no correlation. `wsEventSchemas` maps the type
 *     string to a single payload schema.
 *   - **The hello handshake** is a command but is special-cased because it
 *     also negotiates `PROTOCOL_VERSION`.
 *
 * Versioning. The `protocolVersion` field on `hello` lets a future redesign
 * reject pre-Vn messages cleanly. Bump `PROTOCOL_VERSION` when the wire
 * shape of any message in the registry changes incompatibly. Pre-launch with
 * a single user, lockstep upgrades are fine; once external parties connect,
 * a mismatch should surface as a typed `protocol_version_mismatch` error.
 */

import { z } from "zod";
import { MULTI_DEVICE_MODES } from "@omnesis/types";
import { sourceContractWireRangeSchema } from "./source-contract-wire.js";
import { syncRemediationSchema } from "./sync-remediation.js";
import { syncIssuesSchema, syncIssueAssessmentsSchema } from "./sync-issues.js";
import { trySourceType } from "./ids.js";
import { doctorReportSchema, doctorTextSchema } from "./doctor/schema.js";
import {
  agentSessionCreateRequest,
  agentSessionCreateResponse,
  agentMessageSendRequest,
  agentMessageSendResponse,
  agentSessionCancelRequest,
  agentSessionCancelResponse,
  agentUserMessageEvent,
  agentMessageStartEvent,
  agentTextDeltaEvent,
  agentThinkingDeltaEvent,
  agentUsageUpdateEvent,
  agentToolInputStartEvent,
  agentToolStartEvent,
  agentToolResultEvent,
  agentToolChildStartEvent,
  agentToolChildResultEvent,
  agentCitationEvent,
  agentCitationsUpdateEvent,
  agentSubagentSpawnedEvent,
  agentSubagentEventEvent,
  agentSubagentResultEvent,
  agentDeepResearchSummaryEvent,
  agentMessageEndEvent,
  agentErrorEvent,
  agentResyncEvent,
} from "./agent-protocol.js";

/**
 * Current wire protocol version. Bump on any incompatible change to
 * command/event shapes in this file. Both gateway and clients send this in
 * the hello handshake; mismatches are rejected with `protocol_version_mismatch`.
 */
export const PROTOCOL_VERSION = 1 as const; // PARITY:device-ws-protocol-version

// ─── Command spec helper ────────────────────────────────────────────────────

interface CommandSpec<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny> {
  readonly request: Req;
  readonly response: Res;
}

function command<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(
  request: Req,
  response: Res,
): CommandSpec<Req, Res> {
  return { request, response };
}

// ─── Shared sub-schemas ─────────────────────────────────────────────────────

const sourceTypeSchema = z.string().transform((s, ctx) => {
  const sourceType = trySourceType(s);
  if (!sourceType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid source type" });
    return z.NEVER;
  }
  return sourceType;
});

/** DeviceCapability is an open record; allow forward-compatible fields. */
const deviceCapabilitySchema = z
  .object({
    sourceContract: sourceContractWireRangeSchema.optional(),
    hostableSourceTypes: z.array(sourceTypeSchema).optional(),
    pushBasedSourceTypes: z.array(sourceTypeSchema).optional(),
    multiDeviceModes: z.record(sourceTypeSchema, z.enum(MULTI_DEVICE_MODES)).optional(),
    replicaVersionPolicies: z.record(sourceTypeSchema, z.literal("source-updated-at")).optional(),
    memberScopedParams: z.record(sourceTypeSchema, z.array(z.string().min(1).max(128))).optional(),
    syncLease: z.boolean().optional(),
    deviceDoctor: z.literal(true).optional(),
    pushAppId: z.string().trim().min(1).max(255).optional(),
    agentIntegration: z
      .object({
        harness: z.enum(["openclaw", "hermes"]),
        // A range, not a pin: the gateway speaks a span of delivery versions
        // and each plugin says which of them it understands, so the two can be
        // upgraded independently rather than in lockstep.
        deliveryProtocolMin: z.number().int().positive().max(64),
        deliveryProtocolMax: z.number().int().positive().max(64),
        maxConcurrentRuns: z.number().int().positive().max(128),
        watchPrivacyPolicyVersion: z.literal(1).optional(),
      })
      .strict()
      .refine((capability) => capability.deliveryProtocolMin <= capability.deliveryProtocolMax, {
        message: "the protocol range must not be inverted",
      })
      .optional(),
    hostname: z.string().optional(),
    platform: z.string().optional(),
    version: z.string().optional(),
    sourceCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .optional(),
  })
  .passthrough();

// Subset of SourceRecord that the collector reconciler actually consumes.
// No `.passthrough()` — passthrough's inferred type adds an index signature
// that breaks structural compatibility with the gateway's branded
// SourceRecord type. The wire shape carries more fields (createdAt, etc.)
// but they're ignored by the reconciler, so we don't model them here.
const sourceSnapshotEntrySchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  accountId: z.string().optional(),
  config: z.unknown().optional(),
  enabled: z.boolean().optional(),
  // Optional so a current collector can still reconcile snapshots from a
  // pre-persistence gateway. When present, this source-instance value is
  // authoritative over the provider descriptor bundled with the collector.
  multiDeviceMode: z.enum(MULTI_DEVICE_MODES).optional(),
});

// ─── Commands ───────────────────────────────────────────────────────────────

const helloRequest = z.object({
  token: z.string().min(1).optional(),
  capabilities: deviceCapabilitySchema.optional(),
  protocolVersion: z.number().int().nonnegative(),
});
const helloResponse = z.object({
  deviceId: z.string(),
  scopes: z.array(z.string()),
  deviceName: z.string(),
  deviceKind: z.string(),
  protocolVersion: z.number().int().nonnegative(),
});

const sourceDescriptorsRequest = z.object({}).strict();
const sourceDescriptorsResponse = z.object({
  // Descriptor JSON shape lives in @omnesis/core's serializeDescriptor; treat
  // it as opaque here so the registry doesn't have to mirror every provider
  // option struct verbatim.
  descriptors: z.array(z.unknown()),
  hostname: z.string(),
});

const sourceValidateParamRequest = z.object({
  descriptorId: z.string().min(1),
  paramName: z.string().min(1),
  value: z.string().optional(),
});
const sourceValidateParamResponse = z.object({
  valid: z.boolean(),
  error: z.string().optional(),
});

const sourceDiscoverRequest = z.object({
  descriptorId: z.string().min(1),
});
const sourceDiscoverResponse = z.object({
  accounts: z.array(z.string()),
});

const sourceResolveAccountRequest = z.object({
  descriptorId: z.string().min(1),
  params: z.record(z.string(), z.string()),
});
const sourceResolveAccountResponse = z.object({ accountId: z.string().min(1) });

const sourcesSnapshotRequestRequest = z.object({}).strict();
const sourcesSnapshotRequestResponse = z.object({
  // SourceManager.getConfiguredSources returns a record keyed by source id.
  configured: z.record(z.string(), z.unknown()),
});

const sourceAddRequest = z.object({
  descriptorId: z.string().min(1),
  accountIds: z.array(z.string().min(1)).min(1),
  params: z.record(z.string(), z.string()).optional(),
});
const sourceAddResponse = z.object({
  sourceIds: z.array(z.string()),
});

const sourceReauthFinalizeRequest = z.object({
  providerType: z.string().min(1),
  accountId: z.string().min(1),
});
const sourceReauthFinalizeResponse = z.object({
  sourceIds: z.array(z.string()),
});

const sourceSyncRequest = z.object({
  sourceId: z.string().min(1),
  /**
   * Start the source over: a run already in flight is aborted and the source
   * resets its own state (`onResync`) before the fresh sync. A device that
   * does not know the flag ignores it and answers as for a plain sync, so a
   * source mid-sync there counts as `skipped`.
   */
  restart: z.boolean().optional(),
});
const sourceSyncResponse = z.object({
  ok: z.boolean(),
  /** Syncs started by this command. */
  triggered: z.number().int().nonnegative().optional(),
  /** Sources already syncing that the command left alone. */
  skipped: z.number().int().nonnegative().optional(),
  /** Sources paused on the device. */
  disabled: z.number().int().nonnegative().optional(),
  /**
   * Sources whose run in flight was aborted for a `restart`; the fresh sync
   * starts once that run has stopped.
   */
  restarting: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

const sourceDebugRequest = z.object({
  sourceId: z.string().min(1),
});
const sourceDebugResponse = z.object({
  status: z.unknown().nullable(),
});

const authBeginRequest = z.object({
  flowId: z.string().min(1),
  sourceType: z.string().min(1),
  params: z.record(z.string(), z.string()).optional(),
  // Set when the flow re-authenticates an existing account — surfaced to
  // the provider's authFlow as `callbacks.accountId` so it can reuse
  // stored per-account parameters.
  accountId: z.string().optional(),
  // Externally-reachable HTTPS base URL of the gateway (no trailing slash),
  // from `gateway.publicBaseUrl`. Forwarded so the provider's authFlow can
  // build `${publicBaseUrl}/oauth/callback` (surfaced as
  // `callbacks.publicBaseUrl`) instead of a same-machine localhost callback.
  // Unset → providers keep the local-only `localhost:3003` fallback.
  // Fields the user pasted for a `perAccount` credentials spec, carried to the
  // provider's authFlow instead of being written to a shared file first. Bounded
  // deliberately: this ends up serialised onto a single stdin line to the auth
  // subprocess, which — unlike an argv payload — has no kernel-side size limit.
  credentials: z
    .record(z.string().max(64), z.string().max(8192))
    .refine((r) => Object.keys(r).length <= 32, "too many credential fields")
    .optional(),
  publicBaseUrl: z.string().url().optional(),
  // Which challenge kinds the client driving this flow can draw. Declared,
  // because this object is strict: a field the gateway sends and this schema
  // does not name is stripped here and never reaches the collector.
  renders: z.array(z.string().min(1).max(32)).max(16).optional(),
});
const authBeginResponse = z.object({
  started: z.literal(true),
});

const authCancelRequest = z.object({
  flowId: z.string().min(1),
  // Why the flow is ending. `denied` is the case worth naming: the operator
  // reached the platform's consent screen and said no, which arrives as an
  // `error=` on the redirect the gateway catches. Without it the collector
  // could only kill the subprocess, so the provider's own failure path never
  // ran — and a provider that has just created something it must undo needs
  // that path more than it needs a clean exit.
  reason: z.enum(["cancelled", "denied"]).optional(),
  // A safe sentence for the operator. Never the platform's raw error string.
  detail: z.string().max(500).optional(),
});
const authCancelResponse = z.object({
  ok: z.literal(true),
});

const authCodeRequest = z.object({
  flowId: z.string().min(1),
  code: z.string().min(1),
});
const authCodeResponse = z.object({
  ok: z.boolean(),
});

// Hosted-widget (`link-widget`) result delivery — the symmetric counterpart of
// `auth.code` for sources whose add flow runs a client-rendered widget (Plaid
// Link, …). Carries the opaque widget result token (e.g. a Plaid
// `public_token`) plus optional metadata (selected institution / accounts).
const authWidgetResultRequest = z.object({
  flowId: z.string().min(1),
  token: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const authWidgetResultResponse = z.object({
  ok: z.boolean(),
});

// One answer to one typed challenge, for a provider that declares
// `authenticate`. Addressed by the challenge id rather than by position: a
// flow may put several questions to the operator, and an answer that arrives
// after they went back and changed an earlier one must not resolve the wrong
// wait. Field count and value size are bounded for the same reason the pasted
// credential fields are — this is a channel a client fills.
// One answered field. The same ceiling the pasted credential fields use, for
// the same reason: this is a channel a client fills, and an answer nobody can
// deliver is a flow that waits until it expires. A nested object is admitted
// only for a widget's metadata, which is the one shape that is not a scalar.
const answerValue = z.union([
  z.string().max(8192),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string().max(64), z.unknown()),
]);

const authAnswerRequest = z.object({
  flowId: z.string().min(1),
  challengeId: z.string().min(1),
  answer: z
    .record(z.string().min(1).max(64), answerValue)
    .refine((a) => Object.keys(a).length <= 32, {
      message: "an answer may carry at most 32 fields",
    }),
});
const authAnswerResponse = z.object({
  ok: z.boolean(),
});

// History import (#588): gateway → device command to run a source's one-time
// bulk import, with progress/result streamed back as events.
const importBeginRequest = z.object({
  flowId: z.string().min(1),
  sourceId: z.string().min(1),
  values: z.record(z.string(), z.string()),
});
const importBeginResponse = z.object({
  started: z.literal(true),
});
const importCancelRequest = z.object({
  flowId: z.string().min(1),
});
const importCancelResponse = z.object({
  ok: z.literal(true),
});

/**
 * Fleet update: the gateway names a release or exact commit and the device
 * updates itself.
 *
 * Nothing but the target identifier crosses the wire. The device runs its own
 * local `omnesis update` against its own remote and validates the target there,
 * which keeps a mistaken or compromised gateway from supplying a command.
 *
 * The response is a receipt, not an outcome: an update is minutes of `npm
 * ci` and a build, far past any command timeout, and the device restarts
 * before it could answer. The outcome comes back as `device.update.result`,
 * emitted before the process exits for its supervisor to restart.
 */
/**
 * Exactly one validated target. Validation happens at the wire boundary rather
 * than in each handler because the value becomes an argument to a command the
 * device runs on itself.
 */
const productVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][\w.-]+)?$/u, "not a release version");

const sourceCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u, "not a full commit id");
/**
 * `allowRewind` carries the operator's explicit permission for a target that
 * is neither a newer release nor a descendant of the device's build. It is
 * sent only when granted, so a device on an older build — whose schema is
 * strict — never sees the field in an ordinary update.
 */
const deviceUpdateTarget = z.union([
  z.object({ version: productVersionSchema, allowRewind: z.literal(true).optional() }).strict(),
  z.object({ commit: sourceCommitSchema, allowRewind: z.literal(true).optional() }).strict(),
]);
const deviceUpdateRequest = deviceUpdateTarget;
const deviceUpdateResponse = z.object({
  /** True once the device has started the update. */
  accepted: z.boolean(),
  /** Why it did not start — set only when `accepted` is false. */
  reason: z.string().max(512).optional(),
});

const doctorRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u, "invalid doctor run id");
const deviceDoctorRequest = z.object({ runId: doctorRunIdSchema }).strict();
const deviceDoctorResponse = z
  .object({
    accepted: z.boolean(),
    reason: doctorTextSchema(512).optional(),
  })
  .strict();

const credentialsStatusRequest = z.object({}).strict();
const credentialsEntrySchema = z.object({
  fileKey: z.string(),
  providerType: z.string(),
  providerName: z.string(),
  spec: z.unknown(),
  configured: z.boolean(),
});
const credentialsStatusResponse = z.object({
  hostname: z.string(),
  entries: z.array(credentialsEntrySchema),
});

const credentialsSetRequest = z.object({
  fileKey: z.string().min(1),
  fields: z.record(z.string(), z.string()),
});
const credentialsSetResponse = z.object({
  ok: z.literal(true),
  fileKey: z.string(),
});

const credentialsClearRequest = z.object({
  fileKey: z.string().min(1),
});
const credentialsClearResponse = z.object({
  ok: z.literal(true),
  fileKey: z.string(),
});

// Gateway-pushed source-registry sync. Sent G→D after hello (initial state)
// and on every admin-side mutation. The collector reconciles its in-memory
// instances to match.
const sourcesSnapshotRequest = z.object({
  sources: z.array(sourceSnapshotEntrySchema),
});
const sourcesSnapshotResponse = z.object({
  ok: z.boolean(),
  applied: z.union([z.boolean(), z.number().int().nonnegative()]).optional(),
  error: z.string().optional(),
});

const sourceAddedRequest = z.object({
  source: sourceSnapshotEntrySchema.nullable(),
});
const sourceAddedResponse = z.object({
  ok: z.boolean(),
  applied: z.boolean().optional(),
  error: z.string().optional(),
});

const sourceRemovedRequest = z.object({
  sourceId: z.string().min(1),
});
const sourceRemovedResponse = z.object({
  ok: z.boolean(),
  applied: z.boolean().optional(),
  deleted: z.array(z.string()).optional(),
  failures: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

const sourceUpdatedRequest = z.object({
  source: sourceSnapshotEntrySchema.extend({ enabled: z.boolean() }).nullable(),
});
const sourceUpdatedResponse = z.object({
  ok: z.boolean(),
  applied: z.boolean().optional(),
  error: z.string().optional(),
});

// Gateway → first-party OpenClaw/Hermes integration. Preparing a wake only
// durably stores it in the integration inbox. The gateway revalidates the live
// subscription authority before issuing the separate commit that may start the
// external workflow. A cancel tombstone closes the revoke-before-commit race.
//
// The strict preparation carries no corpus-derived fields: only opaque
// identifiers, the subscriber-authored reaction, and a short-lived authority
// for the firing-bound Answer route.
/**
 * The wake protocol range this build speaks to an external agent integration.
 *
 * Declared here as well as in `@omnesis/agent-integration`, which ships as a
 * standalone plugin and deliberately depends on nothing of Omnesis. The two
 * declarations are held equal by a test rather than by an import.
 */
export const AGENT_DELIVERY_PROTOCOL_MIN_VERSION = 3 as const;
export const AGENT_DELIVERY_PROTOCOL_VERSION = 4 as const;

/**
 * A referent's name or value.
 *
 * No control characters, newlines included: a binding is rendered into the
 * woken agent's prompt beside the instruction and framed as a referent to act
 * on, so a value carrying line breaks could forge prompt structure the agent
 * has just been told to trust.
 */
const wakeBindingText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u, "must not contain control characters");

const subscriptionShortLivedAuthority = z
  .object({
    token: z.string().min(1).max(512),
    expiresAt: z.number().int().positive(),
    endpoint: z.string().min(1).max(512),
  })
  .strict();

const subscriptionPrepareV3Request = z
  .object({
    protocolVersion: z.literal(AGENT_DELIVERY_PROTOCOL_MIN_VERSION),
    deliveryId: z.string().min(1).max(256),
    firingId: z.string().min(1).max(256),
    subscriptionId: z.string().min(1).max(256),
    workflowHandle: z.string().min(1).max(256),
    reaction: z
      .object({
        instruction: z.string().min(1).max(16_384),
      })
      .strict(),
    answer: subscriptionShortLivedAuthority,
  })
  .strict();

// Version 4 adds the referents the reaction's prose names and the authority a
// woken run reports its outcome through. Neither is corpus-derived: bindings
// are what the watch's author wrote down, and the outcome authority carries a
// report inward rather than anything outward.
const subscriptionPrepareV4Request = z
  .object({
    protocolVersion: z.literal(AGENT_DELIVERY_PROTOCOL_VERSION),
    deliveryId: z.string().min(1).max(256),
    firingId: z.string().min(1).max(256),
    subscriptionId: z.string().min(1).max(256),
    workflowHandle: z.string().min(1).max(256),
    reaction: z
      .object({
        instruction: z.string().min(1).max(16_384),
        bindings: z
          .record(wakeBindingText(64), wakeBindingText(512))
          .refine((value) => Object.keys(value).length <= 32, { message: "at most 32 bindings" })
          .optional(),
      })
      .strict(),
    answer: subscriptionShortLivedAuthority,
    // Absent when the gateway could not mint one: a wake with nowhere to
    // report is still a wake worth running.
    outcome: subscriptionShortLivedAuthority.optional(),
  })
  .strict();

const subscriptionPrepareRequest = z
  .union([subscriptionPrepareV3Request, subscriptionPrepareV4Request])
  .superRefine((delivery, context) => {
    if (delivery.answer.endpoint !== `/subscriptions/firings/${delivery.firingId}/answer`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
        path: ["outcome", "endpoint"],
        message: "must be bound to the delivered firing identifier",
      });
    }
  });

const subscriptionPrepareResponse = z
  .object({
    status: z.literal("prepared"),
    preparedAt: z.number().int().nonnegative(),
    duplicate: z.boolean(),
  })
  .strict();

// A control frame states the version the wake it controls was spoken in, so a
// commit never arrives claiming a dialect its own prepare did not use.
const subscriptionCommitRequest = z
  .object({
    protocolVersion: z.union([
      z.literal(AGENT_DELIVERY_PROTOCOL_MIN_VERSION),
      z.literal(AGENT_DELIVERY_PROTOCOL_VERSION),
    ]),
    deliveryId: z.string().min(1).max(256),
  })
  .strict();

const subscriptionCommitResponse = z
  .object({
    status: z.literal("accepted"),
    acceptedAt: z.number().int().nonnegative(),
    localRunId: z.string().min(1).max(512),
    duplicate: z.boolean(),
  })
  .strict();

const subscriptionCancelRequest = subscriptionCommitRequest;

const subscriptionCancelResponse = z
  .object({
    status: z.enum(["cancelled", "too_late"]),
    cancelledAt: z.number().int().nonnegative(),
    duplicate: z.boolean(),
  })
  .strict();

// Completion wakes are deliberately separate from subscription wakes. A
// completed Answer has no firing, reaction, or standing subscription grant;
// carrying any of those here would create a false authority dependency.
const answerCompletionPrepareRequest = z
  .object({
    protocolVersion: z.literal(AGENT_DELIVERY_PROTOCOL_VERSION),
    deliveryId: z.string().min(1).max(256),
    taskId: z.string().min(1).max(256),
    nativeConversationId: z.string().min(1).max(256),
  })
  .strict();
const answerCompletionPrepareResponse = subscriptionPrepareResponse;
const answerCompletionCommitRequest = subscriptionCommitRequest;
const answerCompletionCommitResponse = subscriptionCommitResponse;
const answerCompletionCancelRequest = subscriptionCancelRequest;
const answerCompletionCancelResponse = subscriptionCancelResponse;

/**
 * Frozen registry of every command type. Adding an entry here is the only
 * supported way to introduce a new command — both producer and consumer
 * pick up the new type on the next compile, and forgetting one side surfaces
 * as a TS error.
 */
export const wsCommandSchemas = {
  hello: command(helloRequest, helloResponse),
  "source.descriptors": command(sourceDescriptorsRequest, sourceDescriptorsResponse),
  "source.validate-param": command(sourceValidateParamRequest, sourceValidateParamResponse),
  "source.discover": command(sourceDiscoverRequest, sourceDiscoverResponse),
  "source.resolve-account": command(sourceResolveAccountRequest, sourceResolveAccountResponse),
  "sources.snapshot.request": command(
    sourcesSnapshotRequestRequest,
    sourcesSnapshotRequestResponse,
  ),
  "source.add": command(sourceAddRequest, sourceAddResponse),
  "source.reauth-finalize": command(sourceReauthFinalizeRequest, sourceReauthFinalizeResponse),
  "source.sync": command(sourceSyncRequest, sourceSyncResponse),
  "source.debug": command(sourceDebugRequest, sourceDebugResponse),
  "auth.begin": command(authBeginRequest, authBeginResponse),
  "auth.cancel": command(authCancelRequest, authCancelResponse),
  "auth.code": command(authCodeRequest, authCodeResponse),
  "auth.widget-result": command(authWidgetResultRequest, authWidgetResultResponse),
  "auth.answer": command(authAnswerRequest, authAnswerResponse),
  "device.update": command(deviceUpdateRequest, deviceUpdateResponse),
  "device.doctor": command(deviceDoctorRequest, deviceDoctorResponse),
  "import.begin": command(importBeginRequest, importBeginResponse),
  "import.cancel": command(importCancelRequest, importCancelResponse),
  "credentials.status": command(credentialsStatusRequest, credentialsStatusResponse),
  "credentials.set": command(credentialsSetRequest, credentialsSetResponse),
  "credentials.clear": command(credentialsClearRequest, credentialsClearResponse),
  "sources.snapshot": command(sourcesSnapshotRequest, sourcesSnapshotResponse),
  "source.added": command(sourceAddedRequest, sourceAddedResponse),
  "source.removed": command(sourceRemovedRequest, sourceRemovedResponse),
  "source.updated": command(sourceUpdatedRequest, sourceUpdatedResponse),
  "agent.session.create": command(agentSessionCreateRequest, agentSessionCreateResponse),
  "agent.message.send": command(agentMessageSendRequest, agentMessageSendResponse),
  "agent.session.cancel": command(agentSessionCancelRequest, agentSessionCancelResponse),
  "subscription.prepare": command(subscriptionPrepareRequest, subscriptionPrepareResponse),
  "subscription.commit": command(subscriptionCommitRequest, subscriptionCommitResponse),
  "subscription.cancel": command(subscriptionCancelRequest, subscriptionCancelResponse),
  "answer-completion.prepare": command(
    answerCompletionPrepareRequest,
    answerCompletionPrepareResponse,
  ),
  "answer-completion.commit": command(
    answerCompletionCommitRequest,
    answerCompletionCommitResponse,
  ),
  "answer-completion.cancel": command(
    answerCompletionCancelRequest,
    answerCompletionCancelResponse,
  ),
} as const;

export type WsCommandRegistry = typeof wsCommandSchemas;
export type WsCommandType = keyof WsCommandRegistry;

export type WsRequestPayload<K extends WsCommandType> = z.infer<WsCommandRegistry[K]["request"]>;
export type WsResponsePayload<K extends WsCommandType> = z.infer<WsCommandRegistry[K]["response"]>;

// ─── Events ─────────────────────────────────────────────────────────────────

const pingEvent = z.object({ t: z.number() });

const deviceStatusEvent = z.object({
  deviceId: z.string(),
  online: z.boolean(),
});

const documentsUpsertedEvent = z.object({
  sourceId: z.string(),
  count: z.number().int().nonnegative(),
});

/** Content-free hint that this device has one notification ready to claim. */
const pushAvailableEvent = z.object({}).strict();

const configChangedEvent = z.object({
  changedPaths: z.array(z.string()),
  version: z.unknown().optional(),
});

const syncStatusEvent = z.object({
  sourceId: z.string(),
  deviceId: z.string().optional(),
  providerId: z.string().optional(),
  state: z.enum(["idle", "syncing", "completed", "error", "needs-auth", "rate-limited"]),
  unitName: z.string().optional(),
  // Mirrors the gateway's SourceSyncStatus.progress + DisplaySyncStatus.progress.
  // Fields are all optional so partial progress beacons survive validation.
  progress: z
    .object({
      phase: z.string().optional(),
      total: z.number().optional(),
      processed: z.number().optional(),
      percentComplete: z.number().optional(),
      message: z.string().optional(),
      // Source-agnostic coverage signal. "partial" means the source holds only
      // a truncated slice of upstream history (e.g. an interrupted one-shot
      // hand-off it can't re-request) while live sync stays healthy. See #579.
      // "unknown" is a distinct answer, not a synonym for "complete": a source
      // that has not established whether it is missing history has not said it
      // is whole, and a client that collapses the two shows a corpus as
      // complete on the strength of nobody having checked.
      coverage: z.enum(["complete", "partial", "unknown"]).optional(),
      detail: z.string().optional(),
    })
    .optional(),
  // The same coverage vocabulary, stated about the corpus rather than about
  // the page in flight. It rides beside `progress` and not inside it because
  // every terminal transition clears the progress meter, which would make a
  // claim visible only while the source is syncing and gone at the moment it
  // finishes — the moment it is actually true. Absent means the source has
  // never said; that is distinct from "unknown", which is it saying it cannot
  // tell.
  coverage: z.enum(["complete", "partial", "unknown"]).optional(),
  // The source's own wording for the claim above, durable for the same reason.
  coverageDetail: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  errorMessage: z.string().optional(),
  // What the operator has to do before the failure behind `errorMessage` can
  // clear, authored by the provider that recognised it. Sent only with an
  // `error` state whose cause will not clear on its own; absent everywhere
  // else. Persisted by the gateway beside the message so the affordance
  // survives its restart. A remedy that does not fit the shape costs only
  // itself: the status it rides on — the error state, the message — must
  // still land, whatever a newer collector has added to the remedy.
  remediation: syncRemediationSchema.optional().catch(undefined),
  issues: syncIssuesSchema.optional().catch(undefined),
  // Never treat an invalid partial assessment as an absent/full assessment.
  issueAssessments: syncIssueAssessmentsSchema.optional(),
  // A source's freshness declaration plus the collector's live reading of it,
  // for sources that read a local file some other program keeps current. Sent
  // only by sources that declared `SourceFreshness`; absent everywhere else.
  // The gateway pairs it with the persisted `last_document_at` to derive the
  // non-terminal `stale` warning — see `deriveDisplayStatus`.
  freshness: z
    .object({
      /** How long this source may go quiet before a stalled feed is likelier. */
      quietPeriodMs: z.number().int().positive(),
      /** Source-authored remediation sentence, rendered verbatim by clients. */
      hint: z.string(),
      /**
       * Whether that program was running at the last completed sync. Absent
       * means "not applicable or not determinable" — the gateway warns only on
       * an explicit `false`, so an un-probeable collector stays silent.
       */
      processRunning: z.boolean().optional(),
    })
    .optional(),
});

const authUpdateEvent = z
  .object({
    flowId: z.string().min(1),
    // The auth-subprocess emits `url`, `qr`, and ad-hoc info events; the
    // gateway forwards them by spreading. Type is forwarded as-is.
    type: z.string().optional(),
    url: z.string().optional(),
    data: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const authCompleteEvent = z.object({
  flowId: z.string().min(1),
  ok: z.boolean(),
  // `accountId` is the first resolved account (back-compat with single-account
  // consumers); `accountIds` carries the full set so a one-session →
  // many-institutions hosted-widget flow registers every selected account.
  accountId: z.string().optional(),
  accountIds: z.array(z.string().min(1)).min(1).optional(),
  // What the flow reported about each credential it established, keyed by
  // account id. Some platforms state a consent deadline once, during the
  // exchange, and never again.
  accountStates: z
    .record(z.string(), z.object({ status: z.string() }).passthrough())
    .optional()
    .catch(undefined),
  // What went wrong without stopping the connection. Declared, because this
  // object is strict and an undeclared field is stripped here; and caught,
  // because it rides on the terminal event and must not be able to invalidate
  // it — a notice that does not fit costs only itself.
  notices: z
    .array(z.object({ title: z.string().min(1).max(200), detail: z.string().max(2000).optional() }))
    .max(8)
    .optional()
    .catch(undefined),
  error: z.string().optional(),
  code: z.string().optional(),
  fileKey: z.string().optional(),
  providerName: z.string().optional(),
  // Declared, because this object is strict: a field the collector sends and
  // this schema does not name is stripped here and never reaches a client.
  remedy: z.string().optional(),
  // How long to wait before trying again, when the platform said.
  retryAfterMs: z
    .number()
    .int()
    .nonnegative()
    .max(7 * 24 * 3600_000)
    .optional(),
});

// History import (#588) device → gateway events, keyed by flowId.
const importProgressEvent = z.object({
  flowId: z.string().min(1),
  phase: z.string(),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
});
const importCompleteEvent = z.object({
  flowId: z.string().min(1),
  ok: z.boolean(),
  imported: z.number().int().nonnegative().optional(),
  merged: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

/**
 * The longest `device.update.result` detail the gateway accepts. A longer one
 * fails the event's schema and is dropped, leaving the device's row reading
 * `dispatched`, so every device caps what it sends with
 * `capDeviceUpdateDetail`.
 */
export const DEVICE_UPDATE_DETAIL_MAX_CHARS = 2_000;

/**
 * How a commanded self-update ended, reported by the device that ran it.
 *
 * `installed` means the new build is in place and the device is restarting
 * onto it: a collector exits for its service manager, an agent-harness plugin
 * restarts its harness. `restart-pending` means the build is in place but the
 * device could not start that restart itself — an agent-harness plugin that
 * found no harness executable, or whose restart command failed — so it names
 * the command the operator runs.
 */
const deviceUpdateResultFields = {
  state: z.enum(["installed", "restart-pending", "failed"]),
  /** One line for the operator: the failure, the restart under way, or the restart still owed. */
  detail: z.string().max(DEVICE_UPDATE_DETAIL_MAX_CHARS).optional(),
} as const;
export const deviceUpdateResultEvent = z.union([
  z.object({ version: productVersionSchema, ...deviceUpdateResultFields }).strict(),
  z.object({ commit: sourceCommitSchema, ...deviceUpdateResultFields }).strict(),
]);

const deviceDoctorResultEvent = z.union([
  z.object({ runId: doctorRunIdSchema, report: doctorReportSchema }).strict(),
  z
    .object({
      runId: doctorRunIdSchema,
      error: doctorTextSchema(2_000),
    })
    .strict(),
]);

// model.download.<kind> events: payload mirrors the ProgressBroadcast union
// from the gateway's model manager. Treat the kind as part of the type
// string and the rest as an open record so we don't have to mirror four
// near-identical schemas.
const modelDownloadStartedEvent = z
  .object({
    kind: z.literal("started"),
    downloadId: z.string(),
    modelId: z.string(),
    filename: z.string(),
  })
  .passthrough();
const modelDownloadProgressEvent = z
  .object({
    kind: z.literal("progress"),
    downloadId: z.string(),
    modelId: z.string(),
    progress: z.unknown(),
  })
  .passthrough();
const modelDownloadCompletedEvent = z
  .object({
    kind: z.literal("completed"),
    downloadId: z.string(),
    modelId: z.string(),
    manifest: z.unknown(),
  })
  .passthrough();
const modelDownloadFailedEvent = z
  .object({
    kind: z.literal("failed"),
    downloadId: z.string(),
    modelId: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .passthrough();
const modelDownloadCancelledEvent = z
  .object({
    kind: z.literal("cancelled"),
    downloadId: z.string(),
    modelId: z.string(),
  })
  .passthrough();

/**
 * Frozen registry of every event type. See module doc-comment for rationale.
 */
export const wsEventSchemas = {
  ping: pingEvent,
  "device.status": deviceStatusEvent,
  "documents.upserted": documentsUpsertedEvent,
  "push.available": pushAvailableEvent,
  "config.changed": configChangedEvent,
  "sync.status": syncStatusEvent,
  "auth.update": authUpdateEvent,
  "auth.complete": authCompleteEvent,
  "import.progress": importProgressEvent,
  "import.complete": importCompleteEvent,
  "device.update.result": deviceUpdateResultEvent,
  "device.doctor.result": deviceDoctorResultEvent,
  "model.download.started": modelDownloadStartedEvent,
  "model.download.progress": modelDownloadProgressEvent,
  "model.download.completed": modelDownloadCompletedEvent,
  "model.download.failed": modelDownloadFailedEvent,
  "model.download.cancelled": modelDownloadCancelledEvent,
  "agent.user.message": agentUserMessageEvent,
  "agent.message.start": agentMessageStartEvent,
  "agent.text.delta": agentTextDeltaEvent,
  "agent.thinking.delta": agentThinkingDeltaEvent,
  "agent.usage.update": agentUsageUpdateEvent,
  "agent.tool.input_start": agentToolInputStartEvent,
  "agent.tool.start": agentToolStartEvent,
  "agent.tool.result": agentToolResultEvent,
  "agent.tool.child.start": agentToolChildStartEvent,
  "agent.tool.child.result": agentToolChildResultEvent,
  "agent.citation": agentCitationEvent,
  "agent.citations.update": agentCitationsUpdateEvent,
  "agent.subagent.spawned": agentSubagentSpawnedEvent,
  "agent.subagent.event": agentSubagentEventEvent,
  "agent.subagent.result": agentSubagentResultEvent,
  "agent.deep_research.summary": agentDeepResearchSummaryEvent,
  "agent.message.end": agentMessageEndEvent,
  "agent.error": agentErrorEvent,
  "agent.resync": agentResyncEvent,
} as const;

export type WsEventRegistry = typeof wsEventSchemas;
export type WsEventType = keyof WsEventRegistry;
export type WsEventPayload<K extends WsEventType> = z.infer<WsEventRegistry[K]>;

// ─── Parsing helpers ────────────────────────────────────────────────────────

export function isKnownCommandType(type: string): type is WsCommandType {
  return Object.prototype.hasOwnProperty.call(wsCommandSchemas, type);
}

export function isKnownEventType(type: string): type is WsEventType {
  return Object.prototype.hasOwnProperty.call(wsEventSchemas, type);
}

/**
 * Parse the request payload of a command. Returns the typed value on success
 * or a structured error on shape mismatch — callers convert the error into
 * a `WsResponseErr` envelope ("invalid_payload" + first message).
 */
export function parseRequestPayload<K extends WsCommandType>(
  type: K,
  raw: unknown,
): { ok: true; value: WsRequestPayload<K> } | { ok: false; error: string } {
  const schema = wsCommandSchemas[type].request as z.ZodTypeAny;
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data as WsRequestPayload<K> };
  return { ok: false, error: formatZodError(r.error) };
}

/** Parse the response payload of a command we sent. */
export function parseResponsePayload<K extends WsCommandType>(
  type: K,
  raw: unknown,
): { ok: true; value: WsResponsePayload<K> } | { ok: false; error: string } {
  const schema = wsCommandSchemas[type].response as z.ZodTypeAny;
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data as WsResponsePayload<K> };
  return { ok: false, error: formatZodError(r.error) };
}

/** Parse a known event payload. Unknown event types return ok: false. */
export function parseEventPayload<K extends WsEventType>(
  type: K,
  raw: unknown,
): { ok: true; value: WsEventPayload<K> } | { ok: false; error: string } {
  const schema = wsEventSchemas[type] as z.ZodTypeAny;
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data as WsEventPayload<K> };
  return { ok: false, error: formatZodError(r.error) };
}

function formatZodError(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return "invalid payload";
  const path = first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

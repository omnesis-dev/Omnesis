// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Public subscription types.
 *
 * Compiled matching plans, candidate evidence, reviewer findings, and private
 * corpus identifiers deliberately do not appear in this package. They stay
 * behind the trusted gateway boundary.
 */

import type { PrivacyExternalAgentIdentity } from "./privacy.js";

/** Largest positive epoch-millisecond value accepted by JavaScript Date. */
export const MAX_SUBSCRIPTION_EXPIRY_MS = 8_640_000_000_000_000;

/**
 * The socket budget an integration must allow a subscription-management call.
 *
 * Here for the same reason the refusal codes are: more runtimes have to agree
 * on it than can import the gateway. Creating a subscription runs a full
 * agentic compile behind the request — the model reads the install's ontology,
 * searches the corpus, drafts, validates and repairs — and only then does the
 * gateway answer. That is minutes, not milliseconds, and an adapter carrying
 * the ordinary read budget times out on every create it ever makes while the
 * gateway goes on to succeed. What the agent sees is a feature that always
 * fails; what actually happened is a watch it now owns and does not know about.
 * Retrying that is how one intent becomes five watches.
 *
 * So it must exceed the gateway's compile deadline with room to spare, and the
 * gateway holds itself to that: `compile-port.test.ts` reddens if the default
 * deadline ever reaches this, and a longer deadline configured by an operator
 * is warned about at boot rather than discovered by an agent.
 */
export const SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS = 300_000;

/**
 * How a management call ended, when it did not end with an answer.
 *
 * Three outcomes, because they call for three different next actions and an
 * adapter that collapses them leaves the model to guess. A **timeout** is not a
 * failure: the gateway may still be finishing, so the only safe next step is to
 * list and look before retrying — retrying blind is what installs a second
 * watch for the same intent. A **refusal** is a decision, already made and
 * carrying its own reason, and retrying it is retrying a settled question. Only
 * **unreachable** is the case where trying again shortly is the right move.
 *
 * The codes travel; the sentences are each runtime's own, exactly as with the
 * refusal codes.
 */
export const MANAGEMENT_FAILURE_KINDS = [
  /** The socket budget elapsed. The gateway may still be working. */
  "timed_out",
  /** The gateway answered, declining. The reason is in the answer. */
  "refused",
  /** No answer reached us at all. */
  "unreachable",
] as const;

export type ManagementFailureKind = (typeof MANAGEMENT_FAILURE_KINDS)[number];

/**
 * Why a request to watch something was declined, as a closed set of codes.
 *
 * Here rather than beside the compiler because four runtimes have to agree on
 * it and only one of them can import the compiler: the gateway mints these,
 * the integration HTTP client classifies them, and two Python harness adapters
 * render them for an agent. This package has no dependencies, which is what
 * makes it the one place all four can reach.
 *
 * **The codes travel; the words do not.** Each consumer writes its own
 * sentence for a code, and that is deliberate — a refusal's free text is the
 * compiler's own words about a corpus it just read, so it is the operator's to
 * see and nobody else's. What must not drift is the *set*: a code minted here
 * and unknown there degrades to an unexplained rejection, which is how an agent
 * comes to retry a settled decision forever.
 *
 * Every code is true or false about the **request** alone. One that reported
 * what is or is not in the corpus — "no such person", "that source is
 * connected" — would turn a create endpoint into an oracle a caller could
 * query by submitting conditions until one came back, and the caller that
 * receives these holds only `subscriptions:manage`, so it has no other way to
 * learn it. Corpus reads use a separately authorized MCP principal credential.
 * Distinctions that would break that rule live in the on-machine reasons instead.
 */
export const MODEL_REFUSAL_CODES = [
  /** Expressible in principle, not on this install's substrate. */
  "unsupported_condition",
  /** Nothing in the request names something that happens. */
  "not_a_condition",
  /** More than one reasonable reading, and the asker has to pick. */
  "ambiguous_request",
] as const;

/**
 * Every code a refusal can carry, including the one only the host mints.
 *
 * `compiler_failed` is not a refusal anything chose — it is the compiler
 * failing to produce something legal after its repairs, and it means the
 * opposite of the others: try again. Offering it to a model would let a
 * deliberate refusal come back telling the caller to retry, and an agent that
 * retries a settled decision does so forever.
 */
export const REFUSAL_CODES = [...MODEL_REFUSAL_CODES, "compiler_failed"] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export const SUBSCRIPTION_STATUSES = [
  "pending_approval",
  "active",
  "paused",
  "denied",
  "revoked",
  "expired",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface SubscriptionCondition {
  kind: "natural-language";
  description: string;
}

/**
 * Delivery to an off-host agent integration: the firing wakes the paired
 * integration device's workflow with this instruction. The only reaction the
 * integration-facing HTTP surface accepts.
 */
export interface SubscriptionAgentWorkflowReaction {
  kind: "agent-workflow";
  instruction: string;
  /**
   * Referents the instruction names, resolved by whoever authored it: the
   * conversation to post in, the address to write to, the record to update.
   * Opaque here — a key means whatever the instruction says it means, and the
   * gateway transports them without interpreting them.
   *
   * They exist because an instruction is prose. "Reply in the originating
   * conversation" is knowledge its author had and the woken agent does not.
   */
  bindings?: Record<string, string>;
}

/**
 * Delivery to the operator's own phones: the firing fans out one APNs push
 * across every paired iOS device. Authored only by the gateway's own watch
 * port (the interactive agent's `watch_create`), never by an integration.
 * Title and body are the literal alert copy; absent fields use the defaults.
 */
export interface SubscriptionIosPushReaction {
  kind: "ios-push";
  title?: string;
  body?: string;
  /**
   * A human sentence describing what this reaction does, filled in by the
   * gateway on the way out. It exists because every paired client renders a
   * watch's reaction from this field, and the older ones require it — so a
   * push-delivered watch would otherwise fail to decode, or read as blank, on
   * a phone that has not been updated.
   *
   * Read-only: authoring surfaces never send it, and it is never stored.
   */
  readonly instruction?: string;
}

/**
 * What a firing does once the shared pipeline — compile, evaluate, judge,
 * settle — has decided the condition truly occurred. A closed union on purpose: the reaction is the ONLY place the two
 * watch-authoring paths diverge, and everything upstream of delivery treats
 * them identically.
 */
export type SubscriptionReaction = SubscriptionAgentWorkflowReaction | SubscriptionIosPushReaction;

export interface SubscriptionInterpretation {
  /** A short explanation of the event the gateway will watch for. */
  summary: string;
  /**
   * Firings disclose only that a matching event exists. Further corpus access
   * must pass through the workflow-bound answer privacy boundary.
   */
  pushDetail: "existence";
}

/**
 * How alive an analytics table's data is, at the coarsest resolution that still
 * answers "could a watch over this table ever fire?".
 */
export const WATCH_TARGET_LIVENESS = ["empty", "dormant", "active"] as const;

export type WatchTargetLiveness = (typeof WATCH_TARGET_LIVENESS)[number];

/**
 * What live data said about a compiled watch when it was compiled.
 *
 * Every field is a count, an instant, or a bounded class — never a value read
 * out of the corpus. It exists so a watch pointed at data that cannot satisfy
 * it is visible while the subscription is still an unapproved proposal, rather
 * than looking like a healthy watch that has simply not fired yet.
 *
 * A "matching row" is a row the watch's filters select, not a row that
 * satisfies its final boolean condition.
 */
export interface SubscriptionWatchGrounding {
  /** The condition is already true, so the watch fires on its first evaluation. */
  matchesNow: boolean;
  /** Matching rows across all history. Zero means the watch can never fire. */
  matchCount: number;
  /** Matching rows inside the horizon; null when the watch has no temporal column. */
  recentMatchCount: number | null;
  /** Newest matching row's instant, in epoch milliseconds; null when undatable or absent. */
  latestMatchAt: number | null;
  liveness: WatchTargetLiveness;
  /**
   * Horizon `recentMatchCount` is measured over, in milliseconds.
   *
   * Derived from the table's own arrival cadence, so it tracks what "recent"
   * means for that table rather than one global window. A table with too little
   * history to have a cadence gets the widest bound here while its liveness
   * falls back to the narrowest, so on those tables the two fields are answering
   * questions of different widths and should not be read as one statement.
   */
  horizonMs: number;
}

export interface SubscriptionSummary {
  id: string;
  status: SubscriptionStatus;
  revision: number;
  revisionId: string;
  condition: SubscriptionCondition;
  reaction: SubscriptionReaction;
  interpretation: SubscriptionInterpretation;
  interpretedCondition: SubscriptionInterpretation;
  workflowId: string;
  workflowHandle: string;
  integration: PrivacyExternalAgentIdentity;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  firingCount: number;
  lastFiredAt: number | null;
}

export interface SubscriptionDetail extends SubscriptionSummary {
  approval: SubscriptionApprovalSummary | null;
  categories: string[];
  policyRevision: string;
  /** Trusted display metadata; never contains a token or secret. */
  integrationDevice: { id: string; name: string; kind: string };
  workflow: { id: string; name: string; purpose: string };
}

/**
 * What one hard delete removed. Only a terminal (revoked or expired)
 * subscription can be purged; the counts confirm the constellation is gone.
 */
export interface SubscriptionPurgeSummary {
  subscriptionId: string;
  /** Terminal status the subscription held when it was purged. */
  status: "revoked" | "expired";
  revisionsDeleted: number;
  firingsDeleted: number;
  /** Firing-bound answer-authority bearer tokens deleted from the token store. */
  answerTokensDeleted: number;
  /** Answer workflows deleted because nothing referenced them any more. */
  workflowsDeleted: number;
}

export interface SubscriptionApprovalSummary {
  id: string;
  subscriptionId: string;
  revision: number;
  revisionId: string;
  workflowHandle: string;
  integration: PrivacyExternalAgentIdentity;
  interpretedCondition: SubscriptionInterpretation;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

/** Trusted approval detail. It still omits the private compiled plan. */
export interface SubscriptionApprovalDetail extends SubscriptionApprovalSummary {
  condition: SubscriptionCondition;
  reaction: SubscriptionReaction;
  interpretation: SubscriptionInterpretation;
  workflowId: string;
  integrationDeviceId: string;
  categories: string[];
  policyRevision: string;
  integrationDevice: { id: string; name: string; kind: string };
  workflow: { id: string; name: string; purpose: string };
  /** Null when the compiled plan watches documents, or when nothing was measured. */
  grounding: SubscriptionWatchGrounding | null;
}

export interface SubscriptionFiringSummary {
  id: string;
  subscriptionId: string;
  revision: number;
  workflowId: string;
  revisionId: string;
  workflowHandle: string;
  status: "pending" | "delivered" | "blocked" | "failed";
  firedAt: number;
  createdAt: number;
  deliveryStatus: "pending" | "delivered" | "blocked" | "failed";
  acceptedAt: number | null;
  /**
   * Where this firing lives in the watch runtime that produced it: the watch it
   * belongs to, and the journal event it happened on.
   *
   * A wake and an installed watch's firing are the same event seen from two
   * sides, and the debug canvas addresses a moment by `(watch, seq)`. Both
   * fields are present together or absent together — a sequence with no watch
   * addresses nothing. Absent for a record whose plan is not a watch's, and for
   * a firing written before the runtime stamped its identity this way.
   */
  watchId?: string;
  seq?: number;
}

export interface CreateSubscriptionRequest {
  condition: SubscriptionCondition;
  reaction: SubscriptionReaction;
  /** Reuse a workflow minted by an earlier subscription request. */
  workflowId?: string;
  /** Required for safe retry of a create call. */
  idempotencyKey: string;
  expiresAt?: number;
}

export interface UpdateSubscriptionRequest {
  /** Revision observed by the caller; stale updates are rejected instead of overwriting changes. */
  expectedRevision: number;
  condition?: SubscriptionCondition;
  reaction?: SubscriptionReaction;
  expiresAt?: number | null;
  status?: "active" | "paused";
}

export interface ResolveSubscriptionApprovalRequest {
  decision: "approve" | "deny";
}

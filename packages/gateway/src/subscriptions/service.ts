// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import {
  MAX_SUBSCRIPTION_EXPIRY_MS,
  type CreateSubscriptionRequest,
  type SubscriptionApprovalDetail,
  type SubscriptionApprovalSummary,
  type SubscriptionDetail,
  type SubscriptionFiringSummary,
  type SubscriptionPurgeSummary,
  type SubscriptionSummary,
  type UpdateSubscriptionRequest,
  type SubscriptionInterpretation,
  type SubscriptionWatchGrounding,
} from "@omnesis/types";
import { createLogger, tryDeviceId } from "@omnesis/core";
import { getDevice } from "../data/repositories/DeviceRepository.js";
import { loadWorkflowCumulativeDisclosure } from "../privacy/store.js";
import { reviewedPolicyFamily } from "../privacy/reviewer.js";
import { isWatchV2Plan, WATCH_V2_PLAN_KIND } from "./watch-v2-plan.js";
import {
  watchV2ConditionSummary,
  type WatchV2Author,
  type WatchV2EvidenceKind,
  type WatchV2Plan,
} from "./watch-v2-plan.js";
import {
  DEFAULT_SUBSCRIPTION_EVALUATION_LIMIT,
  getSubscriptionApproval,
  getSubscriptionById,
  getSubscriptionCompiledPlan,
  getSubscriptionFiring,
  getSubscriptionForDevice,
  getSubscriptionForRequest,
  listAllSubscriptions,
  listPendingOperatorWatchApprovalIds,
  listSubscriptionApprovalPage,
  listSubscriptionApprovals,
  listSubscriptionFirings,
  listSubscriptionsForDevice,
  subscriptionOwnerId,
  SubscriptionCursorError,
  type TrustedSubscriptionDetail,
  type TrustedSubscriptionFiringDetail,
  type SubscriptionApprovalPage,
  validateSubscriptionFiringAnswerAuthority,
} from "./store-queries.js";
import {
  parseStoredSubscriptionJson,
  storedSubscriptionCompiledPlanCodec,
  type SubscriptionCompiledPlan,
  subscriptionReactionWorkflowPurpose,
} from "./store-codecs.js";
import type { WatchExistenceReviewer } from "../privacy/watch-existence-review.js";
import type { WriteGate } from "../write-gate.js";
import type { Db } from "../data/types.js";
import type {
  SubscriptionApprovalResolvedBy,
  SubscriptionFiringAnswerAuthority,
  WorkflowOutcomeStatus,
} from "./store-types.js";
import type { PrivacyCumulativeDisclosure, PrivacyPolicyDocument } from "@omnesis/types/privacy";

const log = createLogger("gateway:subscriptions");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIFETIME_MS = 365 * DAY_MS;
const APPROVAL_LIFETIME_MS = 7 * DAY_MS;

/**
 * The compiler that produced a Watch V2 anchor's plan: none. The descriptor is
 * assembled from the watch's own definition, so recording a model version here
 * would name something that never ran.
 */
const WATCH_V2_ANCHOR_COMPILER_VERSION = "watch-v2-descriptor";

/**
 * Ceiling on the activation retry backoff. An activation fails because a
 * dependency is unavailable, and those outages are minutes-long, so retrying
 * more often than this only spends the outage re-erroring.
 */
const OPERATOR_ACTIVATION_MAX_BACKOFF_MS = 60_000;

export type SubscriptionServiceErrorCode =
  | "not_found"
  | "idempotency_conflict"
  | "workflow_unavailable"
  | "terminal"
  | "not_terminal"
  | "grant_unavailable"
  | "approval_resolved"
  | "approval_expired"
  | "stale_revision"
  | "policy_changed"
  | "semantic_unavailable"
  | "watch_unavailable"
  | "answer_authority_unavailable"
  | "outcome_authority_unavailable"
  | "invalid_update"
  | "invalid_cursor";

export class SubscriptionServiceError extends Error {
  override readonly name = "SubscriptionServiceError";

  constructor(
    readonly code: SubscriptionServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SubscriptionServiceDeps {
  db: Db;
  writeGate: WriteGate;
  /**
   * The shared authoring seam. The interactive agent's watch port compiles
   * through the same instance, so a subscription and an operator-authored
   * watch are held to one grammar, one catalog validation, and one drift rule.
   */
  policyStore: {
    readonly path?: string;
    get(): Promise<PrivacyPolicyDocument>;
    runIfRevision?<T>(expectedRevision: string, operation: () => Promise<T>): Promise<T | null>;
  };
  reviewWatchExistence?: WatchExistenceReviewer;
  now?: () => number;
  id?: () => string;
}

export interface SubscriptionApprovalResolver {
  deviceId: string | null;
  tokenId: string | null;
}

export interface SubscriptionCaller {
  deviceId: string;
  tokenId: string | null;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertValidExpiry(expiresAt: number, now: number): void {
  if (!Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > MAX_SUBSCRIPTION_EXPIRY_MS) {
    throw new SubscriptionServiceError(
      "invalid_update",
      "Watch expiry must be a valid future date.",
    );
  }
}

function mapWriteOutcome(outcome: string): never {
  switch (outcome) {
    case "not_found":
      throw new SubscriptionServiceError("not_found", "Watch not found.");
    case "idempotency_conflict":
      throw new SubscriptionServiceError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request.",
      );
    case "workflow_unavailable":
      throw new SubscriptionServiceError(
        "workflow_unavailable",
        "The requested workflow is unavailable.",
      );
    case "terminal":
      throw new SubscriptionServiceError("terminal", "This Watch can no longer change.");
    case "grant_unavailable":
      throw new SubscriptionServiceError(
        "grant_unavailable",
        "The Watch must be approved again before it can resume.",
      );
    case "already_resolved":
      throw new SubscriptionServiceError("approval_resolved", "Approval already resolved.");
    case "expired":
      throw new SubscriptionServiceError("approval_expired", "Approval expired.");
    case "stale_revision":
      throw new SubscriptionServiceError("stale_revision", "Watch has changed since it was read.");
    case "policy_changed":
    case "disclosure_changed":
      throw new SubscriptionServiceError(
        "policy_changed",
        "The privacy policy changed; request a fresh approval.",
      );
    case "semantic_unavailable":
      throw new SubscriptionServiceError(
        "semantic_unavailable",
        "The semantic prefilter is unavailable. Try approving the Watch again shortly.",
      );
    case "watch_unavailable":
      throw new SubscriptionServiceError(
        "watch_unavailable",
        "The analytics dependencies for this Watch changed or are unavailable. Revise the Watch and approve it again.",
      );
    default:
      throw new Error(`unknown subscription write outcome: ${outcome}`);
  }
}

/**
 * The compiled half of a record, supplied by whoever asked for it.
 *
 * Not produced here. A record's condition is a Watch V2 definition, authored
 * and validated by the engine that will evaluate it, so this service stores
 * what it is handed rather than running a language model over prose a second
 * time and inventing a worse description of something already exact.
 */
export interface SubscriptionCompiledInput {
  plan: SubscriptionCompiledPlan;
  interpretation: SubscriptionInterpretation;
  compilerVersion: string;
  privacyCategories: string[];
  grounding?: SubscriptionWatchGrounding;
  compileRunId?: string;
}

export class SubscriptionService {
  private readonly now: () => number;
  private readonly id: () => string;
  /** Policy revision last evaluated against every compatible pending watch. */
  private watchPolicyRevision: string | null = null;
  private watchPolicyReviewInFlight: Promise<number> | null = null;
  /** Per-approval activation backoff, keyed by approval id. */
  private readonly operatorActivationRetryAt = new Map<string, number>();
  private readonly operatorActivationAttempts = new Map<string, number>();

  constructor(private readonly deps: SubscriptionServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
  }

  /**
   * Activation is the fail-closed boundary: a record may only be enabled if
   * something will actually evaluate it.
   *
   * One engine runs on this gateway, so that reduces to one question. A record
   * written by the retired evaluator still lists and still revokes — its plan
   * decodes — but approving it would produce a watch that is `active` and can
   * never fire, which is the exact silence this layer exists to prevent. Asking
   * again recompiles the condition on the engine that is here.
   */
  private ensureActivationReady(subscriptionId: string, revision: number): void {
    const plan = getSubscriptionCompiledPlan(this.deps.db, subscriptionId, revision);
    if (plan && isWatchV2Plan(plan)) return;
    throw new SubscriptionServiceError(
      "watch_unavailable",
      "This Watch was written for an engine this gateway no longer runs. Ask for it again and it will be recompiled.",
    );
  }

  /**
   * Recheck and audit the exact short-lived token-to-firing authority before
   * any private evidence can cross the Answer boundary. Owner and workflow
   * are returned from the approved immutable subscription state, never from
   * request input.
   */
  async authorizeFiringAnswer(caller: SubscriptionCaller, firingId: string) {
    if (!caller.tokenId) {
      throw new SubscriptionServiceError(
        "answer_authority_unavailable",
        "This firing answer authority is unavailable.",
      );
    }
    const policy = await this.deps.policyStore.get();
    const result = await this.deps.writeGate.useSubscriptionFiringAnswerAuthority({
      tokenId: caller.tokenId,
      firingId,
      policyRevision: policy.revision,
      usedAt: this.now(),
      consume: false,
    });
    if (result.outcome !== "authorized") {
      throw new SubscriptionServiceError(
        "answer_authority_unavailable",
        "This firing answer authority is unavailable.",
      );
    }
    return result.authority;
  }

  /**
   * Record what a woken run did.
   *
   * Nothing about the subscription's disclosure state is consulted: this
   * carries no corpus content outward, and a run whose policy moved under it
   * still has something worth saying. The authority binds the report to one
   * firing, which is the only thing that has to be true.
   */
  async recordFiringOutcome(
    caller: SubscriptionCaller,
    input: { firingId: string; status: WorkflowOutcomeStatus; report?: string },
  ): Promise<{ runs: number }> {
    if (!caller.tokenId) {
      throw new SubscriptionServiceError(
        "outcome_authority_unavailable",
        "This firing outcome authority is unavailable.",
      );
    }
    const result = await this.deps.writeGate.recordSubscriptionFiringOutcome({
      tokenId: caller.tokenId,
      firingId: input.firingId,
      status: input.status,
      ...(input.report === undefined ? {} : { report: input.report }),
      reportedAt: this.now(),
    });
    if (result.outcome !== "recorded") {
      throw new SubscriptionServiceError(
        "outcome_authority_unavailable",
        "This firing outcome authority is unavailable.",
      );
    }
    return { runs: result.runs };
  }

  async finalizeFiringAnswerEgress(
    caller: SubscriptionCaller,
    input: { firingId: string; taskId: string; ownerId: string },
  ) {
    if (!caller.tokenId) {
      throw new SubscriptionServiceError(
        "answer_authority_unavailable",
        "This firing answer authority is unavailable.",
      );
    }
    const policy = await this.deps.policyStore.get();
    const liveAuthority = validateSubscriptionFiringAnswerAuthority(this.deps.db, {
      tokenId: caller.tokenId,
      firingId: input.firingId,
      policyRevision: policy.revision,
      now: this.now(),
    });
    if (liveAuthority.outcome !== "authorized") {
      throw new SubscriptionServiceError(
        "answer_authority_unavailable",
        "This firing answer authority is unavailable.",
      );
    }
    const result = await this.deps.writeGate.finalizeSubscriptionFiringAnswerEgress({
      tokenId: caller.tokenId,
      firingId: input.firingId,
      policyRevision: policy.revision,
      taskId: input.taskId,
      ownerId: input.ownerId,
      egressId: `egress_${this.id()}`,
      recordedAt: this.now(),
    });
    if (result.outcome !== "recorded") {
      throw new SubscriptionServiceError(
        "answer_authority_unavailable",
        "This firing answer authority or released task scope is unavailable.",
      );
    }
    return result.egress;
  }

  async create(
    caller: SubscriptionCaller,
    request: CreateSubscriptionRequest,
    /**
     * A plan the caller already has, for a record whose condition was not
     * written in prose and has nothing to compile. A Watch V2 anchor is the
     * only such caller: its condition was authored as a DSL watch and is
     * evaluated by the V2 runtime, so running it past a language model here
     * would invent a second, worse description of something already exact.
     */
    compiled: SubscriptionCompiledInput,
  ): Promise<SubscriptionDetail> {
    if (request.reaction.kind !== "agent-workflow") {
      // A record exists so a wake can be approved, held to a grant and
      // ledgered. A watch that pushes to the operator's own phones crosses no
      // boundary and mints none — it delivers straight from the firing — so a
      // record asking for one is a record with nothing to approve.
      throw new SubscriptionServiceError(
        "invalid_update",
        "A subscription record is for waking an agent.",
      );
    }
    const now = this.now();
    const expiresAt = request.expiresAt ?? now + DEFAULT_LIFETIME_MS;
    assertValidExpiry(expiresAt, now);
    const requestFingerprint = fingerprint({
      condition: request.condition,
      reaction: request.reaction,
      workflowId: request.workflowId ?? null,
      expiresAt: request.expiresAt ?? null,
    });
    const existing = getSubscriptionForRequest(
      this.deps.db,
      subscriptionOwnerId(caller.deviceId),
      request.idempotencyKey,
      caller.deviceId,
      now,
    );
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new SubscriptionServiceError(
          "idempotency_conflict",
          "The idempotency key was already used for a different request.",
        );
      }
      return existing.subscription;
    }
    const policy = await this.deps.policyStore.get();
    const subscriptionId = `sub_${this.id()}`;
    const workflowId = request.workflowId ?? `wf_${this.id()}`;
    const result = await this.deps.writeGate.createSubscription({
      id: subscriptionId,
      approvalId: `sapp_${this.id()}`,
      workflowId,
      integrationDeviceId: caller.deviceId,
      ownerId: subscriptionOwnerId(caller.deviceId),
      clientRequestId: request.idempotencyKey,
      requestFingerprint,
      condition: request.condition,
      reaction: request.reaction,
      interpretation: compiled.interpretation,
      ...(compiled.grounding ? { grounding: compiled.grounding } : {}),
      ...(compiled.compileRunId !== undefined ? { compileRunId: compiled.compileRunId } : {}),
      compiledPlan: compiled.plan,
      compilerVersion: compiled.compilerVersion,
      privacyCategories: compiled.privacyCategories,
      policyRevision: policy.revision,
      createdAt: now,
      expiresAt,
      approvalExpiresAt: Math.min(expiresAt, now + APPROVAL_LIFETIME_MS),
      workflowName: "Watch workflow",
      workflowPurpose: subscriptionReactionWorkflowPurpose(request.reaction),
      createWorkflow: request.workflowId === undefined,
      workflowExpiresAt: expiresAt,
    });
    if (result.outcome === "replayed") return result.subscription;
    if (result.outcome === "created") {
      return this.applyWatchPrivacyPolicy(caller, result.subscription, policy);
    }
    return mapWriteOutcome(result.outcome);
  }

  /** Apply the ordinary privacy policy to this watch's existence disclosure. */
  private async applyWatchPrivacyPolicy(
    caller: SubscriptionCaller,
    subscription: SubscriptionDetail,
    policy: PrivacyPolicyDocument,
  ): Promise<SubscriptionDetail> {
    const approvalId = subscription.approval?.id;
    if (!approvalId) return subscription;
    if (!this.supportsPolicyDrivenWatches(subscription.integrationDevice.id)) {
      // A rolling plugin refresh updates this capability in place. Keep the
      // worklist eligible for another cheap scan so an already-pending watch
      // is reviewed as soon as the new hello lands, without a policy edit.
      this.watchPolicyRevision = null;
      return subscription;
    }
    const reviewer = this.deps.reviewWatchExistence;
    if (!reviewer) return subscription;
    const cumulativeDisclosure = loadWorkflowCumulativeDisclosure(
      this.deps.db,
      subscription.workflowId,
    );
    let result: Awaited<ReturnType<WatchExistenceReviewer>>;
    try {
      result = await reviewer({
        condition: subscription.condition,
        interpretation: subscription.interpretation,
        categories: subscription.categories,
        expiresAt: subscription.expiresAt,
        policy: policy.policy,
        policyRevision: policy.revision,
        ...(reviewedPolicyFamily(policy) ? { policyFamily: reviewedPolicyFamily(policy) } : {}),
        workflowPurpose: subscription.workflow.purpose,
        cumulativeDisclosure,
      });
    } catch (error) {
      log.warn(
        `privacy reviewer failed for ${subscription.id}; approval stays pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return subscription;
    }
    const reviewedAt = this.now();
    if (result.decision === "allow") {
      try {
        await this.ensureActivationReady(subscription.id, subscription.revision);
      } catch (error) {
        log.warn(
          `privacy policy could not activate ${subscription.id}; approval stays pending: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return subscription;
      }
    }
    const reviewMutation = {
      subscriptionId: subscription.id,
      approvalId,
      revision: subscription.revision,
      policyRevision: policy.revision,
      expectedAnswerDisclosureRevision: cumulativeDisclosure.revision,
      expectedExistenceDisclosureRevision: cumulativeDisclosure.existenceRevision,
      ...(this.deps.policyStore.path
        ? {
            policyGuard: {
              path: this.deps.policyStore.path,
              expectedRevision: policy.revision,
            },
          }
        : {}),
      review: result.review.review,
      reviewedAt,
    };
    const recordReview = () =>
      result.decision === "ask"
        ? this.deps.writeGate.recordSubscriptionPrivacyReview({
            ...reviewMutation,
            decision: "ask",
          })
        : this.deps.writeGate.recordSubscriptionPrivacyReview({
            ...reviewMutation,
            decision: result.decision,
            grantId: `sgrant_${this.id()}`,
            grantExpiresAt: Math.min(
              subscription.expiresAt ?? reviewedAt + DEFAULT_LIFETIME_MS,
              reviewedAt + DEFAULT_LIFETIME_MS,
            ),
            resolvedAt: reviewedAt,
          });
    const recorded = this.deps.policyStore.runIfRevision
      ? await this.deps.policyStore.runIfRevision(policy.revision, recordReview)
      : await recordReview();
    if (recorded === null) {
      log.warn(`${subscription.id} privacy review became stale before it could be recorded`);
      return subscription;
    }
    if (recorded.outcome === "recorded") return subscription;
    if (recorded.outcome === "resolved") {
      log.info(
        `${subscription.id} ${result.decision === "allow" ? "activated" : "denied"} by privacy policy`,
      );
      return this.get(caller, subscription.id);
    }
    if (recorded.outcome === "terminal") {
      // Not a failure, and not pending either: the subscription left the
      // pending-approval state before this review could record itself. Usually
      // that is a policy that auto-approves — the grants resolve while the
      // review that would have asked about them is still running, and both are
      // right — but a subscription denied, revoked or expired mid-review lands
      // here too, and none of them is an approval left hanging. Saying so
      // reported the opposite of what happened on a subscription the operator
      // then found settled.
      log.info(`${subscription.id} left pending approval before its privacy review recorded`);
      return this.get(caller, subscription.id);
    }
    log.warn(
      `privacy policy could not resolve ${subscription.id}; approval stays pending: ${recorded.outcome}`,
    );
    return subscription;
  }

  /** Re-evaluate the pending worklist once for each privacy-policy revision. */
  async reevaluatePendingWatchPolicies(): Promise<number> {
    if (this.watchPolicyReviewInFlight) return this.watchPolicyReviewInFlight;
    const run = this.reevaluatePendingWatchPoliciesOnce();
    this.watchPolicyReviewInFlight = run;
    try {
      return await run;
    } finally {
      if (this.watchPolicyReviewInFlight === run) this.watchPolicyReviewInFlight = null;
    }
  }

  private async reevaluatePendingWatchPoliciesOnce(): Promise<number> {
    const policy = await this.deps.policyStore.get();
    if (policy.revision === this.watchPolicyRevision) return 0;
    let resolved = 0;
    let waitingForCompatiblePlugin = false;
    for (const summary of listSubscriptionApprovals(this.deps.db, "pending", this.now())) {
      const approval = getSubscriptionApproval(this.deps.db, summary.id, this.now());
      if (!approval || approval.reaction.kind !== "agent-workflow") continue;
      const reviewedPolicy = this.deps.db
        .prepare<[string], { policy_revision: string | null }>(
          `SELECT json_extract(privacy_review_json, '$.policyRevision') AS policy_revision
             FROM subscription_approvals WHERE id = ?`,
        )
        .get(approval.id)?.policy_revision;
      if (reviewedPolicy === policy.revision) continue;
      if (!this.supportsPolicyDrivenWatches(approval.integrationDeviceId)) {
        waitingForCompatiblePlugin = true;
        continue;
      }
      const caller = { deviceId: approval.integrationDeviceId, tokenId: null };
      const subscription = this.get(caller, approval.subscriptionId);
      const decided = await this.applyWatchPrivacyPolicy(caller, subscription, policy);
      if (decided.status !== "pending_approval") resolved += 1;
    }
    this.watchPolicyRevision = waitingForCompatiblePlugin ? null : policy.revision;
    if (resolved > 0) log.info(`privacy policy resolved ${resolved} pending watch(es)`);
    return resolved;
  }

  private supportsPolicyDrivenWatches(deviceId: string): boolean {
    const id = tryDeviceId(deviceId);
    if (!id) return false;
    const device = getDevice(this.deps.db, id);
    return (
      device?.kind === "agent" &&
      device.capabilities.agentIntegration?.watchPrivacyPolicyVersion === 1
    );
  }

  /**
   * Mint the record a Watch V2 watch needs in order to wake an agent.
   *
   * Everything that makes a wake safe already exists here — a device to anchor
   * capabilities on, an approval and a grant, an answer authority, a privacy
   * reviewer and an egress ledger. A V2 watch keeps a record among them rather
   * than growing a second copy, so a firing it produces travels the same
   * reviewed path an integration's own subscription does.
   *
   * Three things make this different from every other subscription here:
   *
   * - **Nothing is compiled.** The condition was authored as a DSL watch and
   *   is evaluated by the V2 runtime. The plan supplied is a descriptor naming
   *   that watch, not a program, and no trigger is armed for it.
   * - **The approval is the operator's own act.** The DSL delivery block *is*
   *   the grant: a person wrote which agent to wake and what to tell it. The
   *   self-approval below is bookkeeping for that decision, the same authority
   *   an operator watch is created under.
   * - **It is anchored on the harness's device**, not the internal one, because
   *   a wake is claimed and delivered over that device's own connection.
   */
  async createWatchV2Anchor(input: {
    integrationDeviceId: string;
    watchId: string;
    watchName: string;
    /** The request the watch was written from — the whole answerable payload
     *  of a condition-only firing, so it is the operator's sentence or none. */
    request: string | undefined;
    instruction: string;
    /** Referents the instruction names, as the watch's author resolved them. */
    bindings?: Record<string, string>;
    evidence: WatchV2EvidenceKind;
    /** Keyed on the wake's shape, so re-installing an unchanged watch converges
     *  on the record it already has and a changed one mints a fresh record. */
    idempotencyKey: string;
    /**
     * Who asked for the watch. Defaults to the operator, which is the case
     * that self-approves: the person who wrote the delivery block named the
     * agent and the instruction, and the approval is bookkeeping for a
     * decision they already made. An integration's own request is not that —
     * nobody has agreed to it yet — so it is left waiting like any other.
     */
    authoredBy?: WatchV2Author;
    /**
     * The cognition run that compiled the watch this record is the front of.
     * Absent when the watch was installed from a hand-written DSL document,
     * and on an install that is not recording compiles.
     */
    compileRunId?: string;
  }): Promise<TrustedSubscriptionDetail> {
    const summary = watchV2ConditionSummary(input.watchName, input.request);
    const authoredBy = input.authoredBy ?? "operator";
    const plan: WatchV2Plan = {
      version: 5,
      predicate: {
        kind: WATCH_V2_PLAN_KIND,
        watchId: input.watchId,
        watchName: input.watchName,
        evidence: input.evidence,
        authoredBy,
      },
    };
    const detail = await this.create(
      { deviceId: input.integrationDeviceId, tokenId: null },
      {
        condition: { kind: "natural-language", description: summary },
        reaction: {
          kind: "agent-workflow",
          instruction: input.instruction,
          // Absent rather than empty when nothing was bound: the request
          // fingerprint covers the reaction, so an empty map would make an
          // anchor minted before bindings existed look like a different request.
          ...(input.bindings && Object.keys(input.bindings).length > 0
            ? { bindings: input.bindings }
            : {}),
        },
        idempotencyKey: input.idempotencyKey,
      },
      {
        plan,
        interpretation: { summary, pushDetail: "existence" },
        compilerVersion: WATCH_V2_ANCHOR_COMPILER_VERSION,
        privacyCategories: [],
        ...(input.compileRunId === undefined ? {} : { compileRunId: input.compileRunId }),
      },
    );
    if (authoredBy === "operator") {
      await this.activateOperatorWatch(detail.id, detail.approval?.id);
    }
    return this.getTrusted(detail.id);
  }

  /**
   * Report a Watch V2 firing into its anchor.
   *
   * The whole of the join: from here the existing drain claims it, sends the
   * wake, mints the answer authority scoped to this one firing, and answers
   * the agent's questions through the reviewer. Nothing about the path differs
   * from an integration's own subscription, which is the point — a firing that
   * travelled a private route would be a firing nobody reviewed.
   *
   * A repeat is discarded by the anchor's own uniqueness on
   * `(subscription, revision, eventKey)`, so a replayed firing wakes nobody a
   * second time without this needing a guard of its own.
   */
  async fireWatchV2Anchor(input: {
    subscriptionId: string;
    revision: number;
    eventKey: string;
    evidenceDocumentIds: readonly string[];
    observation?: Record<string, unknown>;
    firedAt: number;
  }): Promise<{ fired: boolean }> {
    const policy = await this.deps.policyStore.get();
    const result = await this.deps.writeGate.fireSubscription({
      firingId: `sf_${this.id()}`,
      subscriptionId: input.subscriptionId,
      revision: input.revision,
      indexEventKey: input.eventKey,
      evidenceDocumentIds: [...input.evidenceDocumentIds],
      ...(input.observation ? { observation: input.observation } : {}),
      policyRevision: policy.revision,
      firedAt: input.firedAt,
    });
    if (result.outcome === "fired") return { fired: true };
    if (result.outcome === "duplicate") return { fired: false };
    // Every other outcome is the anchor no longer being able to carry a wake —
    // revoked, expired, its grant withdrawn. Said out loud rather than returned
    // as a bare false, because a watch that goes on firing into a dead anchor
    // looks exactly like a watch nobody is listening to.
    log.warn(`watch anchor ${input.subscriptionId} could not take a firing: ${result.outcome}`);
    return { fired: false };
  }

  /**
   * Resolve an operator watch's pending approval on the operator's own
   * authority. Failure is not fatal: the watch stays `pending_approval` and
   * the drain-time re-approval pass converges it.
   */
  private async activateOperatorWatch(
    subscriptionId: string,
    approvalId: string | undefined,
  ): Promise<void> {
    if (!approvalId) return;
    try {
      await this.resolve({ kind: "operator" }, approvalId, "approve");
    } catch (error) {
      log.warn(
        `operator watch ${subscriptionId} could not activate yet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Activate every operator watch left waiting. Integration subscriptions wait
   * for a privacy decision; an operator watch waits for
   * nothing — its authority is the request that created it — so a pending
   * approval here is an activation that failed transiently (the embedder or an
   * analytics dependency was down at create/update) and this converges it.
   *
   * Called from the delivery drain, so the worklist is a single indexed query
   * and each watch carries its own backoff: a dependency that is down stays
   * down for minutes, and retrying it seconds apart would spend the outage
   * re-erroring rather than waiting it out.
   */
  async reapplyOperatorApprovals(): Promise<number> {
    const now = this.now();
    let activated = 0;
    for (const pending of listPendingOperatorWatchApprovalIds(this.deps.db, now)) {
      const retryAt = this.operatorActivationRetryAt.get(pending.id);
      if (retryAt !== undefined && retryAt > now) continue;
      try {
        await this.resolve({ kind: "operator" }, pending.id, "approve");
        this.operatorActivationRetryAt.delete(pending.id);
        activated += 1;
      } catch (error) {
        const attempts = (this.operatorActivationAttempts.get(pending.id) ?? 0) + 1;
        this.operatorActivationAttempts.set(pending.id, attempts);
        this.operatorActivationRetryAt.set(
          pending.id,
          now + Math.min(OPERATOR_ACTIVATION_MAX_BACKOFF_MS, 2 ** attempts * 1_000),
        );
        // Loud on the first failure, then quiet while the backoff rides it
        // out: a watch stuck for days must not fill the log with one line per
        // drain, and a watch stuck at all must not be invisible.
        if (attempts === 1) {
          log.warn(
            `operator watch ${pending.subscriptionId} could not activate; retrying with backoff: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    if (activated > 0) {
      log.info(`activated ${activated} operator watch(es)`);
    }
    this.reportStrandedOperatorWatches(now);
    return activated;
  }

  /**
   * Report operator watches whose approval expired before activation ever
   * succeeded. The healer's worklist is bounded by approval expiry, so such a
   * watch silently drops off it — and the operator was told in conversation
   * that it would start watching. An expired one is the one moment this is
   * worth an error line, so the failure is discoverable rather than a watch
   * that simply never fires.
   */
  private reportStrandedOperatorWatches(now: number): void {
    if (this.operatorActivationAttempts.size === 0) return;
    const live = new Set(
      listPendingOperatorWatchApprovalIds(this.deps.db, now).map((pending) => pending.id),
    );
    for (const approvalId of [...this.operatorActivationAttempts.keys()]) {
      if (live.has(approvalId)) continue;
      this.operatorActivationAttempts.delete(approvalId);
      this.operatorActivationRetryAt.delete(approvalId);
      const approval = getSubscriptionApproval(this.deps.db, approvalId, now);
      if (approval?.status === "pending" || approval?.status === "approved") continue;
      log.error(
        `operator watch ${approval?.subscriptionId ?? approvalId} never activated before its approval lapsed; it will not fire until it is recreated`,
      );
    }
  }

  list(caller: SubscriptionCaller): SubscriptionSummary[] {
    return listSubscriptionsForDevice(this.deps.db, caller.deviceId);
  }

  /** Whether this record's condition is a watch evaluated by the Watch V2 runtime. */
  private isWatchV2Backed(subscriptionId: string, revision: number): boolean {
    const plan = getSubscriptionCompiledPlan(this.deps.db, subscriptionId, revision);
    return plan !== null && isWatchV2Plan(plan);
  }

  /**
   * The record an earlier call with this idempotency key already produced.
   *
   * The same check {@link create} performs on its own key, exposed so a caller
   * whose creation path is expensive can make it *before* paying. Compiling a
   * watch takes tens of seconds and a model call, and a transport retry that
   * compiled again would leave two watches behind — the first already
   * installed, since the definition is written before the record exists.
   *
   * Identical key with a different request is a conflict here for the same
   * reason it is there: a key that meant one thing cannot quietly come to mean
   * another.
   */
  replayedRequest(
    caller: SubscriptionCaller,
    request: CreateSubscriptionRequest,
  ): SubscriptionDetail | null {
    const existing = getSubscriptionForRequest(
      this.deps.db,
      subscriptionOwnerId(caller.deviceId),
      request.idempotencyKey,
      caller.deviceId,
      this.now(),
    );
    if (!existing) return null;
    const requested = fingerprint({
      condition: request.condition,
      reaction: request.reaction,
      workflowId: request.workflowId ?? null,
      expiresAt: request.expiresAt ?? null,
    });
    if (existing.requestFingerprint !== requested) {
      throw new SubscriptionServiceError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request.",
      );
    }
    return existing.subscription;
  }

  get(caller: SubscriptionCaller, subscriptionId: string): SubscriptionDetail {
    const subscription = getSubscriptionForDevice(
      this.deps.db,
      subscriptionId,
      caller.deviceId,
      this.now(),
    );
    if (!subscription) throw new SubscriptionServiceError("not_found", "Watch not found.");
    return subscription;
  }

  async update(
    caller: SubscriptionCaller,
    subscriptionId: string,
    patch: UpdateSubscriptionRequest,
  ): Promise<SubscriptionDetail> {
    const current = this.get(caller, subscriptionId);
    if (current.revision !== patch.expectedRevision) {
      throw new SubscriptionServiceError("stale_revision", "Watch has changed since it was read.");
    }
    if (patch.reaction !== undefined && patch.reaction.kind !== current.reaction.kind) {
      // The reaction kind is the watch's delivery identity — who approved it
      // and where firings go. Rewriting it would silently re-home the watch;
      // create a new one instead.
      throw new SubscriptionServiceError(
        "invalid_update",
        "A watch cannot change its delivery kind.",
      );
    }
    const changesDefinition =
      patch.condition !== undefined ||
      patch.reaction !== undefined ||
      patch.expiresAt !== undefined;
    if (changesDefinition) {
      // A record's condition is a compiled watch, evaluated in the watch
      // runtime. There is nothing here that could rewrite it — and nothing
      // that should: the instruction a wake is sent under is what was approved,
      // and rewriting an approved
      // record in place would have the ledger claim a wake went out under words
      // nobody agreed to — the same reason an anchor is retired and re-minted
      // rather than edited.
      throw new SubscriptionServiceError(
        "invalid_update",
        "This watch's condition cannot be revised. Revoke it and create a new one.",
      );
    }
    if (changesDefinition && patch.status !== undefined) {
      throw new SubscriptionServiceError(
        "invalid_update",
        "Change the Watch definition and status in separate requests.",
      );
    }
    const now = this.now();
    const policy = await this.deps.policyStore.get();
    if (!changesDefinition && patch.status) {
      if (patch.status === "active") {
        await this.ensureActivationReady(subscriptionId, patch.expectedRevision);
      }
      const result = await this.deps.writeGate.setSubscriptionStatus({
        subscriptionId,
        integrationDeviceId: caller.deviceId,
        expectedRevision: patch.expectedRevision,
        status: patch.status,
        policyRevision: policy.revision,
        updatedAt: now,
      });
      if (result.outcome === "updated") {
        return result.subscription;
      }
      return mapWriteOutcome(result.outcome);
    }
    return current;
  }

  async revoke(caller: SubscriptionCaller, subscriptionId: string): Promise<SubscriptionDetail> {
    const result = await this.deps.writeGate.revokeSubscription({
      subscriptionId,
      integrationDeviceId: caller.deviceId,
      revokedAt: this.now(),
    });
    if (result.outcome === "revoked") {
      return result.subscription;
    }
    return mapWriteOutcome(result.outcome);
  }

  /**
   * The approvals a human is being asked to resolve. Operator watches carry
   * no approval ceremony, so their bookkeeping rows are excluded — see
   * {@link SubscriptionApprovalAudience}.
   */
  listApprovals(
    status?: SubscriptionApprovalSummary["status"],
    limit = 100,
  ): SubscriptionApprovalSummary[] {
    return listSubscriptionApprovals(this.deps.db, status, this.now(), "decidable", limit);
  }

  listApprovalPage(
    status: SubscriptionApprovalSummary["status"] | undefined,
    limit: number,
    cursor?: string,
  ): SubscriptionApprovalPage {
    try {
      return listSubscriptionApprovalPage(
        this.deps.db,
        status,
        limit,
        cursor,
        this.now(),
        "decidable",
      );
    } catch (error) {
      if (error instanceof SubscriptionCursorError) {
        throw new SubscriptionServiceError("invalid_cursor", "Invalid pagination cursor.");
      }
      throw error;
    }
  }

  /**
   * One approval, as a decision surface reads it. An operator watch's
   * bookkeeping row is indistinguishable from an unknown id here, so a client
   * can never open, approve, or deny something that was never a question.
   */
  getDecidableApproval(approvalId: string): SubscriptionApprovalDetail {
    const approval = this.getApproval(approvalId);
    if (approval.reaction.kind !== "agent-workflow") {
      throw new SubscriptionServiceError("not_found", "Watch approval not found.");
    }
    return approval;
  }

  /** Trusted read of any approval row, including operator bookkeeping. */
  getApproval(approvalId: string): SubscriptionApprovalDetail {
    const approval = getSubscriptionApproval(this.deps.db, approvalId, this.now());
    if (!approval) {
      throw new SubscriptionServiceError("not_found", "Watch approval not found.");
    }
    return approval;
  }

  resolveApproval(
    resolver: SubscriptionApprovalResolver,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<SubscriptionApprovalDetail> {
    // Reads through the decidable projection first: a device tap may only
    // resolve something that was actually asked of the operator.
    this.getDecidableApproval(approvalId);
    return this.resolve(
      { kind: "device", deviceId: resolver.deviceId, tokenId: resolver.tokenId },
      approvalId,
      decision,
    );
  }

  private async resolve(
    resolvedBy: SubscriptionApprovalResolvedBy,
    approvalId: string,
    decision: "approve" | "deny",
    reviewedPolicy?: PrivacyPolicyDocument,
    reviewedDisclosure?: PrivacyCumulativeDisclosure,
  ): Promise<SubscriptionApprovalDetail> {
    const approval = this.getApproval(approvalId);
    const now = this.now();
    const policy = reviewedPolicy ?? (await this.deps.policyStore.get());
    // A device tap and the privacy reviewer act under the LIVE policy — their
    // authority derives from it, so the writer rejects them when the policy
    // moved under the approval. The operator authority is the operator's own
    // request and is not policy-derived: it resolves against the revision it
    // covers, so a policy edit between create and activation cannot strand an
    // operator watch. The grant it mints then matches its revision, which is
    // the consistency the firing path checks.
    const policyRevision =
      resolvedBy.kind === "operator" ? approval.policyRevision : policy.revision;
    const subscription = this.deps.db
      .prepare<
        [string],
        { expires_at: number | null }
      >("SELECT expires_at FROM subscriptions WHERE id = ?")
      .get(approval.subscriptionId);
    if (!subscription) {
      throw new SubscriptionServiceError("not_found", "Watch not found.");
    }
    if (decision === "approve") {
      await this.ensureActivationReady(approval.subscriptionId, approval.revision);
    }
    const write = () =>
      this.deps.writeGate.resolveSubscriptionApproval({
        approvalId,
        decision,
        resolvedBy,
        policyRevision,
        ...(reviewedDisclosure
          ? {
              expectedAnswerDisclosureRevision: reviewedDisclosure.revision,
              expectedExistenceDisclosureRevision: reviewedDisclosure.existenceRevision,
            }
          : {}),
        ...(resolvedBy.kind === "operator" || !this.deps.policyStore.path
          ? {}
          : {
              policyGuard: { path: this.deps.policyStore.path, expectedRevision: policyRevision },
            }),
        grantId: `sgrant_${this.id()}`,
        grantExpiresAt: Math.min(
          subscription.expires_at ?? now + DEFAULT_LIFETIME_MS,
          now + DEFAULT_LIFETIME_MS,
        ),
        resolvedAt: now,
      });
    const runIfRevision = this.deps.policyStore.runIfRevision?.bind(this.deps.policyStore);
    const result =
      resolvedBy.kind === "operator" || !runIfRevision
        ? await write()
        : await runIfRevision(policyRevision, write);
    if (result === null) return mapWriteOutcome("policy_changed");
    if (result.outcome === "resolved") {
      return result.approval;
    }
    void approval;
    return mapWriteOutcome(result.outcome);
  }

  listAll(
    status?: string,
    limit = 50,
    cursor?: string,
  ): { subscriptions: SubscriptionSummary[]; nextCursor: string | null } {
    try {
      return listAllSubscriptions(this.deps.db, status, limit, cursor);
    } catch (error) {
      if (error instanceof SubscriptionCursorError) {
        throw new SubscriptionServiceError("invalid_cursor", "Invalid Watch cursor.");
      }
      throw error;
    }
  }

  getTrusted(
    subscriptionId: string,
    evaluationLimit = DEFAULT_SUBSCRIPTION_EVALUATION_LIMIT,
  ): TrustedSubscriptionDetail {
    const subscription = getSubscriptionById(
      this.deps.db,
      subscriptionId,
      this.now(),
      evaluationLimit,
    );
    if (!subscription) throw new SubscriptionServiceError("not_found", "Watch not found.");
    return subscription;
  }

  /**
   * Revoke a record on this host's own authority.
   *
   * `reason` is for a machine revoking as a step of a larger change — the
   * caller says so, and the record carries the fact. Omitted means a person
   * decided, which is what every repair path treats as untouchable.
   */
  async revokeTrusted(subscriptionId: string, reason?: string): Promise<TrustedSubscriptionDetail> {
    const subscription = this.getTrusted(subscriptionId);
    const result = await this.deps.writeGate.revokeSubscription({
      subscriptionId,
      integrationDeviceId: subscription.integrationDevice.id,
      revokedAt: this.now(),
      ...(reason === undefined ? {} : { reason }),
    });
    if (result.outcome === "revoked") {
      return this.getTrusted(subscriptionId);
    }
    return mapWriteOutcome(result.outcome);
  }

  /**
   * Hard-delete a terminal (revoked or expired) watch and its whole
   * constellation. Any other status is refused with a conflict: revocation or
   * expiry is what makes a watch deletable, so no live watch — and no denied
   * watch, which an integration may still revise — can vanish in one call.
   */
  async purgeTrusted(subscriptionId: string): Promise<SubscriptionPurgeSummary> {
    const result = await this.deps.writeGate.purgeSubscription({ subscriptionId });
    if (result.outcome === "purged") {
      const p = result.purge;
      log.info(
        `Purged watch ${subscriptionId} (${p.status}): ${p.revisionsDeleted} revisions, ${p.firingsDeleted} firings, ${p.answerTokensDeleted} answer tokens, workflows=${p.workflowsDeleted}`,
      );
      return p;
    }
    if (result.outcome === "not_purgeable") {
      throw new SubscriptionServiceError(
        "not_terminal",
        `Only revoked or expired watches can be deleted; this watch is ${result.status}. Revoke it first.`,
      );
    }
    return mapWriteOutcome(result.outcome);
  }

  listFirings(
    subscriptionId: string,
    limit = 50,
    cursor?: string,
  ): { firings: SubscriptionFiringSummary[]; nextCursor: string | null } {
    this.getTrusted(subscriptionId);
    try {
      return listSubscriptionFirings(this.deps.db, subscriptionId, limit, cursor);
    } catch (error) {
      if (error instanceof SubscriptionCursorError) {
        throw new SubscriptionServiceError("invalid_cursor", "Invalid Watch cursor.");
      }
      throw error;
    }
  }

  /**
   * The trusted audit behind one firing. `getTrusted` runs first so an unknown
   * subscription is indistinguishable from an unknown firing.
   */
  getFiring(subscriptionId: string, firingId: string): TrustedSubscriptionFiringDetail {
    this.getTrusted(subscriptionId);
    const firing = getSubscriptionFiring(this.deps.db, subscriptionId, firingId);
    if (!firing) {
      throw new SubscriptionServiceError("not_found", "Subscription firing not found.");
    }
    return firing;
  }
}

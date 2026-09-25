// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import {
  assertNever,
  BACKGROUND_RATE_LIMIT_PATIENCE,
  createLogger,
  formatProviderFailureDetail,
  sanitizeProviderFailureField,
} from "@omnesis/core";
import {
  AgentError,
  MAX_READ_ONLY_ANSWER_CANDIDATE_CHARS,
  type AgentService,
  type AnswerCandidateTrace,
} from "../agent/service.js";
import {
  AnswerStoreError,
  auditDisplay,
  digestCandidate,
  getAnswerTaskResponse,
  loadPrivacyReviewerContext,
} from "./store.js";
import { getTaskByClientRequest } from "./store-internals.js";
import { recordedPolicyFamily, reviewedPolicyFamily } from "./reviewer.js";
import {
  AnswerProfiler,
  runWithAnswerProfiler,
  timeAnswerStoreOp,
  type AnswerProfileReport,
} from "./answer-profile.js";
import type { McpToolInvocationAuditInput } from "../access/types.js";
import type { ChatMessage } from "@omnesis/agent";
import type {
  AnswerResponse,
  PrivacyCumulativeDisclosure,
  PrivacyExternalMessage,
  PrivacyPolicyDocument,
  PrivacyReviewRecord,
} from "@omnesis/types/privacy";
import type Database from "better-sqlite3";

import type { WriteGate } from "../write-gate.js";
import type { PrivacyPolicyStore } from "./policy-store.js";
import type {
  PrivacyReviewPolicyFamily,
  PrivacyReviewer,
  PrivacyReviewResult,
} from "./reviewer.js";
import type { FiringAnswerEvidence } from "./firing-evidence.js";
import type {
  AnswerEgressEndpoint,
  AppendAnswerAuditEventInput,
  RecordAnswerEgressInput,
} from "./store-types.js";
import type { CorpusAuthorization } from "../access/corpus-authorization.js";

const log = createLogger("gateway:privacy:answer");

export const DEFAULT_ANSWER_WORKFLOW_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_PRIVACY_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_CONCURRENT_ANSWERS_PER_OWNER = 2;
export const DEFAULT_MAX_CONCURRENT_ANSWERS_TOTAL = 16;
/**
 * Minimum spacing between escalation push notifications for one caller. A caller
 * that piles up approvals cannot turn the owner's phone into a notification-spam
 * channel: at most one push fires per owner per cooldown. Suppressed approvals
 * still appear in the trusted apps — the first push of a burst already told the
 * user to open Omnesis, where the full pending list is visible.
 */
export const DEFAULT_ESCALATION_COOLDOWN_MS = 60 * 1_000;
export const MAX_ANSWER_CANDIDATE_CHARS = MAX_READ_ONLY_ANSWER_CANDIDATE_CHARS;
export const MAX_RELEASED_HISTORY_CHARS = 200_000;
export const MAX_RELEASED_HISTORY_MESSAGES = 40;

export interface AnswerRequest {
  ownerId: string;
  question: string;
  clientRequestId: string;
  workflowId?: string;
  conversationId?: string;
  workflowName?: string;
  workflowPurpose?: string;
  approvalMode?: "allow" | "never";
  /** Private immutable document scope for a firing-bound Answer. */
  evidenceDocumentIds?: readonly string[];
  /** Private immutable document or existence-only watch scope. */
  firingEvidence?: FiringAnswerEvidence;
  /** Included in idempotency and persisted audit scope for firing answers. */
  subscriptionFiringId?: string;
  completionRoute?: { integrationDeviceId: string; nativeConversationId: string };
  /** Server-derived external principal corpus boundary. */
  corpusAuthorization?: CorpusAuthorization;
  signal?: AbortSignal;
  /**
   * Collect a timing profile of this run (agent + reviewer LLM calls, tool
   * calls, worker-queue waits, store ops). Served only to the MCP
   * `ask_omnesis` `profiling` flag; every other caller leaves it absent.
   */
  profiling?: boolean;
}

export interface AnswerCandidateGenerator {
  generateReadOnlyAnswerCandidate(
    question: string,
    initialHistory: ReadonlyArray<ChatMessage>,
    signal?: AbortSignal,
    onTrace?: (trace: AnswerCandidateTrace) => void,
    options?: {
      evidenceDocumentIds?: readonly string[];
      firingEvidence?: FiringAnswerEvidence;
      corpusAuthorization?: CorpusAuthorization;
      profiler?: AnswerProfiler;
    },
  ): ReturnType<AgentService["generateReadOnlyAnswerCandidate"]>;
}

export interface AnswerServiceDeps {
  db: Database.Database;
  writeGate: Pick<
    WriteGate,
    | "beginAnswerTask"
    | "completeAnswerTask"
    | "failAnswerTask"
    | "expirePrivacyApprovals"
    | "appendAnswerAuditEvents"
    | "recordAnswerEgress"
  >;
  agent: AnswerCandidateGenerator;
  reviewer: Pick<PrivacyReviewer, "review">;
  policyStore: Pick<PrivacyPolicyStore, "get" | "runIfRevision"> & {
    readonly path?: string;
    getFamily?: (familyId: string) => Promise<PrivacyPolicyDocument | null>;
    runFamilyIfRevision?: <T>(
      familyId: string,
      expectedRevision: string,
      operation: (document: PrivacyPolicyDocument) => Promise<T>,
    ) => Promise<T | null>;
  };
  notifyApproval?: (approvalId: string) => Promise<void>;
  now?: () => number;
  idGen?: (kind: "workflow" | "conversation" | "task" | "approval" | "release") => string;
  workflowTtlMs?: number;
  approvalTtlMs?: number;
  maxConcurrentPerOwner?: number;
  maxConcurrentTotal?: number;
  escalationCooldownMs?: number;
}

export class AnswerTaskInProgressError extends Error {
  constructor(readonly taskId: string) {
    super("The same answer request is already being processed.");
    this.name = "AnswerTaskInProgressError";
  }
}

export class AnswerCapacityError extends Error {
  constructor() {
    super("Too many answer requests are already running. Try again after one finishes.");
    this.name = "AnswerCapacityError";
  }
}

export class AnswerCandidateLimitError extends Error {
  constructor() {
    super("The generated answer exceeded the privacy review size limit.");
    this.name = "AnswerCandidateLimitError";
  }
}

export class AnswerService {
  private readonly now: () => number;
  private readonly idGen: NonNullable<AnswerServiceDeps["idGen"]>;
  private readonly workflowTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly maxConcurrentPerOwner: number;
  private readonly maxConcurrentTotal: number;
  private readonly escalationCooldownMs: number;
  private readonly activeByOwner = new Map<string, number>();
  private readonly lastEscalationAt = new Map<string, number>();
  private activeTotal = 0;

  constructor(private readonly deps: AnswerServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.idGen = deps.idGen ?? ((kind) => `${idPrefix(kind)}_${randomUUID()}`);
    this.workflowTtlMs = deps.workflowTtlMs ?? DEFAULT_ANSWER_WORKFLOW_TTL_MS;
    this.approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_PRIVACY_APPROVAL_TTL_MS;
    this.maxConcurrentPerOwner =
      deps.maxConcurrentPerOwner ?? DEFAULT_MAX_CONCURRENT_ANSWERS_PER_OWNER;
    this.maxConcurrentTotal = deps.maxConcurrentTotal ?? DEFAULT_MAX_CONCURRENT_ANSWERS_TOTAL;
    this.escalationCooldownMs = deps.escalationCooldownMs ?? DEFAULT_ESCALATION_COOLDOWN_MS;
  }

  /**
   * Ask, or collect the answer to an ask already running.
   *
   * Capacity is not taken here. It bounds concurrent *agent turns* — the
   * expensive part — and a request only reaches one after the store has told
   * it that the ask is new (see `answerWithinCapacity`). Two consequences the
   * wait contract depends on:
   *
   *   - A repeat of an ask already in flight is a poll. It resolves from the
   *     existing task and consumes no capacity, so a caller waiting the way
   *     the contract tells it to can never lock itself out.
   *   - A request queued behind the writer holds nothing while it waits. What
   *     it is queued for costs the writer, not the model.
   */
  async answer(request: AnswerRequest): Promise<AnswerResponse> {
    return (await this.answerWithProfile(request)).response;
  }

  /**
   * Answer, plus the timing profile when `request.profiling` is set. The
   * profile covers generation and review; egress recording (which happens
   * afterwards, on the boundary) is not included. Repeat polls of an
   * already-known ask run no turn, so they report a null profile.
   */
  async answerWithProfile(request: AnswerRequest): Promise<{
    response: AnswerResponse;
    profile: AnswerProfileReport | null;
  }> {
    const profiler = request.profiling ? new AnswerProfiler() : undefined;
    const startedAt = this.now();
    const run = (): Promise<{
      response: AnswerResponse;
      candidateWallMs: number;
      reviewWallMs: number;
      duplicate: boolean;
    }> => this.answerWithinCapacity(request, profiler);
    const completed = profiler ? await runWithAnswerProfiler(profiler, run) : await run();
    if (!profiler || completed.duplicate) {
      // No profiler, or a repeat poll that ran no turn: nothing to profile.
      return { response: completed.response, profile: null };
    }
    return {
      response: completed.response,
      profile: profiler.buildReport({
        totalWallMs: this.now() - startedAt,
        candidateWallMs: completed.candidateWallMs,
        reviewWallMs: completed.reviewWallMs,
      }).report,
    };
  }

  private async answerWithinCapacity(
    request: AnswerRequest,
    profiler?: AnswerProfiler,
  ): Promise<{
    response: AnswerResponse;
    candidateWallMs: number;
    reviewWallMs: number;
    duplicate: boolean;
  }> {
    const startedAt = this.now();
    // Is this ask already known? A repeat is a poll: it resolves from the task
    // that exists and starts no turn, so it must never be refused for capacity
    // — a caller waiting as the contract instructs would be locked out by its
    // own in-flight ask. Only an ask with no task behind it is measured against
    // the turn limit, and only advisorily: this reserves nothing, so waiting
    // for the writer still costs no slot. The binding acquire happens once the
    // store confirms the ask is new; a request that passes here and loses that
    // race fails cleanly rather than hanging.
    const known = getTaskByClientRequest(this.deps.db, request.ownerId, request.clientRequestId);
    if (!known) this.assertCapacityAvailable(request.ownerId);
    await timeAnswerStoreOp("expirePrivacyApprovals", () =>
      this.deps.writeGate.expirePrivacyApprovals(startedAt),
    );
    const task = await timeAnswerStoreOp("beginAnswerTask", () =>
      this.deps.writeGate.beginAnswerTask({
        ownerId: request.ownerId,
        workflowId: request.workflowId,
        conversationId: request.conversationId,
        clientRequestId: request.clientRequestId,
        question: request.question,
        workflowName: request.workflowName,
        workflowPurpose: request.workflowPurpose,
        approvalMode: request.approvalMode,
        subscriptionFiringId: request.subscriptionFiringId,
        completionRoute: request.completionRoute,
        ids: {
          workflowId: this.idGen("workflow"),
          conversationId: this.idGen("conversation"),
          taskId: this.idGen("task"),
        },
        now: startedAt,
        workflowExpiresAt: startedAt + this.workflowTtlMs,
      }),
    );

    if (task.duplicate) {
      const existing = getAnswerTaskResponse(this.deps.db, task.taskId, request.ownerId);
      // A repeat poll runs no turn: there is nothing to profile.
      if (existing)
        return { response: existing, candidateWallMs: 0, reviewWallMs: 0, duplicate: true };
      throw new AnswerTaskInProgressError(task.taskId);
    }

    let capturedTrace: AnswerCandidateTrace | undefined;
    let tracePersisted = false;
    let capacityHeld = false;
    try {
      // The ask is new and the turn is next, so this is the moment the run
      // starts costing something. Acquiring inside the try means a refusal
      // here fails the task through the same path as any other error, rather
      // than leaving a task in `running` that nothing will ever finish.
      this.acquireCapacity(request.ownerId);
      capacityHeld = true;
      const authorization = request.corpusAuthorization;
      if (authorization && authorization.capability !== "answer") {
        throw new Error("Invalid Answer authorization capability.");
      }
      const reviewedAuthorization =
        authorization?.releaseMode === "reviewed" ? authorization : null;
      const unreviewed = authorization?.releaseMode === "unreviewed";
      if (authorization && !reviewedAuthorization && !unreviewed) {
        throw new Error("Answer authorization has no release mode.");
      }
      const candidatePhaseStart = this.now();
      if (
        reviewedAuthorization &&
        (!reviewedAuthorization.policyFamilyId || !reviewedAuthorization.policyRevision)
      ) {
        throw new Error("Reviewed Answer authorization has no policy revision.");
      }
      const [policy, generationContext] = await Promise.all([
        reviewedAuthorization
          ? (this.deps.policyStore.getFamily?.(reviewedAuthorization.policyFamilyId!) ??
            Promise.resolve(null))
          : unreviewed
            ? Promise.resolve(null)
            : this.deps.policyStore.get(),
        Promise.resolve(
          loadPrivacyReviewerContext(
            this.deps.db,
            task.workflowId,
            task.conversationId,
            request.ownerId,
          ),
        ),
      ]);
      if (
        reviewedAuthorization &&
        (!policy || policy.revision !== reviewedAuthorization.policyRevision)
      ) {
        throw new AnswerStoreError(
          "policy_changed",
          "The grant-selected privacy policy is unavailable or changed.",
        );
      }
      const policyFamily = policy ? reviewedPolicyFamily(policy) : undefined;
      const answerHistory = boundReleasedHistory(
        toChatHistory(generationContext.priorExternalConversation),
      );
      // Known bug: #50 — this in-process agent run can hold the event loop
      // long enough to starve trusted-app reads (incl. the approval surface).
      const candidateOptions = {
        ...(request.firingEvidence ? { firingEvidence: request.firingEvidence } : {}),
        ...(request.evidenceDocumentIds
          ? { evidenceDocumentIds: request.evidenceDocumentIds }
          : {}),
        ...(request.corpusAuthorization
          ? { corpusAuthorization: request.corpusAuthorization }
          : {}),
        ...(profiler ? { profiler } : {}),
      };
      const candidateResult = await this.deps.agent.generateReadOnlyAnswerCandidate(
        request.question,
        answerHistory,
        request.signal,
        (trace) => {
          capturedTrace = trace;
        },
        Object.keys(candidateOptions).length > 0 ? candidateOptions : undefined,
      );
      const candidate = candidateResult.answer;
      capturedTrace ??= candidateResult.trace;
      if (candidate.length > MAX_ANSWER_CANDIDATE_CHARS) {
        throw new AnswerCandidateLimitError();
      }
      await this.persistGenerationAudit(
        task.taskId,
        request.ownerId,
        capturedTrace,
        candidate,
        this.now(),
      );
      tracePersisted = true;
      const candidateWallMs = this.now() - candidatePhaseStart;
      const reviewPhaseStart = this.now();
      const response = unreviewed
        ? await this.releaseUnreviewed(
            task.taskId,
            request.ownerId,
            candidate,
            authorization!.digest,
            task.workflowId,
            task.conversationId,
          )
        : await this.reviewAndCommitFreshDisclosure(
            {
              taskId: task.taskId,
              workflowId: task.workflowId,
              conversationId: task.conversationId,
              ownerId: request.ownerId,
              candidate,
              policy: policy!.policy,
              policyRevision: policy!.revision,
              ...(policyFamily ? { policyFamily } : {}),
              ...(reviewedAuthorization?.policyFamilyId
                ? { policyFamilyId: reviewedAuthorization.policyFamilyId }
                : {}),
              workflowPurpose: task.workflowPurpose,
              currentQuestion: request.question,
              approvalMode: request.approvalMode ?? "allow",
              signal: request.signal,
            },
            profiler,
          );
      if (response.status === "approval_required") {
        this.notifyApprovalBestEffort(request.ownerId, response.approvalId);
      }
      return {
        response,
        candidateWallMs,
        reviewWallMs: this.now() - reviewPhaseStart,
        duplicate: false,
      };
    } catch (err) {
      if (capturedTrace && !tracePersisted) {
        try {
          const failure = answerFailureSummary(err);
          await this.persistGenerationAudit(
            task.taskId,
            request.ownerId,
            capturedTrace,
            null,
            this.now(),
            failure,
          );
        } catch (auditErr) {
          log.warn(
            `failed to persist answer trace ${task.taskId}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          );
        }
      }
      const summary = answerFailureSummary(err);
      log.warn(
        `answer ${task.taskId} failed: ${summary.code}${summary.detail ? ` (${summary.detail})` : ""}`,
      );
      try {
        await timeAnswerStoreOp("failAnswerTask", () =>
          this.deps.writeGate.failAnswerTask(task.taskId, request.ownerId, this.now(), summary),
        );
      } catch (cleanupErr) {
        log.warn(
          `failed to clean up answer task ${task.taskId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
      throw err;
    } finally {
      if (capacityHeld) this.releaseCapacity(request.ownerId);
    }
  }

  async getResponse(taskId: string, ownerId: string): Promise<AnswerResponse | null> {
    await this.deps.writeGate.expirePrivacyApprovals(this.now());
    return getAnswerTaskResponse(this.deps.db, taskId, ownerId);
  }

  async recordEgress(
    taskId: string,
    ownerId: string,
    endpoint: AnswerEgressEndpoint,
    mcpInvocationAudit?: McpToolInvocationAuditInput,
    deviceAnswerAuthority?: RecordAnswerEgressInput["deviceAnswerAuthority"],
  ): Promise<{ response: AnswerResponse; responseJson: string } | null> {
    return this.deps.writeGate.recordAnswerEgress({
      id: `egress_${randomUUID()}`,
      taskId,
      ownerId,
      endpoint,
      now: this.now(),
      ...(mcpInvocationAudit ? { mcpInvocationAudit } : {}),
      ...(deviceAnswerAuthority ? { deviceAnswerAuthority } : {}),
    });
  }

  private async reviewAndCommitFreshDisclosure(
    input: {
      taskId: string;
      workflowId: string;
      conversationId: string;
      ownerId: string;
      candidate: string;
      policy: string;
      policyRevision: string;
      /** Named on the review record; absent when the document carries no family. */
      policyFamily?: PrivacyReviewPolicyFamily;
      /** The grant-selected family whose revision fences the release; absent for the default policy. */
      policyFamilyId?: string;
      workflowPurpose: string;
      currentQuestion: string;
      approvalMode: "allow" | "never";
      signal?: AbortSignal;
    },
    profiler?: AnswerProfiler,
    attempt = 0,
  ): Promise<AnswerResponse> {
    const reviewerContext = loadPrivacyReviewerContext(
      this.deps.db,
      input.workflowId,
      input.conversationId,
      input.ownerId,
    );
    const reviewHistory = boundReviewerHistory(reviewerContext.priorExternalConversation);
    const cumulativeDisclosure = {
      ...reviewerContext.cumulativeDisclosure,
      olderTurnsOmitted:
        reviewerContext.cumulativeDisclosure.olderTurnsOmitted + reviewHistory.omittedTurns,
    };
    // The review runs inside a task whose answer is already generated, so it
    // waits out a quota reset rather than holding that work for approval.
    const review = await this.deps.reviewer.review(
      {
        currentQuestion: input.currentQuestion,
        candidateAnswer: input.candidate,
        policy: input.policy,
        policyRevision: input.policyRevision,
        ...(input.policyFamily ? { policyFamily: input.policyFamily } : {}),
        workflowPurpose: input.workflowPurpose,
        priorExternalConversation: reviewHistory.messages,
        cumulativeDisclosure,
        reviewStage: "initial",
      },
      input.signal,
      { ...(profiler ? { profiler } : {}), rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE },
    );
    await this.persistReviewAudit(input.taskId, input.ownerId, review, this.now());
    try {
      return await this.commitReviewedCandidate(
        input.taskId,
        input.ownerId,
        input.candidate,
        input.policy,
        input.workflowPurpose,
        input.currentQuestion,
        reviewHistory.messages,
        cumulativeDisclosure,
        review,
        input.signal,
        input.approvalMode,
        input.policyFamilyId,
        profiler,
      );
    } catch (err) {
      if (!(err instanceof AnswerStoreError) || err.code !== "disclosure_changed") throw err;
      if (attempt < 2) return this.reviewAndCommitFreshDisclosure(input, profiler, attempt + 1);
      return this.holdOrDenyWithoutApproval(
        input.taskId,
        input.ownerId,
        input.candidate,
        {
          ...review.review,
          rationale:
            "Workflow disclosures changed repeatedly during review, so explicit approval is required.",
        },
        this.now(),
        false,
        [],
        input.approvalMode,
      );
    }
  }

  private async commitReviewedCandidate(
    taskId: string,
    ownerId: string,
    candidate: string,
    policy: string,
    workflowPurpose: string | undefined,
    currentQuestion: string,
    priorExternalConversation: PrivacyExternalMessage[],
    cumulativeDisclosure: PrivacyCumulativeDisclosure,
    result: PrivacyReviewResult,
    signal?: AbortSignal,
    approvalMode: "allow" | "never" = "allow",
    policyFamilyId?: string,
    profiler?: AnswerProfiler,
  ): Promise<AnswerResponse> {
    const now = this.now();
    if (result.decision === "allow") {
      return this.releaseIfPolicyCurrent(
        taskId,
        ownerId,
        candidate,
        result.review,
        [],
        false,
        cumulativeDisclosure.revision,
        cumulativeDisclosure.existenceRevision,
        approvalMode,
        policyFamilyId,
      );
    }
    if (result.decision === "deny") {
      return timeAnswerStoreOp("completeAnswerTask", () =>
        this.deps.writeGate.completeAnswerTask({
          taskId,
          ownerId,
          review: result.review,
          now,
          outcome: { kind: "deny", reason: result.hardStop ? "hard_stop" : "privacy_policy" },
        }),
      );
    }
    if (result.decision === "ask" || !result.reducedAnswer) {
      return this.holdOrDenyWithoutApproval(
        taskId,
        ownerId,
        candidate,
        result.review,
        now,
        false,
        [],
        approvalMode,
      );
    }

    // Bound here so the narrowed type survives the store-timing closure.
    const preReductionAnswer: string = result.reducedAnswer;
    await timeAnswerStoreOp("appendAnswerAuditEvents", () =>
      this.deps.writeGate.appendAnswerAuditEvents([
        {
          id: `audit_${randomUUID()}`,
          taskId,
          ownerId,
          kind: "reduction_generated",
          display: auditDisplay({
            title: "Reduced candidate",
            status: "reduced",
            text: preview(preReductionAnswer),
            digest: digestCandidate(preReductionAnswer),
            reductions: result.reductions,
          }),
          payload: {
            reducedAnswer: preReductionAnswer,
            reducedAnswerDigest: digestCandidate(preReductionAnswer),
            originalCandidateDigest: digestCandidate(candidate),
            reductions: result.reductions,
          },
          now: this.now(),
        },
      ]),
    );

    // The reduced answer is judged under the policy the first pass named.
    const policyFamily = recordedPolicyFamily(result.review);
    const secondReview = await this.deps.reviewer.review(
      {
        currentQuestion,
        candidateAnswer: result.reducedAnswer,
        policy,
        policyRevision: result.review.policyRevision,
        ...(policyFamily ? { policyFamily } : {}),
        workflowPurpose,
        priorExternalConversation,
        cumulativeDisclosure,
        reviewStage: "reduction",
      },
      signal,
      { ...(profiler ? { profiler } : {}), rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE },
    );
    await this.persistReviewAudit(taskId, ownerId, secondReview, this.now());
    const combinedReview = combineReductionReviews(result.review, secondReview.review);
    if (secondReview.decision === "allow") {
      return this.releaseIfPolicyCurrent(
        taskId,
        ownerId,
        result.reducedAnswer,
        combinedReview,
        result.reductions.length > 0
          ? result.reductions
          : ["Private detail was removed or generalized"],
        true,
        cumulativeDisclosure.revision,
        cumulativeDisclosure.existenceRevision,
        approvalMode,
        policyFamilyId,
      );
    }
    if (secondReview.decision === "deny") {
      return timeAnswerStoreOp("completeAnswerTask", () =>
        this.deps.writeGate.completeAnswerTask({
          taskId,
          ownerId,
          review: combinedReview,
          now: this.now(),
          outcome: {
            kind: "deny",
            reason: secondReview.hardStop ? "hard_stop" : "privacy_policy",
          },
        }),
      );
    }
    return this.holdOrDenyWithoutApproval(
      taskId,
      ownerId,
      result.reducedAnswer,
      combinedReview,
      this.now(),
      true,
      result.reductions.length > 0
        ? result.reductions
        : ["Private detail was removed or generalized"],
      approvalMode,
    );
  }

  private holdForApproval(
    taskId: string,
    ownerId: string,
    candidate: string,
    review: PrivacyReviewRecord,
    now: number,
    reduced: boolean,
    reductions: string[],
  ): Promise<AnswerResponse> {
    return timeAnswerStoreOp("completeAnswerTask", () =>
      this.deps.writeGate.completeAnswerTask({
        taskId,
        ownerId,
        review,
        now,
        outcome: {
          kind: "approval",
          approvalId: this.idGen("approval"),
          candidateAnswer: candidate,
          candidateDigest: digestCandidate(candidate),
          releaseStatus: reduced ? "released_with_reductions" : "released",
          reductions,
          expiresAt: now + this.approvalTtlMs,
        },
      }),
    );
  }

  private holdOrDenyWithoutApproval(
    taskId: string,
    ownerId: string,
    candidate: string,
    review: PrivacyReviewRecord,
    now: number,
    reduced: boolean,
    reductions: string[],
    approvalMode: "allow" | "never",
  ): Promise<AnswerResponse> {
    if (approvalMode === "allow") {
      return this.holdForApproval(taskId, ownerId, candidate, review, now, reduced, reductions);
    }
    return timeAnswerStoreOp("completeAnswerTask", () =>
      this.deps.writeGate.completeAnswerTask({
        taskId,
        ownerId,
        review,
        now,
        outcome: { kind: "deny", reason: "approval_not_available" },
      }),
    );
  }

  private async releaseIfPolicyCurrent(
    taskId: string,
    ownerId: string,
    answer: string,
    review: PrivacyReviewRecord,
    reductions: string[],
    reduced: boolean,
    expectedDisclosureRevision: number,
    expectedExistenceDisclosureRevision: number,
    approvalMode: "allow" | "never" = "allow",
    policyFamilyId?: string,
  ): Promise<AnswerResponse> {
    // Named families are fenced by runFamilyIfRevision below. The file-backed
    // guard represents only the legacy/default family; applying it to a named
    // family would compare unrelated revision sequences.
    const policyGuard =
      !policyFamilyId && this.deps.policyStore.path
        ? { path: this.deps.policyStore.path, expectedRevision: review.policyRevision }
        : undefined;
    let released: AnswerResponse | null;
    try {
      const operation = () =>
        timeAnswerStoreOp("completeAnswerTask", () =>
          this.deps.writeGate.completeAnswerTask({
            taskId,
            ownerId,
            review,
            now: this.now(),
            outcome: reduced
              ? {
                  kind: "reduce",
                  releaseId: this.idGen("release"),
                  answer,
                  reductions,
                  expectedDisclosureRevision,
                  expectedExistenceDisclosureRevision,
                  policyGuard,
                }
              : {
                  kind: "release",
                  releaseId: this.idGen("release"),
                  answer,
                  expectedDisclosureRevision,
                  expectedExistenceDisclosureRevision,
                  policyGuard,
                },
          }),
        );
      released = policyFamilyId
        ? ((await this.deps.policyStore.runFamilyIfRevision?.(
            policyFamilyId,
            review.policyRevision,
            operation,
          )) ?? null)
        : await this.deps.policyStore.runIfRevision(review.policyRevision, operation);
    } catch (err) {
      if (!(err instanceof AnswerStoreError) || err.code !== "policy_changed") throw err;
      released = null;
    }
    if (released) return released;
    return this.holdOrDenyWithoutApproval(
      taskId,
      ownerId,
      answer,
      {
        ...review,
        rationale: policyFamilyId
          ? "The grant-selected policy changed during review, so explicit approval is required."
          : "The policy changed during review, so explicit approval is required.",
      },
      this.now(),
      reduced,
      reductions,
      approvalMode,
    );
  }

  private async releaseUnreviewed(
    taskId: string,
    ownerId: string,
    answer: string,
    scopeDigest: string,
    workflowId: string,
    conversationId: string,
    attempt = 0,
  ): Promise<AnswerResponse> {
    const context = loadPrivacyReviewerContext(this.deps.db, workflowId, conversationId, ownerId);
    const review: PrivacyReviewRecord = {
      recipeVersion: "explicit-unreviewed-v1",
      provider: null,
      model: null,
      confidence: null,
      policyRevision: `unreviewed:${scopeDigest}`,
      findings: [],
      rationale: "The Access Grant explicitly permits release without privacy review.",
    };
    try {
      return await timeAnswerStoreOp("completeAnswerTask", () =>
        this.deps.writeGate.completeAnswerTask({
          taskId,
          ownerId,
          review,
          now: this.now(),
          outcome: {
            kind: "release",
            releaseId: this.idGen("release"),
            answer,
            expectedDisclosureRevision: context.cumulativeDisclosure.revision,
            expectedExistenceDisclosureRevision: context.cumulativeDisclosure.existenceRevision,
          },
        }),
      );
    } catch (error) {
      if (error instanceof AnswerStoreError && error.code === "disclosure_changed" && attempt < 2) {
        return this.releaseUnreviewed(
          taskId,
          ownerId,
          answer,
          scopeDigest,
          workflowId,
          conversationId,
          attempt + 1,
        );
      }
      throw error;
    }
  }

  private persistGenerationAudit(
    taskId: string,
    ownerId: string,
    trace: AnswerCandidateTrace | undefined,
    candidate: string | null,
    now: number,
    failure?: { code: string; message: string },
  ): Promise<void> {
    // Explicit element type: the array is captured by the store-timing
    // closure below, which freezes evolving-array inference.
    const events: AppendAnswerAuditEventInput[] = [];
    if (trace) {
      events.push({
        id: `audit_${randomUUID()}`,
        taskId,
        ownerId,
        kind: "agent_trace" as const,
        display: auditDisplay({
          title: "Agent activity",
          text: "Read-only model and tool activity inside Omnesis.",
          ...(failure ? { detail: failure.message } : {}),
          provider: trace.provider,
          model: trace.model,
        }),
        payload: trace,
        now,
      });
    }
    if (candidate !== null) {
      events.push({
        id: `audit_${randomUUID()}`,
        taskId,
        ownerId,
        kind: "candidate_generated" as const,
        display: auditDisplay({
          title: "Candidate inside Omnesis",
          text: preview(candidate),
          digest: digestCandidate(candidate),
        }),
        payload: { candidateAnswer: candidate, candidateDigest: digestCandidate(candidate) },
        now,
      });
    }
    return timeAnswerStoreOp("appendAnswerAuditEvents", () =>
      this.deps.writeGate.appendAnswerAuditEvents(events),
    );
  }

  private persistReviewAudit(
    taskId: string,
    ownerId: string,
    result: PrivacyReviewResult,
    now: number,
  ): Promise<void> {
    return timeAnswerStoreOp("appendAnswerAuditEvents", () =>
      this.deps.writeGate.appendAnswerAuditEvents([
        {
          id: `audit_${randomUUID()}`,
          taskId,
          ownerId,
          kind: "privacy_review",
          display: auditDisplay({
            title: result.audit.stage === "reduction" ? "Reduction review" : "Privacy review",
            text: result.review.rationale,
            status: result.decision,
            provider: result.review.provider,
            model: result.review.model,
            confidence: result.review.confidence,
            digest: result.audit.envelopeDigest,
            reductions: result.reductions,
          }),
          payload: {
            decision: result.decision,
            hardStop: result.hardStop,
            reductions: result.reductions,
            reducedAnswer: result.reducedAnswer ?? null,
            review: result.review,
            audit: result.audit,
          },
          now,
        },
      ]),
    );
  }

  /** Refuse early when the turn limit is already reached, reserving nothing. */
  private assertCapacityAvailable(ownerId: string): void {
    const ownerActive = this.activeByOwner.get(ownerId) ?? 0;
    if (ownerActive >= this.maxConcurrentPerOwner || this.activeTotal >= this.maxConcurrentTotal) {
      log.warn(
        `answer capacity refused for owner ${ownerId} before task creation: ${ownerActive}/${this.maxConcurrentPerOwner} owner turns, ${this.activeTotal}/${this.maxConcurrentTotal} total running`,
      );
      throw new AnswerCapacityError();
    }
  }

  private acquireCapacity(ownerId: string): void {
    const ownerActive = this.activeByOwner.get(ownerId) ?? 0;
    if (ownerActive >= this.maxConcurrentPerOwner || this.activeTotal >= this.maxConcurrentTotal) {
      // A refusal is the one Answer outcome a caller cannot diagnose from its
      // own side: it arrives as a bare 503 inside an MCP envelope. Say which
      // limit was hit and what is holding it, so "the gateway refused me" is
      // answerable from the journal alone.
      log.warn(
        `answer capacity refused for owner ${ownerId}: ${ownerActive}/${this.maxConcurrentPerOwner} owner turns, ${this.activeTotal}/${this.maxConcurrentTotal} total running`,
      );
      throw new AnswerCapacityError();
    }
    this.activeByOwner.set(ownerId, ownerActive + 1);
    this.activeTotal += 1;
  }

  private releaseCapacity(ownerId: string): void {
    const ownerActive = this.activeByOwner.get(ownerId) ?? 1;
    if (ownerActive <= 1) this.activeByOwner.delete(ownerId);
    else this.activeByOwner.set(ownerId, ownerActive - 1);
    this.activeTotal = Math.max(0, this.activeTotal - 1);
  }

  private notifyApprovalBestEffort(ownerId: string, approvalId: string): void {
    if (!this.deps.notifyApproval) return;
    if (!this.claimEscalationSlot(ownerId)) {
      log.info(
        `privacy approval ${approvalId} not pushed: owner ${ownerId} was notified within the escalation cooldown (still visible in Omnesis)`,
      );
      return;
    }
    try {
      void this.deps.notifyApproval(approvalId).catch((err) => {
        log.warn(
          `privacy approval notification failed for ${approvalId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      log.warn(
        `privacy approval notification failed for ${approvalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Per-owner escalation throttle: returns true (and records the time) at most
   * once per {@link escalationCooldownMs} for a given caller, so a caller cannot
   * flood the owner's devices with pushes. Suppressed approvals are still stored
   * and shown in the trusted apps.
   */
  private claimEscalationSlot(ownerId: string): boolean {
    const now = this.now();
    const last = this.lastEscalationAt.get(ownerId);
    if (last !== undefined && now - last < this.escalationCooldownMs) return false;
    this.lastEscalationAt.set(ownerId, now);
    this.pruneEscalations(now);
    return true;
  }

  private pruneEscalations(now: number): void {
    if (this.lastEscalationAt.size < 256) return;
    for (const [owner, at] of this.lastEscalationAt) {
      if (now - at >= this.escalationCooldownMs) this.lastEscalationAt.delete(owner);
    }
  }
}

/**
 * The operator-facing explanation for a failed answer: an Omnesis-authored
 * sentence, the machine code that produced it, and — when a model provider
 * rejected the request — the provider's own vetted disposition metadata, so a
 * 404 model assignment is distinguishable from a 429 without reading the log.
 */
function answerFailureSummary(err: unknown): {
  code: string;
  message: string;
  detail?: string;
} {
  if (err instanceof AgentError) {
    const detail = formatProviderFailureDetail(err.provider);
    const withDetail = (code: string, message: string) => ({
      // The code is persisted and rendered verbatim beside the provider fields,
      // which are already held to identifier shape. Hold it to the same bar so
      // a producer that ever passes prose through as a code cannot put it on a
      // client's screen.
      code: sanitizeProviderFailureField(code) ?? "answer_generation_or_review_failed",
      message,
      ...(detail ? { detail } : {}),
    });
    switch (err.code) {
      case "http_empty_response":
        return withDetail(
          err.code,
          err.message.includes("finish_reason=length")
            ? "The model returned an empty response (finish_reason=length) before producing a final answer."
            : "The model returned an empty response before producing a final answer.",
        );
      case "http_request_timeout":
        return withDetail(
          err.code,
          "The model did not respond within the request deadline. Try this answer again.",
        );
      case "answer_incomplete":
        return withDetail(
          err.code,
          err.message.includes("max_tokens") || err.message.includes("truncated")
            ? "The model reached its output limit (finish_reason=length) before completing this response."
            : "The model stopped before completing this response.",
        );
      case "answer_canceled":
        return withDetail(err.code, "The request was canceled before Omnesis completed it.");
      case "context_window_exceeded":
        return withDetail(
          err.code,
          "The question and evidence exceeded the selected model's context window.",
        );
      case "answer_empty":
        return withDetail(err.code, "The model completed without producing an answer.");
      case "firing_evidence_unavailable":
        return withDetail(
          err.code,
          "The evidence this watch fired on is no longer in the index, so the question could not be answered from it.",
        );
      case "agent_unconfigured":
        return withDetail(err.code, "No model is assigned to answer external-agent questions.");
      case "http_request_error":
        return withDetail(
          err.code,
          "The model request could not reach the selected model. Check that the backend is running and reachable, then try again.",
        );
      case "http_api_error":
      case "anthropic_api_error":
      case "http_protocol_mismatch":
        // The backend authored this sentence from the HTTP status alone, so it
        // already names the condition (bad credentials, missing model, rate
        // limit). Forwarding it beats restating it less precisely here.
        return withDetail(err.code, err.message);
      case "http_stream_error":
      case "anthropic_stream_error":
        return withDetail(
          err.code,
          "The model closed the connection before finishing this response.",
        );
      case "rate_limited":
        return withDetail(
          err.code,
          "The model provider rate-limited this request. Try again shortly.",
        );
      default:
        return withDetail(err.code, "Omnesis could not complete this answer.");
    }
  }
  if (err instanceof AnswerCandidateLimitError) {
    return {
      code: "answer_too_large",
      message: "The generated answer exceeded Omnesis's review limit.",
    };
  }
  if (err instanceof AnswerCapacityError) {
    // The turn limit is reached only once the task row exists, so this refusal
    // is recorded like any other terminal condition. Naming it keeps the audit
    // from blaming the model for an answer Omnesis never attempted.
    return {
      code: "answer_capacity",
      message:
        "Omnesis was already running the most answers it allows at once, so this request was refused. Try again after one finishes.",
    };
  }
  if (err instanceof AnswerStoreError && err.code === "policy_changed") {
    return {
      code: "policy_changed",
      message: "The privacy policy changed while this answer was being checked.",
    };
  }
  return {
    code: "answer_generation_or_review_failed",
    message: "Omnesis could not complete this answer.",
  };
}

export function boundReleasedHistory(history: ReadonlyArray<ChatMessage>): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let characters = 0;
  for (let index = history.length - 1; index >= 0; index -= 2) {
    const pairStart = Math.max(0, index - 1);
    const pair = history.slice(pairStart, index + 1);
    const pairCharacters = pair.reduce(
      (total, message) =>
        total +
        message.parts.reduce(
          (partTotal, part) => partTotal + (part.kind === "text" ? part.text.length : 0),
          0,
        ),
      0,
    );
    if (
      kept.length + pair.length > MAX_RELEASED_HISTORY_MESSAGES ||
      characters + pairCharacters > MAX_RELEASED_HISTORY_CHARS
    ) {
      break;
    }
    kept.unshift(...pair);
    characters += pairCharacters;
  }
  return kept;
}

function combineReductionReviews(
  first: PrivacyReviewRecord,
  second: PrivacyReviewRecord,
): PrivacyReviewRecord {
  return {
    ...second,
    recipeVersion: `${first.recipeVersion}+reduction-check`,
    confidence:
      first.confidence === null || second.confidence === null
        ? null
        : Math.min(first.confidence, second.confidence),
    // Only the second-pass findings describe the reduced answer that is actually
    // released or held. The first pass classified the original (un-released)
    // candidate at its higher detail, so merging its findings here would let a
    // standing grant, minted from this record, cover more detail than the user
    // approved. The first-pass findings remain in their own audit event.
    findings: second.findings,
    rationale: `Reduction requested. Second-pass review: ${second.rationale}`,
  };
}

const MAX_REVIEW_HISTORY_CHARS = 80_000;
const MAX_REVIEW_HISTORY_MESSAGES = 20;

function boundReviewerHistory(history: ReadonlyArray<PrivacyExternalMessage>): {
  messages: PrivacyExternalMessage[];
  omittedTurns: number;
} {
  const kept: PrivacyExternalMessage[] = [];
  let characters = 0;
  for (let index = history.length - 1; index >= 0; index -= 2) {
    const pair = history.slice(Math.max(0, index - 1), index + 1);
    const pairCharacters = pair.reduce((total, message) => total + message.content.length, 0);
    if (
      kept.length + pair.length > MAX_REVIEW_HISTORY_MESSAGES ||
      characters + pairCharacters > MAX_REVIEW_HISTORY_CHARS
    ) {
      break;
    }
    kept.unshift(...pair);
    characters += pairCharacters;
  }
  return { messages: kept, omittedTurns: Math.max(0, (history.length - kept.length) / 2) };
}

function toChatHistory(history: ReadonlyArray<PrivacyExternalMessage>): ChatMessage[] {
  return history.map((message) => ({
    role: message.role,
    parts: [{ kind: "text", text: message.content }],
  }));
}

function preview(value: string): string {
  return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n...`;
}

function idPrefix(kind: Parameters<NonNullable<AnswerServiceDeps["idGen"]>>[0]): string {
  switch (kind) {
    case "workflow":
      return "wf";
    case "conversation":
      return "conv";
    case "task":
      return "task";
    case "approval":
      return "approval";
    case "release":
      return "release";
    default:
      return assertNever(kind);
  }
}

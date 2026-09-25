// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_RATE_LIMIT_PATIENCE } from "@omnesis/core";

import { directWriteGate } from "../write-gate.js";
import { AgentError } from "../agent/service.js";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import {
  AnswerCapacityError,
  AnswerCandidateLimitError,
  AnswerService,
  AnswerTaskInProgressError,
  MAX_ANSWER_CANDIDATE_CHARS,
  MAX_RELEASED_HISTORY_MESSAGES,
  boundReleasedHistory,
} from "./answer-service.js";
import {
  AnswerStoreError,
  createAnswerPrivacyTables,
  getPrivacyAuditEvent,
  listPrivacyAuditEvents,
  listPrivacyExchangePresentations,
  loadReleasedAnswerHistory,
  resolvePrivacyApproval,
} from "./store.js";
import {
  answerProfileReportSchema,
  recordAnswerQueueSpan,
  type AnswerProfiler,
} from "./answer-profile.js";
import type { AnswerServiceDeps } from "./answer-service.js";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";

const review: PrivacyReviewRecord = {
  recipeVersion: "privacy-reviewer-v1",
  provider: "test",
  model: "reviewer",
  confidence: 0.95,
  policyRevision: "policy-a",
  findings: [],
  rationale: "Test decision.",
};

describe("AnswerService", () => {
  let db: Database.Database;
  let id = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
    createAnswerPrivacyTables(db);
    id = 0;
  });

  function makeService(
    decisions: Array<{
      decision: "allow" | "reduce" | "ask" | "deny";
      reducedAnswer?: string;
      reductions?: string[];
      hardStop?: boolean;
    }>,
    options: {
      candidate?: string;
      policyCurrent?: boolean;
      maxConcurrentPerOwner?: number;
      maxConcurrentTotal?: number;
      writeGate?: AnswerServiceDeps["writeGate"];
      now?: () => number;
      escalationCooldownMs?: number;
      review?: PrivacyReviewRecord;
      reviews?: PrivacyReviewRecord[];
      reviewGate?: Promise<void>;
      onReviewStarted?: () => void;
      policyStore?: AnswerServiceDeps["policyStore"];
      /** Observe the candidate options (including a profiling sink) per call. */
      candidateHook?: (candidateOptions: unknown) => void;
      /** Observe the reviewer options (including a profiling sink) per call. */
      reviewHook?: (reviewOptions: unknown) => void;
    } = {},
  ) {
    const reviewRecord = options.review ?? review;
    const reviewQueue = [...(options.reviews ?? [])];
    const candidates = vi.fn(
      async (
        _question?: unknown,
        _history?: unknown,
        _signal?: unknown,
        _onTrace?: unknown,
        candidateOptions?: unknown,
      ) => {
        options.candidateHook?.(candidateOptions);
        return { answer: options.candidate ?? "Private candidate" };
      },
    );
    const reviewer = vi.fn(
      async (
        reviewInput: { reviewStage?: "initial" | "reduction" },
        _signal?: unknown,
        reviewOptions?: unknown,
      ) => {
        options.onReviewStarted?.();
        options.reviewHook?.(reviewOptions);
        if (options.reviewGate) await options.reviewGate;
        const next = decisions.shift();
        if (!next) throw new Error("unexpected review");
        const stage = reviewInput.reviewStage ?? "initial";
        const stageReview = reviewQueue.shift() ?? reviewRecord;
        return {
          decision: next.decision,
          ...(next.reducedAnswer ? { reducedAnswer: next.reducedAnswer } : {}),
          reductions: next.reductions ?? [],
          hardStop: next.hardStop ?? false,
          review: stageReview,
          audit: {
            stage,
            envelope: {
              releaseKind: "answer",
              userPolicy: { revision: "policy-a", text: "Synthetic policy" },
              workflowPurpose: null,
              currentRequest: request.question,
              priorExternalConversation: [],
              cumulativeDisclosure: {
                revision: 0,
                existenceRevision: 0,
                existenceSignals: 0,
                releasedTurns: 0,
                releasedCharacters: 0,
                olderTurnsOmitted: 0,
                categories: [],
              },
              reviewStage: stage,
              candidateAnswer: options.candidate ?? "Private candidate",
              watchDisclosure: null,
            },
            envelopeDigest: "audit-envelope",
            rawModelOutput: "{}",
            parsedModelOutput: {},
            fallbackReason: null,
            hardStop: next.hardStop ?? false,
          },
        };
      },
    );
    const notify = vi.fn(async () => undefined);
    const service = new AnswerService({
      db,
      writeGate: options.writeGate ?? directWriteGate(db),
      agent: { generateReadOnlyAnswerCandidate: candidates },
      reviewer: { review: reviewer },
      policyStore: options.policyStore ?? {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) =>
          options.policyCurrent === false ? null : operation(),
      },
      notifyApproval: notify,
      now: options.now ?? (() => 1_000),
      idGen: (kind) => `${kind}-${++id}`,
      maxConcurrentPerOwner: options.maxConcurrentPerOwner,
      maxConcurrentTotal: options.maxConcurrentTotal,
      escalationCooldownMs: options.escalationCooldownMs,
    });
    return { service, candidates, reviewer, notify };
  }

  const request = {
    ownerId: "token:external",
    question: "What is the synthetic answer?",
    clientRequestId: "request-1",
  };

  const answerAuthorization = (release: "reviewed" | "unreviewed") =>
    createCorpusAuthorization(
      {
        principalId: "principal-example",
        grantId: "grant-example",
        grantRevision: 1,
        credentialId: "credential-example",
        accessTokenId: "token-example",
      },
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["fictional:allowed"],
          releaseMode: release,
          policyFamilyId: release === "reviewed" ? "family-example" : null,
          policyRevision: release === "reviewed" ? "policy-a" : null,
          privacyPolicy: null,
        },
      ],
      "answer",
    )!;

  it("explicit unreviewed release skips only the reviewer and keeps scoped generation", async () => {
    const { service, candidates, reviewer } = makeService([]);
    const authorization = answerAuthorization("unreviewed");
    const response = await service.answer({ ...request, corpusAuthorization: authorization });
    expect(response).toMatchObject({ status: "released", answer: "Private candidate" });
    expect(reviewer).not.toHaveBeenCalled();
    expect(candidates).toHaveBeenCalledWith(request.question, [], undefined, expect.any(Function), {
      corpusAuthorization: authorization,
    });
    // No policy reviewed this release, so its record names none: a "Reviewed
    // under" line here would be the one place it is actively wrong.
    const stored = db
      .prepare<[], { review_json: string }>("SELECT review_json FROM answer_tasks")
      .all();
    expect(stored).toHaveLength(1);
    const record = JSON.parse(stored[0].review_json);
    expect(record.recipeVersion).toBe("explicit-unreviewed-v1");
    expect(record).not.toHaveProperty("policyFamilyId");
    expect(record).not.toHaveProperty("policyFamilyName");
  });

  it("profiles a reviewed run end to end when requested", async () => {
    const profilerOf = (options: unknown): AnswerProfiler | undefined =>
      (options as { profiler?: AnswerProfiler } | undefined)?.profiler;
    const { service } = makeService([{ decision: "allow" }], {
      candidateHook: (candidateOptions) => {
        const profiler = profilerOf(candidateOptions);
        profiler?.recordLlmCall("agent", {
          requestIndex: 1,
          ttftMs: 50,
          wallMs: 200,
          inputTokens: 100,
          outputTokens: 20,
        });
        profiler?.recordToolCall("search_documents", 30);
        profiler?.recordToolCall("search_documents", 10);
        // Ambient queue attribution propagates through the service run.
        recordAnswerQueueSpan("search-worker", 5, 25);
      },
      reviewHook: (reviewOptions) => {
        profilerOf(reviewOptions)?.recordLlmCall("reviewer", {
          requestIndex: 1,
          ttftMs: 20,
          wallMs: 100,
          inputTokens: 60,
          outputTokens: 12,
        });
      },
    });
    const { response, profile } = await service.answerWithProfile({
      ...request,
      profiling: true,
    });
    expect(response).toMatchObject({ status: "released", answer: "Private candidate" });
    expect(profile).not.toBeNull();
    expect(answerProfileReportSchema.safeParse(profile).success).toBe(true);
    expect(profile?.agent.calls).toBe(1);
    expect(profile?.agent.firstTtftMs).toBe(50);
    expect(profile?.agent.totalOutputTokens).toBe(20);
    expect(profile?.reviewer.calls).toBe(1);
    expect(profile?.reviewer.totalOutputTokens).toBe(12);
    expect(profile?.tools.byTool["search_documents"]).toMatchObject({
      calls: 2,
      totalMs: 40,
    });
    expect(profile?.queues.bySource["search-worker"]).toEqual({
      spans: 1,
      queueMs: 5,
      execMs: 25,
    });
    // The run touched the writer gate, and the profile says so.
    expect(profile?.store.calls).toBeGreaterThan(0);
    expect(profile?.totalWallMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a null profile unless profiling is requested", async () => {
    const { service } = makeService([{ decision: "allow" }]);
    const { profile } = await service.answerWithProfile({
      ...request,
      clientRequestId: "request-no-profile",
    });
    expect(profile).toBeNull();
  });

  it("reports a null profile on a duplicate poll even when profiling", async () => {
    const { service } = makeService([{ decision: "allow" }]);
    const first = await service.answerWithProfile({ ...request, profiling: true });
    expect(first.profile).not.toBeNull();
    const second = await service.answerWithProfile({ ...request, profiling: true });
    expect(second.response).toEqual(first.response);
    expect(second.profile).toBeNull();
  });

  it.each([
    {
      label: "allow",
      decisions: [{ decision: "allow" as const }],
      answer: "Private candidate",
      status: "released",
    },
    {
      label: "reduce",
      decisions: [
        {
          decision: "reduce" as const,
          reducedAnswer: "Generalized answer",
          reductions: ["Removed synthetic detail"],
        },
        { decision: "allow" as const },
      ],
      answer: "Generalized answer",
      status: "released_with_reductions",
    },
  ])(
    "reviewed named-family $label release ignores the unrelated default-file guard",
    async ({ decisions, answer, status }) => {
      const getFamily = vi.fn(async () => ({
        policy: "Named policy",
        revision: "policy-a",
        updatedAt: 1,
      }));
      const runFamilyIfRevision = vi.fn(async (_familyId, _revision, operation) =>
        operation({ policy: "Named policy", revision: "policy-a", updatedAt: 1 }),
      );
      const { service, reviewer } = makeService(decisions, {
        policyStore: {
          path: "/unused/synthetic-default-policy.md",
          get: async () => ({ policy: "Default canary", revision: "default", updatedAt: 1 }),
          runIfRevision: async (_revision, operation) => operation(),
          getFamily,
          runFamilyIfRevision,
        },
      });
      const response = await service.answer({
        ...request,
        corpusAuthorization: answerAuthorization("reviewed"),
      });
      expect(response).toMatchObject({ status, answer });
      expect(getFamily).toHaveBeenCalledWith("family-example");
      expect(reviewer.mock.calls[0]?.[0]).toMatchObject({
        policy: "Named policy",
        policyRevision: "policy-a",
      });
      expect(runFamilyIfRevision).toHaveBeenCalledWith(
        "family-example",
        "policy-a",
        expect.any(Function),
      );
    },
  );

  it("fails closed when a reviewed grant's selected family revision is unavailable", async () => {
    const { service, candidates, reviewer } = makeService([], {
      policyStore: {
        get: async () => ({ policy: "Default canary", revision: "default", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
        getFamily: async () => null,
        runFamilyIfRevision: async () => null,
      },
    });
    await expect(
      service.answer({ ...request, corpusAuthorization: answerAuthorization("reviewed") }),
    ).rejects.toThrow("unavailable or changed");
    expect(candidates).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("holds for explicit approval when the selected policy changes mid-review", async () => {
    const { service, notify } = makeService([{ decision: "allow" }], {
      policyStore: {
        get: async () => ({ policy: "Default canary", revision: "default", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
        getFamily: async () => ({ policy: "Named policy", revision: "policy-a", updatedAt: 1 }),
        runFamilyIfRevision: async () => null,
      },
    });
    const response = await service.answer({
      ...request,
      corpusAuthorization: answerAuthorization("reviewed"),
    });
    expect(response).toMatchObject({ status: "approval_required" });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("releases an allowed answer and passes only released history to a follow-up", async () => {
    const { service, candidates, reviewer } = makeService([
      { decision: "allow" },
      { decision: "allow" },
    ]);
    const first = await service.answer(request);
    expect(first).toMatchObject({ status: "released", answer: "Private candidate" });

    await service.answer({
      ...request,
      clientRequestId: "request-2",
      conversationId: first.conversationId,
      question: "A follow-up",
    });

    expect(candidates).toHaveBeenNthCalledWith(
      2,
      "A follow-up",
      [
        { role: "user", parts: [{ kind: "text", text: request.question }] },
        { role: "assistant", parts: [{ kind: "text", text: "Private candidate" }] },
      ],
      undefined,
      expect.any(Function),
      undefined,
    );
    expect(reviewer.mock.calls[1]?.[0]).toMatchObject({
      currentQuestion: "A follow-up",
      priorExternalConversation: [
        { role: "user", content: request.question },
        { role: "assistant", content: "Private candidate" },
      ],
      cumulativeDisclosure: { releasedTurns: 1 },
    });
  });

  it("passes immutable firing evidence scope only to the candidate generator", async () => {
    const { service, candidates } = makeService([{ decision: "allow" }]);

    await service.answer({
      ...request,
      evidenceDocumentIds: ["doc_fictional_evidence"],
    });

    expect(candidates).toHaveBeenCalledWith(request.question, [], undefined, expect.any(Function), {
      evidenceDocumentIds: ["doc_fictional_evidence"],
    });
  });

  it("passes existence-only watch evidence without synthesizing document ids", async () => {
    const { service, candidates } = makeService([{ decision: "allow" }]);
    const firingEvidence = {
      kind: "catalog-watch" as const,
      conditionSummary: "The approved fictional inventory condition became true",
      firedAt: 1_800_000_000_000,
    };

    await service.answer({
      ...request,
      firingEvidence,
    });

    expect(candidates).toHaveBeenCalledWith(request.question, [], undefined, expect.any(Function), {
      firingEvidence,
    });
    expect(JSON.stringify(candidates.mock.calls[0])).not.toContain("evidenceDocumentIds");
  });

  it("returns an opaque approval and notifies without releasing the candidate", async () => {
    const { service, notify } = makeService([{ decision: "ask" }]);
    const response = await service.answer(request);

    expect(response).toMatchObject({ status: "approval_required" });
    expect(JSON.stringify(response)).not.toContain("Private candidate");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("approval-"));
    expect(
      JSON.stringify(loadReleasedAnswerHistory(db, response.conversationId, request.ownerId)),
    ).not.toContain("Private candidate");
  });

  it("creates a durable way back for an answer it is about to hold", async () => {
    // The invariant this exists for, and the one the live failure broke: an
    // answer that can finish as `approval_required` must either carry a
    // durable post-approval route, keep a retrievable caller alive, or settle
    // as non-releasable. The firing-bound path did none of the three, so a
    // held answer was approved into nowhere.
    const { service } = makeService([{ decision: "ask" }]);
    // The route points at a real paired device, because the column does: a
    // route naming a device that does not exist is not a route.
    db.prepare("INSERT INTO devices (id) VALUES ('device_fictional')").run();
    const response = await service.answer({
      ...request,
      completionRoute: {
        integrationDeviceId: "device_fictional",
        nativeConversationId: "native_fictional",
      },
    });

    expect(response.status).toBe("approval_required");
    const delivery = db
      .prepare<
        [string],
        { integration_device_id: string; native_conversation_id: string; status: string }
      >("SELECT integration_device_id, native_conversation_id, status FROM answer_completion_deliveries WHERE task_id = ?")
      .get(response.taskId);
    expect(delivery, "a held answer was created with nothing scheduled to deliver it").toEqual({
      integration_device_id: "device_fictional",
      native_conversation_id: "native_fictional",
      status: "pending",
    });
  });

  it("schedules nothing when the caller left no way back", async () => {
    // A half-route is worse than none: the delivery worker would claim a row
    // it cannot address. The store creates one only for a complete route.
    const { service } = makeService([{ decision: "ask" }]);
    const response = await service.answer({ ...request });

    expect(response.status).toBe("approval_required");
    expect(
      db
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(*) AS count FROM answer_completion_deliveries WHERE task_id = ?")
        .get(response.taskId),
    ).toEqual({ count: 0 });
  });

  it("settles an approval-needed background answer without creating an approval", async () => {
    const { service, notify } = makeService([{ decision: "ask" }]);
    const response = await service.answer({ ...request, approvalMode: "never" });

    expect(response).toMatchObject({ status: "denied", reason: "approval_not_available" });
    expect(notify).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM answer_approvals").get()).toEqual({
      count: 0,
    });
    expect(
      JSON.stringify(loadReleasedAnswerHistory(db, response.conversationId, request.ownerId)),
    ).not.toContain("Private candidate");
  });

  it("coalesces escalation pushes for one caller within the cooldown", async () => {
    let clock = 1_000;
    const { service, notify } = makeService(
      [{ decision: "ask" }, { decision: "ask" }, { decision: "ask" }],
      { now: () => clock, escalationCooldownMs: 60_000 },
    );

    // First approval for this caller pushes.
    const first = await service.answer({ ...request, clientRequestId: "req-a" });
    expect(first.status).toBe("approval_required");
    // A second approval within the cooldown is stored but not pushed again.
    clock = 30_000;
    const second = await service.answer({ ...request, clientRequestId: "req-b" });
    expect(second.status).toBe("approval_required");
    expect(notify).toHaveBeenCalledTimes(1);

    // Once the cooldown has elapsed, the caller may push again.
    clock = 1_000 + 60_000;
    await service.answer({ ...request, clientRequestId: "req-c" });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("escalates independently for different callers", async () => {
    const { service, notify } = makeService([{ decision: "ask" }, { decision: "ask" }], {
      escalationCooldownMs: 60_000,
    });

    await service.answer({ ...request, ownerId: "token:a", clientRequestId: "req-a" });
    await service.answer({ ...request, ownerId: "token:b", clientRequestId: "req-b" });

    // One caller's cooldown never suppresses another caller's first push.
    expect(notify).toHaveBeenCalledTimes(2);
  });

  // Mirrors what the real reviewer stamps on a confident policy hold: decision
  // "ask" carries fallbackCause "policy_requires_review" (see reviewer.ts).
  const coveringReview: PrivacyReviewRecord = {
    recipeVersion: "privacy-reviewer-v2",
    provider: "test",
    model: "reviewer",
    confidence: 0.95,
    policyRevision: "policy-a",
    fallbackCause: "policy_requires_review",
    findings: [
      {
        category: "Schedule",
        detailLevel: "exact",
        subject: "user",
        disposition: "approval",
        description: "An exact schedule detail.",
      },
    ],
    rationale: "Exact schedule needs approval.",
  };

  it("requires a fresh approval for a later answer in the same workflow", async () => {
    const { service, notify } = makeService([{ decision: "ask" }, { decision: "ask" }], {
      review: coveringReview,
    });

    const first = await service.answer({ ...request, clientRequestId: "approval-1" });
    expect(first.status).toBe("approval_required");
    resolvePrivacyApproval(db, {
      approvalId: (first as { approvalId: string }).approvalId,
      action: "approve",
      requestContext: { requestId: "req", tokenId: null, deviceId: null },
      releaseId: "release-first",
      now: 1_000,
    });
    expect(db.prepare("SELECT id FROM answer_workflow_grants").all()).toEqual([]);

    // The legacy ledger is inert: its rows are historical records, never live
    // authorization for a later answer.
    db.prepare(
      `INSERT INTO answer_workflow_grants (
         id, workflow_id, owner_id, approval_id, category, category_key,
         subject, max_detail_level, policy_revision, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-grant",
      first.workflowId,
      request.ownerId,
      (first as { approvalId: string }).approvalId,
      "schedule",
      "schedule",
      "user",
      "exact",
      "policy-a",
      1_000,
      100_000,
    );

    const second = await service.answer({
      ...request,
      clientRequestId: "approval-2",
      workflowId: first.workflowId,
      conversationId: undefined,
      question: "And the following week?",
    });
    expect(second.status).toBe("approval_required");
    // The approval exists even though the per-owner push cooldown suppresses a
    // second notification in the same minute.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh approval for every detected credential", async () => {
    const candidate = `Bearer ${"synthetic_token_value_1234567890"}`;
    const credentialReview: PrivacyReviewRecord = {
      ...coveringReview,
      credentialApprovalRequired: true,
      findings: [
        {
          category: "bearer_token",
          detailLevel: "original",
          subject: "unknown",
          disposition: "approval",
          description: "A detected credential requires explicit approval for this request.",
        },
      ],
    };
    const { service, notify } = makeService([{ decision: "ask" }, { decision: "ask" }], {
      candidate,
      review: credentialReview,
    });

    const first = await service.answer({ ...request, clientRequestId: "credential-1" });
    expect(first.status).toBe("approval_required");
    resolvePrivacyApproval(db, {
      approvalId: (first as { approvalId: string }).approvalId,
      action: "approve",
      requestContext: { requestId: "req", tokenId: null, deviceId: null },
      releaseId: "release-credential",
      now: 1_000,
    });

    const second = await service.answer({
      ...request,
      clientRequestId: "credential-2",
      workflowId: first.workflowId,
      conversationId: undefined,
    });
    expect(second.status).toBe("approval_required");
    // The second approval still exists even though the per-owner push cooldown
    // suppresses a duplicate notification.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reviews a reduction a second time before release", async () => {
    const { service, reviewer } = makeService([
      {
        decision: "reduce",
        reducedAnswer: "Generalized answer",
        reductions: ["Removed precise location"],
      },
      { decision: "allow" },
    ]);

    const response = await service.answer(request);

    expect(response).toMatchObject({
      status: "released_with_reductions",
      answer: "Generalized answer",
      reductions: ["Removed precise location"],
    });
    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(reviewer.mock.calls[1]?.[0]).toMatchObject({ candidateAnswer: "Generalized answer" });
    // Both passes run inside the task, so both wait out a quota reset.
    expect(reviewer.mock.calls.map((call) => call[2])).toEqual([
      { rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE },
      { rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE },
    ]);
  });

  describe("the policy family on the record", () => {
    const family = { id: "00000000-0000-4000-8000-000000000001", name: "Default policy" };
    const familyReview: PrivacyReviewRecord = {
      ...review,
      policyFamilyId: family.id,
      policyFamilyName: family.name,
    };
    const defaultFamilyStore: AnswerServiceDeps["policyStore"] = {
      get: async () => ({
        policy: "Synthetic policy",
        revision: "policy-a",
        updatedAt: 1,
        familyId: family.id,
        familyName: family.name,
      }),
      runIfRevision: async (_revision, operation) => operation(),
    };

    it.each([
      { label: "released", decisions: [{ decision: "allow" as const }], status: "released" },
      {
        label: "released with reductions",
        decisions: [
          { decision: "reduce" as const, reducedAnswer: "Generalized answer" },
          { decision: "allow" as const },
        ],
        status: "released_with_reductions",
      },
      { label: "held", decisions: [{ decision: "ask" as const }], status: "approval_required" },
      { label: "denied", decisions: [{ decision: "deny" as const }], status: "denied" },
    ])(
      "tells every review which family governs and keeps it on a $label record",
      async ({ decisions, status }) => {
        const reviews = decisions.length;
        const { service, reviewer } = makeService(decisions, {
          review: familyReview,
          policyStore: defaultFamilyStore,
        });
        const response = await service.answer(request);
        expect(response.status).toBe(status);
        expect(reviewer).toHaveBeenCalledTimes(reviews);
        for (const call of reviewer.mock.calls) {
          expect(call[0]).toMatchObject({ policyRevision: "policy-a", policyFamily: family });
        }
        const exchange = listPrivacyExchangePresentations(db, response.conversationId)
          ?.exchanges[0];
        expect(exchange?.review).toMatchObject({
          policyFamilyId: family.id,
          policyFamilyName: family.name,
        });
      },
    );

    it("names a grant-selected family from its own document", async () => {
      const named = {
        policy: "Named policy",
        revision: "policy-a",
        updatedAt: 1,
        familyId: "family-example",
        familyName: "Fictional research policy",
      };
      const { service, reviewer } = makeService([{ decision: "allow" }], {
        policyStore: {
          get: async () => ({ policy: "Default canary", revision: "default", updatedAt: 1 }),
          runIfRevision: async (_revision, operation) => operation(),
          getFamily: async () => named,
          runFamilyIfRevision: async (_familyId, _revision, operation) => operation(named),
        },
      });
      await service.answer({ ...request, corpusAuthorization: answerAuthorization("reviewed") });
      expect(reviewer.mock.calls[0]?.[0]).toMatchObject({
        policyFamily: { id: "family-example", name: "Fictional research policy" },
      });
    });

    it("names no family for a document without one, and reads an older record as written", async () => {
      const { service, reviewer } = makeService([{ decision: "allow" }]);
      const response = await service.answer(request);
      expect(reviewer.mock.calls[0]?.[0]).not.toHaveProperty("policyFamily");
      const exchange = listPrivacyExchangePresentations(db, response.conversationId)?.exchanges[0];
      expect(exchange?.review).toMatchObject({ rationale: review.rationale });
      expect(exchange?.review).not.toHaveProperty("policyFamilyId");
      expect(exchange?.review).not.toHaveProperty("policyFamilyName");
    });
  });

  it("denies without exposing or retaining the candidate in released history", async () => {
    const { service } = makeService([{ decision: "deny", hardStop: true }]);
    const response = await service.answer(request);

    expect(response).toMatchObject({ status: "denied", reason: "hard_stop" });
    expect(JSON.stringify(response)).not.toContain("Private candidate");
    expect(
      JSON.stringify(loadReleasedAnswerHistory(db, response.conversationId, request.ownerId)),
    ).not.toContain("Private candidate");
    const candidateEvent = listPrivacyAuditEvents(db, response.conversationId, 20)?.events.find(
      (event) => event.kind === "candidate_generated",
    );
    expect(candidateEvent).toBeDefined();
    expect(
      getPrivacyAuditEvent(db, response.conversationId, candidateEvent!.id)?.payload,
    ).toMatchObject({ candidateAnswer: "Private candidate" });
  });

  it("inherits the stored workflow purpose on follow-up reviews", async () => {
    const { service, reviewer } = makeService([{ decision: "allow" }, { decision: "allow" }]);
    const first = await service.answer({
      ...request,
      workflowPurpose: "Prepare a fictional quarterly planning summary.",
    });

    await service.answer({
      ...request,
      clientRequestId: "request-2",
      conversationId: first.conversationId,
      question: "A follow-up",
    });

    expect(reviewer.mock.calls[1]?.[0]).toMatchObject({
      workflowPurpose: "Prepare a fictional quarterly planning summary.",
    });
  });

  it("holds an otherwise allowed answer when the policy changed during review", async () => {
    const { service, notify } = makeService([{ decision: "allow" }], {
      policyCurrent: false,
    });

    const response = await service.answer(request);

    expect(response.status).toBe("approval_required");
    expect(notify).toHaveBeenCalledOnce();
    expect(loadReleasedAnswerHistory(db, response.conversationId, request.ownerId)).toEqual([]);
  });

  it("holds an answer when a direct policy edit is detected at the release commit", async () => {
    const direct = directWriteGate(db);
    const writeGate: AnswerServiceDeps["writeGate"] = {
      ...direct,
      completeAnswerTask: async (input) => {
        if (input.outcome.kind === "release" || input.outcome.kind === "reduce") {
          throw new AnswerStoreError(
            "policy_changed",
            "The privacy policy changed while the answer was being reviewed.",
          );
        }
        return direct.completeAnswerTask(input);
      },
    };
    const { service, notify } = makeService([{ decision: "allow" }], { writeGate });

    const response = await service.answer(request);

    expect(response.status).toBe("approval_required");
    expect(notify).toHaveBeenCalledOnce();
    expect(loadReleasedAnswerHistory(db, response.conversationId, request.ownerId)).toEqual([]);
  });

  it("reviews again before release when another turn advances workflow disclosure", async () => {
    const direct = directWriteGate(db);
    let injectedConcurrentRelease = false;
    const writeGate: AnswerServiceDeps["writeGate"] = {
      ...direct,
      completeAnswerTask: async (input) => {
        if (
          !injectedConcurrentRelease &&
          (input.outcome.kind === "release" || input.outcome.kind === "reduce")
        ) {
          injectedConcurrentRelease = true;
          db.prepare(
            `UPDATE answer_workflow_disclosure
                SET revision = 1,
                    released_turns = 1,
                    released_characters = 24,
                    categories_json = '[{"category":"schedule","count":1}]'
              WHERE workflow_id = (
                SELECT workflow_id FROM answer_tasks WHERE id = ?
              )`,
          ).run(input.taskId);
        }
        return direct.completeAnswerTask(input);
      },
    };
    const { service, reviewer } = makeService([{ decision: "allow" }, { decision: "allow" }], {
      writeGate,
    });

    await expect(service.answer(request)).resolves.toMatchObject({ status: "released" });

    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(reviewer.mock.calls[1]?.[0]).toMatchObject({
      cumulativeDisclosure: {
        revision: 1,
        releasedTurns: 1,
        releasedCharacters: 24,
      },
    });
  });

  it("reviews again when a watch fires during answer review", async () => {
    db.exec(`CREATE TABLE subscription_workflow_disclosure (
      workflow_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      existence_signals INTEGER NOT NULL DEFAULT 0,
      categories_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )`);
    const direct = directWriteGate(db);
    let injectedFiring = false;
    const writeGate: AnswerServiceDeps["writeGate"] = {
      ...direct,
      completeAnswerTask: async (input) => {
        if (
          !injectedFiring &&
          (input.outcome.kind === "release" || input.outcome.kind === "reduce")
        ) {
          injectedFiring = true;
          const workflowId = db
            .prepare<
              [string],
              { workflow_id: string }
            >("SELECT workflow_id FROM answer_tasks WHERE id = ?")
            .get(input.taskId)!.workflow_id;
          db.prepare(
            `INSERT INTO subscription_workflow_disclosure
               (workflow_id, revision, existence_signals, categories_json, updated_at)
             VALUES (?, 1, 1, '[{"category":"documents","detailLevel":"existence","subject":"unknown","count":1}]', 1000)`,
          ).run(workflowId);
        }
        return direct.completeAnswerTask(input);
      },
    };
    const { service, reviewer } = makeService([{ decision: "allow" }, { decision: "allow" }], {
      writeGate,
    });

    await expect(service.answer(request)).resolves.toMatchObject({ status: "released" });
    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(reviewer.mock.calls[1]?.[0]).toMatchObject({
      cumulativeDisclosure: {
        existenceRevision: 1,
        existenceSignals: 1,
        categories: [
          { category: "documents", detailLevel: "existence", subject: "unknown", count: 1 },
        ],
      },
    });
  });

  it("rejects a candidate above the privacy review limit", async () => {
    const { service, reviewer } = makeService([{ decision: "allow" }], {
      candidate: "x".repeat(MAX_ANSWER_CANDIDATE_CHARS + 1),
    });

    await expect(service.answer(request)).rejects.toBeInstanceOf(AnswerCandidateLimitError);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("exposes the recorded draft while the privacy review is still running", async () => {
    const reviewStarted = Promise.withResolvers<void>();
    const reviewGate = Promise.withResolvers<void>();
    const { service } = makeService([{ decision: "allow" }], {
      candidate: "An invented local draft.",
      reviewGate: reviewGate.promise,
      onReviewStarted: reviewStarted.resolve,
    });

    const answer = service.answer(request);
    try {
      await reviewStarted.promise;
      const conversation = db
        .prepare<[], { id: string }>("SELECT id FROM answer_conversations")
        .get();
      const exchange = listPrivacyExchangePresentations(db, conversation!.id)?.exchanges[0];

      expect(exchange).toMatchObject({
        status: "running",
        outcome: "checking",
        draftAnswer: "An invented local draft.",
        sharedAnswer: null,
      });
    } finally {
      reviewGate.resolve();
    }
    await expect(answer).resolves.toMatchObject({ status: "released" });
  });

  it("persists a partial trusted trace before marking a failed answer", async () => {
    const service = new AnswerService({
      db,
      writeGate: directWriteGate(db),
      agent: {
        generateReadOnlyAnswerCandidate: vi.fn(async (_question, _history, _signal, onTrace) => {
          onTrace?.({
            provider: "synthetic-provider",
            model: "synthetic-model",
            sessionId: "trace-session",
            messages: [{ role: "assistant", parts: [{ kind: "tool_use", tool: "search" }] }],
            subagentEvents: [],
            terminalStopReason: "error",
          });
          throw new Error("synthetic model failure");
        }),
      },
      reviewer: { review: vi.fn() },
      policyStore: {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
      },
      now: () => 1_000,
      idGen: (kind) => `${kind}-${++id}`,
    });

    await expect(service.answer(request)).rejects.toThrow("synthetic model failure");
    const conversation = db
      .prepare<[], { id: string }>("SELECT id FROM answer_conversations")
      .get();
    const events = listPrivacyAuditEvents(db, conversation!.id, 20)?.events ?? [];
    expect(events.map((event) => event.kind)).toEqual([
      "external_request",
      "agent_trace",
      "failed",
    ]);
    expect(events[1]?.display.detail).toBe("Omnesis could not complete this answer.");
    expect(events[2]?.display.text).toBe("Omnesis could not complete this answer.");
  });

  it("persists the safe empty-model-response reason for exchange presentation", async () => {
    const service = new AnswerService({
      db,
      writeGate: directWriteGate(db),
      agent: {
        generateReadOnlyAnswerCandidate: vi.fn(async () => {
          throw new AgentError(
            "http_empty_response",
            "Model returned an empty response (finish_reason=length).",
          );
        }),
      },
      reviewer: { review: vi.fn() },
      policyStore: {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
      },
      now: () => 1_000,
      idGen: (kind) => `${kind}-${++id}`,
    });

    await expect(service.answer(request)).rejects.toMatchObject({ code: "http_empty_response" });
    const conversation = db
      .prepare<[], { id: string }>("SELECT id FROM answer_conversations")
      .get();
    const failed = listPrivacyAuditEvents(db, conversation!.id, 20)?.events.at(-1);
    expect(failed?.display.text).toBe(
      "The model returned an empty response (finish_reason=length) before producing a final answer.",
    );
  });

  it("persists and presents a typed request timeout without backend diagnostics", async () => {
    const privateDiagnostic = "upstream timeout detail that must remain private";
    const service = new AnswerService({
      db,
      writeGate: directWriteGate(db),
      agent: {
        generateReadOnlyAnswerCandidate: vi.fn(async () => {
          throw new AgentError("http_request_timeout", privateDiagnostic);
        }),
      },
      reviewer: { review: vi.fn() },
      policyStore: {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
      },
      now: () => 1_000,
      idGen: (kind) => `${kind}-${++id}`,
    });

    await expect(service.answer(request)).rejects.toMatchObject({ code: "http_request_timeout" });
    const conversation = db
      .prepare<[], { id: string }>("SELECT id FROM answer_conversations")
      .get();
    const exchange = listPrivacyExchangePresentations(db, conversation!.id)?.exchanges[0];
    expect(exchange?.failure).toEqual({
      code: "http_request_timeout",
      message: "The model did not respond within the request deadline. Try this answer again.",
      stage: "answer_generation",
    });
    expect(JSON.stringify(exchange)).not.toContain(privateDiagnostic);
  });

  it("does not persist an arbitrary AgentError message into the privacy audit", async () => {
    const service = new AnswerService({
      db,
      writeGate: directWriteGate(db),
      agent: {
        generateReadOnlyAnswerCandidate: vi.fn(async () => {
          throw new AgentError("provider_error", "upstream diagnostic that must remain private");
        }),
      },
      reviewer: { review: vi.fn() },
      policyStore: {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
      },
      now: () => 1_000,
      idGen: (kind) => `${kind}-${++id}`,
    });

    await expect(service.answer(request)).rejects.toMatchObject({ code: "provider_error" });
    const conversation = db
      .prepare<[], { id: string }>("SELECT id FROM answer_conversations")
      .get();
    const failed = listPrivacyAuditEvents(db, conversation!.id, 20)?.events.at(-1);
    expect(failed?.display.text).toBe("Omnesis could not complete this answer.");
  });

  it("surfaces the provider's disposition for a rejected model request", async () => {
    const service = new AnswerService({
      db,
      writeGate: directWriteGate(db),
      agent: {
        generateReadOnlyAnswerCandidate: vi.fn(async () => {
          throw new AgentError(
            "http_api_error",
            "The model provider does not have the assigned model — check the model assignment (HTTP 404).",
            { status: 404, type: "invalid_request_error", code: "NOT_FOUND", param: "model" },
          );
        }),
      },
      reviewer: { review: vi.fn() },
      policyStore: {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
      },
      now: () => 1_000,
      idGen: (kind) => `${kind}-${++id}`,
    });

    await expect(service.answer(request)).rejects.toMatchObject({ code: "http_api_error" });
    const conversation = db
      .prepare<[], { id: string }>("SELECT id FROM answer_conversations")
      .get();
    const exchange = listPrivacyExchangePresentations(db, conversation!.id)?.exchanges[0];
    // A 404 on the assigned model reads as a 404 on the assigned model, rather
    // than as the same sentence every other provider failure produces.
    expect(exchange?.failure).toEqual({
      code: "http_api_error",
      message:
        "The model provider does not have the assigned model — check the model assignment (HTTP 404).",
      detail: "HTTP 404 · NOT_FOUND · param=model",
      stage: "answer_generation",
    });
  });

  it("caps concurrent requests per caller", async () => {
    let releaseCandidate: () => void = () => {};
    let candidateStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      candidateStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    const service = new AnswerService({
      db,
      writeGate: directWriteGate(db),
      agent: {
        generateReadOnlyAnswerCandidate: vi.fn(async () => {
          candidateStarted();
          await gate;
          return { answer: "Synthetic answer" };
        }),
      },
      reviewer: {
        review: vi.fn(async () => ({
          decision: "allow" as const,
          reductions: [],
          hardStop: false,
          review,
          audit: {
            stage: "initial" as const,
            envelope: {
              releaseKind: "answer" as const,
              userPolicy: { revision: "policy-a", text: "Synthetic policy" },
              workflowPurpose: null,
              currentRequest: request.question,
              priorExternalConversation: [],
              cumulativeDisclosure: {
                revision: 0,
                existenceRevision: 0,
                existenceSignals: 0,
                releasedTurns: 0,
                releasedCharacters: 0,
                olderTurnsOmitted: 0,
                categories: [],
              },
              reviewStage: "initial" as const,
              candidateAnswer: "Synthetic answer",
              watchDisclosure: null,
            },
            envelopeDigest: "audit-envelope",
            rawModelOutput: "{}",
            parsedModelOutput: {},
            fallbackReason: null,
            hardStop: false,
          },
        })),
      },
      policyStore: {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
      },
      maxConcurrentPerOwner: 1,
      maxConcurrentTotal: 2,
      now: () => 1_000,
      idGen: (kind) => `${kind}-${++id}`,
    });
    const first = service.answer(request);
    await started;

    await expect(
      service.answer({ ...request, clientRequestId: "request-2" }),
    ).rejects.toBeInstanceOf(AnswerCapacityError);
    releaseCandidate();
    await expect(first).resolves.toMatchObject({ status: "released" });
  });

  // Capacity bounds concurrent agent turns. These three cases are the ones
  // that made a slow gateway refuse work it was not doing: a request queued
  // behind the writer, a poll of an ask already running, and a turn that
  // ended by failing. All three must leave the limit untouched.
  it("does not spend capacity while a new ask is queued behind the writer", async () => {
    let releaseWriter: () => void = () => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const base = directWriteGate(db);
    let queued = 0;
    const gatedWriteGate: AnswerServiceDeps["writeGate"] = {
      ...base,
      beginAnswerTask: async (input) => {
        queued += 1;
        await writerGate;
        return base.beginAnswerTask(input);
      },
    };
    // Production limits. Three distinct asks all park in the writer queue.
    const { service } = makeService([{ decision: "allow" }, { decision: "allow" }], {
      writeGate: gatedWriteGate,
      maxConcurrentPerOwner: 2,
      maxConcurrentTotal: 16,
    });
    const first = service.answer({ ...request, clientRequestId: "queued-1" });
    const second = service.answer({ ...request, clientRequestId: "queued-2" });
    await vi.waitFor(() => expect(queued).toBe(2));

    // The third ask arrives while the other two are parked. Holding a slot
    // for a request that is only waiting would refuse this one outright.
    const third = service.answer({ ...request, clientRequestId: "queued-3" });
    await vi.waitFor(() => expect(queued).toBe(3));

    // Reaching the writer at all is the regression: holding a slot for a
    // request that is merely waiting would have refused this one outright,
    // before it ever got here.
    releaseWriter();
    await expect(first).resolves.toMatchObject({ status: "released" });
    await expect(second).resolves.toMatchObject({ status: "released" });
    // Once all three unpark they compete for two turns, so the third may
    // legitimately be refused now — it is settled here only so the run has
    // no dangling rejection.
    await third.catch(() => undefined);
  });

  /**
   * The check before the writer reserves nothing, so two new asks can both
   * pass it and then compete for the one remaining turn. The loser must fail
   * cleanly — a refusal the caller can act on, and no task left in `running`
   * that nothing will ever finish.
   */
  it("fails the loser of a capacity race cleanly, leaving no running task", async () => {
    let releaseWriter: () => void = () => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const base = directWriteGate(db);
    let queued = 0;
    const gatedWriteGate: AnswerServiceDeps["writeGate"] = {
      ...base,
      beginAnswerTask: async (input) => {
        queued += 1;
        await writerGate;
        return base.beginAnswerTask(input);
      },
    };
    const { service } = makeService([{ decision: "allow" }, { decision: "allow" }], {
      writeGate: gatedWriteGate,
      maxConcurrentPerOwner: 1,
      maxConcurrentTotal: 1,
    });

    // Both are new asks and both reach the writer, so both cleared the check
    // that happens before it. Only one of them can hold the single turn.
    const first = service.answer({ ...request, clientRequestId: "race-1" });
    const second = service.answer({ ...request, clientRequestId: "race-2" });
    await vi.waitFor(() => expect(queued).toBe(2));
    releaseWriter();

    const outcomes = await Promise.all([
      first.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      second.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    const won = outcomes.filter((o) => o.ok);
    const lost = outcomes.filter((o) => !o.ok);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].ok === false && lost[0].error).toBeInstanceOf(AnswerCapacityError);

    // The refusal is a settled outcome for the task too. A task stuck in
    // `running` would keep answering later polls with "still working" for
    // as long as the row lives.
    const running = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM answer_tasks WHERE status = 'running'")
      .get();
    expect(running?.n).toBe(0);

    // And the winner gave its turn back, so the next ask is servable.
    await expect(service.answer({ ...request, clientRequestId: "race-3" })).resolves.toMatchObject({
      status: "released",
    });
  });

  it("answers a repeat of a running ask without spending capacity", async () => {
    let releaseCandidate: () => void = () => {};
    const candidateGate = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    let started = 0;
    const service = new AnswerService({
      db,
      writeGate: directWriteGate(db),
      agent: {
        generateReadOnlyAnswerCandidate: async () => {
          started += 1;
          await candidateGate;
          return { answer: "Private candidate" };
        },
      },
      reviewer: {
        review: async () => ({
          decision: "allow" as const,
          reductions: [],
          hardStop: false,
          review,
          audit: {
            stage: "initial" as const,
            envelope: {
              releaseKind: "answer" as const,
              userPolicy: { revision: "policy-a", text: "Synthetic policy" },
              workflowPurpose: null,
              currentRequest: request.question,
              priorExternalConversation: [],
              cumulativeDisclosure: {
                revision: 0,
                existenceRevision: 0,
                existenceSignals: 0,
                releasedTurns: 0,
                releasedCharacters: 0,
                olderTurnsOmitted: 0,
                categories: [],
              },
              reviewStage: "initial" as const,
              candidateAnswer: "Private candidate",
              watchDisclosure: null,
            },
            envelopeDigest: "audit-envelope",
            rawModelOutput: "{}",
            parsedModelOutput: {},
            fallbackReason: null,
            hardStop: false,
          },
        }),
      },
      policyStore: {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
      },
      // One turn per owner: the ask below occupies the entire budget.
      maxConcurrentPerOwner: 1,
      maxConcurrentTotal: 2,
      now: () => 1_000,
      idGen: (kind) => `${kind}-${++id}`,
    });

    const inFlight = service.answer(request);
    await vi.waitFor(() => expect(started).toBe(1));

    // The same ask again, while the owner is at its limit. This is a poll,
    // not new work: it must report the running task, never a capacity refusal.
    await expect(service.answer(request)).rejects.toBeInstanceOf(AnswerTaskInProgressError);
    expect(started).toBe(1);

    releaseCandidate();
    await expect(inFlight).resolves.toMatchObject({ status: "released" });

    // And the budget came back: a fresh ask is admitted afterwards.
    const after = await service.answer({ ...request, clientRequestId: "after" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(after).not.toBeInstanceOf(AnswerCapacityError);
  });

  it("returns capacity when a turn ends by failing", async () => {
    const { service } = makeService([], {
      maxConcurrentPerOwner: 1,
      maxConcurrentTotal: 1,
    });
    // No review queued, so the turn throws inside the guarded section.
    await expect(service.answer(request)).rejects.toBeTruthy();
    // A second ask proves the failed turn released its slot rather than
    // wedging the owner out of the gateway until restart.
    const second = await service.answer({ ...request, clientRequestId: "request-2" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(second).not.toBeInstanceOf(AnswerCapacityError);
  });

  /**
   * A retry of a previously failed ask skips the pre-writer capacity check —
   * the task already exists, so the ask looks like a poll — and only meets the
   * limit once its row is back in `running`. The refusal is then recorded like
   * any other terminal condition, so the audit must say the gateway was busy
   * rather than blaming the model for an answer it never attempted.
   */
  it("records a capacity refusal raised after the task exists as a capacity refusal", async () => {
    let releaseHolder: () => void = () => {};
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let candidateCalls = 0;
    let holderStarted = 0;
    const service = new AnswerService({
      db,
      writeGate: directWriteGate(db),
      agent: {
        generateReadOnlyAnswerCandidate: vi.fn(async () => {
          candidateCalls += 1;
          // The first ask fails, leaving a task a retry can restart.
          if (candidateCalls === 1) {
            throw new AgentError("http_request_timeout", "first attempt timed out");
          }
          holderStarted += 1;
          await holderGate;
          return { answer: "Private candidate" };
        }),
      },
      reviewer: {
        review: vi.fn(async () => ({
          decision: "allow" as const,
          reductions: [],
          hardStop: false,
          review,
          audit: {
            stage: "initial" as const,
            envelope: {
              releaseKind: "answer" as const,
              userPolicy: { revision: "policy-a", text: "Synthetic policy" },
              workflowPurpose: null,
              currentRequest: request.question,
              priorExternalConversation: [],
              cumulativeDisclosure: {
                revision: 0,
                existenceRevision: 0,
                existenceSignals: 0,
                releasedTurns: 0,
                releasedCharacters: 0,
                olderTurnsOmitted: 0,
                categories: [],
              },
              reviewStage: "initial" as const,
              candidateAnswer: "Private candidate",
              watchDisclosure: null,
            },
            envelopeDigest: "audit-envelope",
            rawModelOutput: "{}",
            parsedModelOutput: {},
            fallbackReason: null,
            hardStop: false,
          },
        })),
      },
      policyStore: {
        get: async () => ({ policy: "Synthetic policy", revision: "policy-a", updatedAt: 1 }),
        runIfRevision: async (_revision, operation) => operation(),
      },
      // One turn per owner: the held ask below occupies the whole budget.
      maxConcurrentPerOwner: 1,
      maxConcurrentTotal: 2,
      now: () => 1_000,
      idGen: (kind) => `${kind}-${++id}`,
    });

    const retried = { ...request, clientRequestId: "capacity-retry" };
    await expect(service.answer(retried)).rejects.toMatchObject({ code: "http_request_timeout" });

    // A second, unrelated ask takes the owner's only turn and keeps it.
    const holder = service.answer({ ...request, clientRequestId: "capacity-holder" });
    await vi.waitFor(() => expect(holderStarted).toBe(1));

    // The retry restarts its existing row, then meets the limit — a refusal
    // raised after the task exists, so it is recorded rather than only thrown.
    await expect(service.answer(retried)).rejects.toBeInstanceOf(AnswerCapacityError);
    expect(candidateCalls).toBe(2);

    const conversationId = db
      .prepare<
        [string],
        { conversation_id: string }
      >("SELECT conversation_id FROM answer_tasks WHERE client_request_id = ?")
      .get("capacity-retry")?.conversation_id;
    expect(conversationId).toBeTypeOf("string");
    const failed = listPrivacyAuditEvents(db, conversationId!, 20)?.events.at(-1);
    expect(failed?.kind).toBe("failed");
    expect(failed?.display.text).toBe(
      "Omnesis was already running the most answers it allows at once, so this request was refused. Try again after one finishes.",
    );
    const exchange = listPrivacyExchangePresentations(db, conversationId!)?.exchanges[0];
    expect(exchange?.failure).toMatchObject({ code: "answer_capacity" });

    releaseHolder();
    await expect(holder).resolves.toMatchObject({ status: "released" });
  });

  it("keeps only the newest complete released turns in model context", () => {
    const history = Array.from({ length: MAX_RELEASED_HISTORY_MESSAGES + 2 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      parts: [{ kind: "text" as const, text: `message-${index}` }],
    }));

    const bounded = boundReleasedHistory(history);

    expect(bounded).toHaveLength(MAX_RELEASED_HISTORY_MESSAGES);
    expect(bounded[0]?.parts).toEqual([{ kind: "text", text: "message-2" }]);
    expect(bounded.at(-1)?.parts).toEqual([{ kind: "text", text: "message-41" }]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnswerStoreError,
  beginAnswerTask,
  completeAnswerTask,
  createAnswerPrivacyTables,
  digestCandidate,
  expirePrivacyApprovals,
  failAnswerTask,
  getAnswerTaskResponse,
  getPrivacyApproval,
  getPrivacyAuditEvent,
  listPrivacyApprovals,
  listPrivacyAuditEvents,
  loadReleasedAnswerHistory,
  recoverInterruptedAnswerTasks,
  resolvePrivacyApproval,
} from "./store.js";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";

const review: PrivacyReviewRecord = {
  recipeVersion: "privacy-reviewer-v1",
  provider: "test",
  model: "reviewer",
  confidence: 0.98,
  policyRevision: "policy-a",
  findings: [
    {
      category: "schedule",
      detailLevel: "summary",
      subject: "user",
      disposition: "allow",
      description: "General availability.",
    },
  ],
  rationale: "Allowed by the schedule-summary rule.",
};

const resolutionRequest = {
  requestId: "request-admin-1",
  tokenId: "token-admin-1",
  deviceId: "device-admin-1",
};

describe("answer privacy store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // Completion routes are device-bound in the full gateway schema. The
    // privacy-store harness deliberately builds only its local tables, so it
    // supplies the referenced parent shape without coupling these tests to
    // the gateway's unrelated device repository.
    db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
    createAnswerPrivacyTables(db);
  });

  afterEach(() => db.close());

  function begin(overrides: Partial<Parameters<typeof beginAnswerTask>[1]> = {}) {
    return beginAnswerTask(db, {
      ownerId: "token:external",
      clientRequestId: "request-1",
      question: "When am I available?",
      ids: {
        workflowId: "wf-1",
        conversationId: "conv-1",
        taskId: "task-1",
      },
      now: 100,
      workflowExpiresAt: 10_000,
      ...overrides,
    });
  }

  it("commits only an authorized answer to released history", () => {
    const task = begin();
    const response = completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external",
      review,
      now: 200,
      outcome: {
        kind: "release",
        releaseId: "release-1",
        answer: "Friday afternoon.",
        expectedDisclosureRevision: 0,
      },
    });

    expect(response).toEqual({
      status: "released",
      workflowId: "wf-1",
      conversationId: "conv-1",
      taskId: "task-1",
      releaseId: "release-1",
      answer: "Friday afternoon.",
    });
    expect(loadReleasedAnswerHistory(db, "conv-1", "token:external")).toEqual([
      { role: "user", parts: [{ kind: "text", text: "When am I available?" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Friday afternoon." }] },
    ]);
  });

  it("lets an idempotent native retry attach only to its original completion route", () => {
    db.prepare("INSERT INTO devices (id) VALUES (?)").run("device-agent");
    const completionRoute = {
      integrationDeviceId: "device-agent",
      nativeConversationId: "native_fictional",
    };
    const first = begin({ completionRoute });
    expect(begin({ completionRoute })).toMatchObject({ taskId: first.taskId, duplicate: true });
    expect(() =>
      begin({
        completionRoute: { ...completionRoute, nativeConversationId: "native_redirect" },
      }),
    ).toThrowError(AnswerStoreError);
    expect(() => begin()).toThrow(/different native completion route/);
  });

  it("holds the candidate behind an opaque response and releases the frozen text once", () => {
    const task = begin();
    const candidate = "The held candidate.";
    const response = completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external",
      review: { ...review, confidence: 0.7 },
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-1",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        expiresAt: 5_000,
      },
    });

    expect(response).toEqual({
      status: "approval_required",
      workflowId: "wf-1",
      conversationId: "conv-1",
      taskId: "task-1",
      approvalId: "approval-1",
      approvalExpiresAt: 5_000,
    });
    expect(JSON.stringify(response)).not.toContain(candidate);
    expect(loadReleasedAnswerHistory(db, "conv-1", "token:external")).toEqual([]);
    // Fixture clock inside the approval's expiry window (expiresAt 5_000) so
    // the pending approval reads as pending.
    expect(listPrivacyApprovals(db, "pending", 100, 400)).toHaveLength(1);
    expect(getPrivacyApproval(db, "approval-1", 400)?.candidateAnswer).toBe(candidate);

    const released = resolvePrivacyApproval(db, {
      approvalId: "approval-1",
      action: "approve",
      requestContext: resolutionRequest,
      releaseId: "release-approval-1",
      now: 300,
    });
    expect(released).toMatchObject({
      status: "released",
      releaseId: "release-approval-1",
      answer: candidate,
    });
    const resolution = listPrivacyAuditEvents(db, task.conversationId, 50)?.events.find(
      (event) => event.kind === "approval_resolved",
    );
    expect(getPrivacyAuditEvent(db, task.conversationId, resolution!.id)?.payload).toMatchObject({
      approvalId: "approval-1",
      status: "approved",
      action: "approve",
      outcome: "approved",
      request: resolutionRequest,
    });
    expect(
      resolvePrivacyApproval(db, {
        approvalId: "approval-1",
        action: "approve",
        requestContext: {
          ...resolutionRequest,
          requestId: "request-admin-retry",
        },
        releaseId: "unused",
        now: 400,
      }),
    ).toEqual(released);
    expect(
      listPrivacyAuditEvents(db, task.conversationId, 50)?.events.filter(
        (event) => event.kind === "approval_resolved",
      ),
    ).toHaveLength(1);
  });

  it("purges a denied held candidate and unblocks the conversation", () => {
    const task = begin();
    const candidate = "Held and then denied.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-1",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        expiresAt: 5_000,
      },
    });

    const denied = resolvePrivacyApproval(db, {
      approvalId: "approval-1",
      action: "deny",
      requestContext: resolutionRequest,
      releaseId: "unused",
      now: 300,
    });
    expect(denied).toMatchObject({ status: "denied", reason: "user_denied" });
    expect(getPrivacyApproval(db, "approval-1")).toMatchObject({
      status: "denied",
      candidateAnswer: candidate,
    });

    const next = begin({
      conversationId: "conv-1",
      clientRequestId: "request-2",
      question: "A follow-up",
      ids: { workflowId: "unused", conversationId: "unused", taskId: "task-2" },
    });
    expect(next.taskId).toBe("task-2");
    expect(JSON.stringify(loadReleasedAnswerHistory(db, "conv-1", "token:external"))).not.toContain(
      candidate,
    );
  });

  it("purges an expired held candidate and unblocks the conversation", () => {
    const task = begin();
    const candidate = "Held until the approval expires.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-expiring",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        expiresAt: 500,
      },
    });

    expect(expirePrivacyApprovals(db, 501)).toBe(1);
    expect(getPrivacyApproval(db, "approval-expiring")).toMatchObject({
      status: "expired",
      candidateAnswer: candidate,
    });
    expect(getAnswerTaskResponse(db, task.taskId, "token:external")).toMatchObject({
      status: "denied",
      reason: "expired",
    });

    expect(
      begin({
        conversationId: task.conversationId,
        clientRequestId: "request-after-expiry",
        question: "A follow-up after expiry",
        ids: { workflowId: "unused", conversationId: "unused", taskId: "task-after-expiry" },
        now: 600,
      }),
    ).toMatchObject({ taskId: "task-after-expiry", state: "running" });
    expect(JSON.stringify(db.prepare("SELECT * FROM answer_tasks").all())).not.toContain(candidate);
  });

  it("presents a lapsed pending approval as expired at read time, before any sweep", () => {
    const task = begin();
    const candidate = "Held past its deadline, sweep not yet run.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-lapsed",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        expiresAt: 500,
      },
    });

    // No expirePrivacyApprovals sweep — reads must not depend on the writer
    // having materialized the flip. Before the deadline it reads pending…
    expect(listPrivacyApprovals(db, "pending", 100, 400)).toHaveLength(1);
    // …after the deadline the same rows read as expired in every projection.
    expect(listPrivacyApprovals(db, "pending", 100, 600)).toHaveLength(0);
    expect(listPrivacyApprovals(db, "expired", 100, 600)).toMatchObject([
      { id: "approval-lapsed", status: "expired" },
    ]);
    // The "all" filter takes the un-filtered WHERE branch; the summary
    // mapping alone must render the lapsed status.
    expect(listPrivacyApprovals(db, "all", 100, 600)).toMatchObject([
      { id: "approval-lapsed", status: "expired" },
    ]);
    expect(getPrivacyApproval(db, "approval-lapsed", 600)).toMatchObject({ status: "expired" });
    // The physical rows are untouched — the periodic sweep still owns the flip.
    expect(
      db.prepare("SELECT status FROM answer_approvals WHERE id = 'approval-lapsed'").get(),
    ).toEqual({ status: "pending" });
  });

  it("records expiry chronology when a follow-up discovers the expired approval", () => {
    const task = begin();
    const candidate = "Held until a later follow-up.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-follow-up-expiry",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        expiresAt: 500,
      },
    });

    begin({
      conversationId: task.conversationId,
      clientRequestId: "request-discovers-expiry",
      question: "A follow-up discovers expiry",
      ids: { workflowId: "unused", conversationId: "unused", taskId: "task-after-expiry" },
      now: 600,
    });

    expect(
      listPrivacyAuditEvents(db, task.conversationId, 20)?.events.map((event) => event.kind),
    ).toEqual([
      "external_request",
      "approval_requested",
      "approval_resolved",
      "denied",
      "external_request",
    ]);
  });

  it("deduplicates a client request and enforces owner boundaries", () => {
    const first = begin();
    const duplicate = begin({
      ids: { workflowId: "wf-new", conversationId: "conv-new", taskId: "task-new" },
    });
    expect(duplicate).toEqual({ ...first, duplicate: true });

    expect(() => getAnswerTaskResponse(db, first.taskId, "token:other")).toThrowError(
      AnswerStoreError,
    );
    expect(() =>
      begin({
        ownerId: "token:other",
        conversationId: first.conversationId,
        clientRequestId: "request-other",
      }),
    ).toThrow("belongs to another caller");
  });

  it.each([
    ["question", { question: "What changed?" }],
    ["workflow", { workflowId: "wf-1" }],
    ["conversation", { conversationId: "conv-1" }],
    ["workflow name", { workflowName: "Different workflow" }],
    ["workflow purpose", { workflowPurpose: "Different purpose" }],
    ["subscription firing", { subscriptionFiringId: "sfiring-different" }],
  ])("rejects an idempotency key reused with a different %s", (_label, overrides) => {
    begin();

    expect(() => begin(overrides)).toThrowError(
      expect.objectContaining<Partial<AnswerStoreError>>({ code: "idempotency_conflict" }),
    );
  });

  it("retries a failed task in place with the same request payload", () => {
    const first = begin();
    expect(failAnswerTask(db, first.taskId, "token:external", 200)).toBe(true);
    expect(getAnswerTaskResponse(db, first.taskId, "token:external")).toBeNull();

    const retry = begin({
      now: 300,
      ids: { workflowId: "unused-wf", conversationId: "unused-conv", taskId: "unused-task" },
    });

    expect(retry).toEqual({ ...first, duplicate: false, state: "running" });
    expect(
      db
        .prepare<
          [string],
          { active_task_id: string | null }
        >("SELECT active_task_id FROM answer_conversations WHERE id = ?")
        .get(first.conversationId)?.active_task_id,
    ).toBe(first.taskId);
  });

  it("recovers interrupted tasks and unlocks their conversations", () => {
    const interrupted = begin();

    expect(recoverInterruptedAnswerTasks(db, 200)).toBe(1);
    expect(recoverInterruptedAnswerTasks(db, 201)).toBe(0);
    expect(
      db
        .prepare<[string], { status: string }>("SELECT status FROM answer_tasks WHERE id = ?")
        .get(interrupted.taskId)?.status,
    ).toBe("failed");

    const followUp = begin({
      clientRequestId: "request-2",
      question: "A new turn after recovery",
      conversationId: interrupted.conversationId,
      ids: { workflowId: "unused-wf", conversationId: "unused-conv", taskId: "task-2" },
      now: 300,
    });
    expect(followUp).toMatchObject({
      taskId: "task-2",
      conversationId: interrupted.conversationId,
      state: "running",
    });
  });

  it("reconstructs every persisted task state into the four-state response contract", () => {
    let sequence = 0;
    const start = (suffix: string) =>
      beginAnswerTask(db, {
        ownerId: "token:external",
        clientRequestId: `request-${suffix}`,
        question: `Synthetic question ${suffix}`,
        ids: {
          workflowId: `wf-${suffix}`,
          conversationId: `conv-${suffix}`,
          taskId: `task-${suffix}`,
        },
        now: 100 + sequence++,
        workflowExpiresAt: 10_000,
      });

    const running = start("running");
    expect(getAnswerTaskResponse(db, running.taskId, "token:external")).toBeNull();

    const failed = start("failed");
    failAnswerTask(db, failed.taskId, "token:external", 200);
    expect(getAnswerTaskResponse(db, failed.taskId, "token:external")).toBeNull();

    const canceled = start("canceled");
    db.prepare(
      "UPDATE answer_tasks SET status = 'canceled', denial_reason = 'canceled' WHERE id = ?",
    ).run(canceled.taskId);
    expect(getAnswerTaskResponse(db, canceled.taskId, "token:external")).toMatchObject({
      status: "denied",
      reason: "canceled",
    });

    const released = start("released");
    expect(
      completeAnswerTask(db, {
        taskId: released.taskId,
        ownerId: "token:external",
        review,
        now: 210,
        outcome: {
          kind: "release",
          releaseId: "release-released",
          answer: "Allowed answer.",
          expectedDisclosureRevision: 0,
        },
      }),
    ).toMatchObject({ status: "released", answer: "Allowed answer." });

    const reduced = start("reduced");
    expect(
      completeAnswerTask(db, {
        taskId: reduced.taskId,
        ownerId: "token:external",
        review,
        now: 220,
        outcome: {
          kind: "reduce",
          releaseId: "release-reduced",
          answer: "General answer.",
          reductions: ["Private detail was removed or generalized"],
          expectedDisclosureRevision: 0,
        },
      }),
    ).toMatchObject({
      status: "released_with_reductions",
      answer: "General answer.",
      reductions: ["Private detail was removed or generalized"],
    });

    const approval = start("approval");
    const candidate = "Held answer.";
    expect(
      completeAnswerTask(db, {
        taskId: approval.taskId,
        ownerId: "token:external",
        review,
        now: 230,
        outcome: {
          kind: "approval",
          approvalId: "approval-contract",
          candidateAnswer: candidate,
          candidateDigest: digestCandidate(candidate),
          expiresAt: 5_000,
        },
      }),
    ).toMatchObject({ status: "approval_required", approvalId: "approval-contract" });

    const denied = start("denied");
    expect(
      completeAnswerTask(db, {
        taskId: denied.taskId,
        ownerId: "token:external",
        review,
        now: 240,
        outcome: { kind: "deny", reason: "hard_stop" },
      }),
    ).toMatchObject({ status: "denied", reason: "hard_stop" });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { externalAnswerOwnerId } from "../access/corpus-authorization.js";
import {
  beginAnswerTask,
  appendAnswerAuditEvent,
  auditDisplay,
  completeAnswerTask,
  createAnswerPrivacyTables,
  digestCandidate,
  failAnswerTask,
  getPrivacyReviewerHealth,
  listPrivacyApprovals,
  listPrivacyExchangePresentations,
  recordAnswerEgress,
  resolvePrivacyApproval,
} from "./store.js";
import {
  externalAgentIdentity,
  latestPrivacyExchangeOutcomes,
  listPrivacyExchangeFeed,
  privacyExternalAgentIdentities,
} from "./presentation.js";
import { tokenAnswerOwnerId } from "./token-answer-owner.js";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";

/** What the token name in the fixture below projects to on the wire. */
const OPENCLAW_IDENTITY = {
  displayName: "OpenClaw",
  narrativeName: "OpenClaw",
  integrationSlug: null,
  source: "token",
};

const baseReview: PrivacyReviewRecord = {
  recipeVersion: "privacy-reviewer-v2",
  provider: "synthetic-provider",
  model: "synthetic-reviewer",
  confidence: 0.95,
  policyRevision: "policy-a",
  fallbackCause: null,
  findings: [
    {
      category: "schedule",
      detailLevel: "summary",
      subject: "user",
      disposition: "allow",
      description: "General schedule information.",
    },
  ],
  rationale: "The fictional policy permits a schedule summary.",
};

describe("privacy exchange presentation", () => {
  let db: Database.Database;
  let serial: number;
  let statements: string[];

  beforeEach(() => {
    statements = [];
    db = new Database(":memory:", {
      verbose: (statement) => statements.push(String(statement)),
    });
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, capabilities TEXT NOT NULL)");
    createAnswerPrivacyTables(db);
    db.exec(
      "CREATE TABLE tokens (id TEXT PRIMARY KEY, name TEXT); " +
        "INSERT INTO tokens (id, name) VALUES ('external-token', 'OpenClaw');",
    );
    db.exec(`
      CREATE TABLE access_principals (id TEXT PRIMARY KEY, name TEXT NOT NULL, revoked_at INTEGER);
      CREATE TABLE access_grants (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE principal_credentials (
        id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        label TEXT NOT NULL,
        revoked_at INTEGER
      );
    `);
    serial = 0;
  });

  /** A paired device, as the gateway stores one. */
  function pairDevice(id: string, name: string, capabilities: Record<string, unknown>) {
    db.prepare("INSERT INTO devices (id, name, capabilities) VALUES (?, ?, ?)").run(
      id,
      name,
      JSON.stringify(capabilities),
    );
  }

  function begin(question: string, now?: number, ownerId = "token:external-token") {
    serial += 1;
    const createdAt = now ?? serial * 100;
    return beginAnswerTask(db, {
      ownerId,
      clientRequestId: `request-${serial}`,
      question,
      workflowName: `Planning workflow ${serial}`,
      workflowPurpose: "Prepare a fictional planning summary.",
      ids: {
        workflowId: `workflow-${serial}`,
        conversationId: `conversation-${serial}`,
        taskId: `task-${serial}`,
      },
      now: createdAt,
      workflowExpiresAt: createdAt + 100_000,
    });
  }

  // Fixture clock: after every fixture event, before every fixture expiry
  // (approvals use expiresAt 10_000), so pending approvals read as pending.
  const FIXTURE_NOW = 5_000;

  function exchanges(conversationId: string, traceTaskId?: string) {
    return (
      listPrivacyExchangePresentations(db, conversationId, 50, undefined, FIXTURE_NOW, traceTaskId)
        ?.exchanges ?? []
    );
  }

  it("calls a release shared only after matching external egress is recorded", () => {
    const released = begin("When is the fictional planning review?");
    completeAnswerTask(db, {
      taskId: released.taskId,
      ownerId: "token:external-token",
      review: baseReview,
      now: 150,
      outcome: {
        kind: "release",
        releaseId: "release-exact",
        answer: "The review is Thursday afternoon.",
        expectedDisclosureRevision: 0,
      },
    });

    expect(exchanges(released.conversationId)).toEqual([
      expect.objectContaining({
        outcome: "ready",
        sharedAnswer: null,
        sharedAt: null,
        pendingCandidate: null,
        externalAgent: OPENCLAW_IDENTITY,
      }),
    ]);
    expect(latestPrivacyExchangeOutcomes(db, [released.conversationId])).toEqual(
      new Map([[released.conversationId, "ready"]]),
    );

    recordAnswerEgress(db, {
      id: "egress-release-exact",
      taskId: released.taskId,
      ownerId: "token:external-token",
      endpoint: "/answer",
      now: 160,
    });
    db.prepare(
      `INSERT INTO answer_egress_events (
         id, task_id, conversation_id, owner_id, endpoint, http_status,
         response_digest, created_at
       )
       SELECT 'egress-release-exact-later-row', task_id, conversation_id, owner_id,
              endpoint, http_status, response_digest, 1
         FROM answer_egress_events WHERE id = 'egress-release-exact'`,
    ).run();
    expect(exchanges(released.conversationId)[0]).toMatchObject({
      outcome: "shared",
      sharedAnswer: "The review is Thursday afternoon.",
      sharedAt: 160,
      pendingCandidate: null,
    });
    expect(latestPrivacyExchangeOutcomes(db, [released.conversationId])).toEqual(
      new Map([[released.conversationId, "shared"]]),
    );
    statements.length = 0;
    expect(exchanges(released.conversationId)[0]?.outcome).toBe("shared");
    expect(statements.join("\n")).not.toContain("answer_egress_payloads");
    expect(statements.join("\n")).not.toContain("response_json");
  });

  it("surfaces a safe failed-answer reason without exposing an audit payload", () => {
    const failed = begin("Can the fictional plan be summarized?");
    failAnswerTask(db, failed.taskId, "token:external-token", 150, {
      code: "http_empty_response",
      message: "Model returned an empty response (finish_reason=length).",
    });

    expect(exchanges(failed.conversationId)).toEqual([
      expect.objectContaining({
        status: "failed",
        outcome: "failed",
        failure: {
          code: "http_empty_response",
          message: "Model returned an empty response (finish_reason=length).",
          stage: "answer_generation",
        },
      }),
    ]);
  });

  it("projects the newest bounded answer-generation transcripts in attempt order", () => {
    const task = begin("Can the fictional plan be summarized?");
    for (const [index, text] of [
      "First attempt.",
      "Second attempt.",
      "Third attempt.",
      "Fourth attempt.",
    ].entries()) {
      appendAnswerAuditEvent(db, {
        id: `trace-${index}`,
        taskId: task.taskId,
        ownerId: "token:external-token",
        kind: "agent_trace",
        display: auditDisplay({ title: "Agent activity" }),
        payload: {
          provider: "synthetic-provider",
          model: "synthetic-model",
          sessionId: `session-${index}`,
          messages: [{ role: "assistant", parts: [{ kind: "text", text }] }],
          subagentEvents: [],
          terminalStopReason: index === 0 ? "error" : "end_turn",
        },
        now: 120 + index,
      });
    }

    const detail = exchanges(task.conversationId, task.taskId)[0];
    expect(detail?.agentTraces).toEqual([
      expect.objectContaining({ attempt: 2, sessionId: "session-1", createdAt: 121 }),
      expect.objectContaining({ attempt: 3, sessionId: "session-2", createdAt: 122 }),
      expect.objectContaining({ attempt: 4, sessionId: "session-3", createdAt: 123 }),
    ]);
    expect(detail?.agentTraceOmittedAttempts).toBe(1);
  });

  it("omits an oversized UTF-8 trace with an explicit count", () => {
    const task = begin("Can the fictional plan be summarized?");
    appendAnswerAuditEvent(db, {
      id: "oversized-trace",
      taskId: task.taskId,
      ownerId: "token:external-token",
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: {
        provider: "synthetic-provider",
        model: "synthetic-model",
        sessionId: "session-oversized",
        messages: [{ role: "assistant", parts: [{ kind: "text", text: "é".repeat(300_000) }] }],
      },
      now: 120,
    });

    const detail = exchanges(task.conversationId, task.taskId)[0];
    expect(detail?.agentTraces).toEqual([]);
    expect(detail?.agentTraceOmittedAttempts).toBe(1);
  });

  it("preserves an exact omitted-part count from a bounded stored trace", () => {
    const task = begin("Can the fictional plan be summarized?");
    appendAnswerAuditEvent(db, {
      id: "bounded-trace",
      taskId: task.taskId,
      ownerId: "token:external-token",
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: {
        provider: "synthetic-provider",
        model: "synthetic-model",
        sessionId: "session-bounded",
        messages: [
          {
            role: "assistant",
            parts: Array.from({ length: 64 }, (_, index) => ({
              kind: "text",
              text: `Observable part ${index + 1}.`,
            })),
          },
          { type: "trace_truncated", omittedParts: 17 },
        ],
      },
      now: 120,
    });

    expect(exchanges(task.conversationId, task.taskId)[0]?.agentTraces).toEqual([
      expect.objectContaining({
        truncated: true,
        omittedParts: 17,
        messages: expect.arrayContaining([{ type: "trace_truncated", omittedParts: 17 }]),
      }),
    ]);
  });

  it("keeps a trailing truncation marker after the bounded message window", () => {
    const task = begin("Can the fictional plan be summarized?");
    appendAnswerAuditEvent(db, {
      id: "many-message-trace",
      taskId: task.taskId,
      ownerId: "token:external-token",
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: {
        provider: "synthetic-provider",
        model: "synthetic-model",
        sessionId: "session-many-messages",
        messages: [
          ...Array.from({ length: 64 }, (_, index) => ({
            role: "assistant",
            parts: [{ kind: "text", text: `Observable part ${index + 1}.` }],
          })),
          { type: "trace_truncated", omittedParts: 3 },
        ],
      },
      now: 120,
    });

    expect(exchanges(task.conversationId, task.taskId)[0]?.agentTraces[0]).toMatchObject({
      truncated: true,
      omittedParts: 3,
      messages: expect.arrayContaining([{ type: "trace_truncated", omittedParts: 3 }]),
    });
  });

  it("selects a requested older task independently of the page limit", () => {
    const older = begin("What is the older fictional plan?", 100);
    const newer = begin("What is the newer fictional plan?", 200);
    db.prepare("UPDATE answer_tasks SET conversation_id = ? WHERE id = ?").run(
      older.conversationId,
      newer.taskId,
    );

    const page = listPrivacyExchangePresentations(
      db,
      older.conversationId,
      1,
      undefined,
      FIXTURE_NOW,
      older.taskId,
    );
    expect(page?.exchanges.map((exchange) => exchange.taskId)).toEqual([older.taskId]);
    expect(page?.previousCursor).toBeNull();
  });

  it("recovers a safe HTTP failure for generic historical rows without echoing diagnostics", () => {
    const task = begin("Can the fictional plan be summarized?");
    appendAnswerAuditEvent(db, {
      id: "legacy-http-trace",
      taskId: task.taskId,
      ownerId: "token:external-token",
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: {
        terminalStopReason: "error",
        messages: [
          { parts: [{ text: "Model request failed: http_request_error: private diagnostic" }] },
        ],
      },
      now: 125,
    });
    failAnswerTask(db, task.taskId, "token:external-token", 150, {
      code: "answer_failed",
      message: "Omnesis could not complete this answer.",
    });

    const failure = exchanges(task.conversationId)[0]?.failure;
    expect(failure?.code).toBe("http_request_error");
    // The same code must read the same way whether the row was written before
    // the failure code survived the answer runner or after it.
    expect(failure?.message).toContain("could not reach the selected model");
    expect(JSON.stringify(failure)).not.toContain("private diagnostic");
    expect(JSON.stringify(exchanges(task.conversationId)[0])).not.toContain("private diagnostic");
  });

  it("presents a stopped candidate as a stop, never as a model failure", () => {
    const task = begin("Can the fictional plan be summarized?");
    appendAnswerAuditEvent(db, {
      id: "stopped-trace",
      taskId: task.taskId,
      ownerId: "token:external-token",
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: {
        provider: "synthetic-provider",
        model: "synthetic-model",
        sessionId: "session-stopped",
        terminalStopReason: "canceled",
        messages: [
          {
            role: "assistant",
            parts: [
              { kind: "text", text: "Model request failed: canceled: This reply was stopped." },
            ],
          },
          {
            role: "assistant",
            parts: [
              {
                kind: "text",
                text: "A partial draft.\n\nModel request failed: http_api_error: private diagnostic",
              },
            ],
          },
        ],
        subagentEvents: [],
      },
      now: 125,
    });

    const detail = exchanges(task.conversationId, task.taskId)[0];
    expect(detail?.agentTraces[0]?.messages).toEqual([
      {
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: "The model request was stopped before producing a final answer.",
          },
        ],
      },
      {
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: "A partial draft.\n\nThe model request failed before producing a final answer.",
          },
        ],
      },
    ]);
    expect(JSON.stringify(detail)).not.toContain("private diagnostic");
  });

  it("deep-validates projected transcripts and keeps them out of the landing feed", () => {
    const task = begin("Can the fictional plan be summarized?");
    appendAnswerAuditEvent(db, {
      id: "malformed-trace",
      taskId: task.taskId,
      ownerId: "token:external-token",
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: {
        provider: "synthetic-provider",
        model: "synthetic-model",
        sessionId: "session-malformed",
        terminalStopReason: "error",
        messages: [
          {
            role: "assistant",
            parts: [
              null,
              { kind: "thinking", text: "Hidden model reasoning." },
              { kind: "text", text: { malformed: true } },
              { kind: "text", text: "Visible final output." },
            ],
          },
        ],
        subagentEvents: [{ private: "not projected" }],
      },
      now: 125,
    });

    const detail = exchanges(task.conversationId, task.taskId)[0];
    expect(detail?.agentTraces[0]?.messages).toEqual([
      { role: "assistant", parts: [{ kind: "text", text: "Visible final output." }] },
    ]);
    expect(detail?.agentTraces[0]?.truncated).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("Hidden model reasoning");
    expect(JSON.stringify(detail)).not.toContain("not projected");
    expect(
      listPrivacyExchangeFeed(db, { limit: 10 }, FIXTURE_NOW).exchanges[0]?.agentTraces,
    ).toEqual([]);
  });

  it("attributes a failed task after candidate generation to the privacy stage", () => {
    const task = begin("Can the fictional plan be summarized?");
    appendAnswerAuditEvent(db, {
      id: "candidate-with-missing-payload",
      taskId: task.taskId,
      ownerId: "token:external-token",
      kind: "candidate_generated",
      display: auditDisplay({ text: "An invented draft." }),
      payload: { answer: "A different invented draft.", digest: "mismatch" },
      now: 125,
    });
    failAnswerTask(db, task.taskId, "token:external-token", 150, {
      code: "reviewer_unavailable",
      message: "The privacy check could not complete.",
    });

    expect(exchanges(task.conversationId)[0]).toMatchObject({
      draftAnswer: null,
      failure: { stage: "privacy_check" },
    });
  });

  it("maps legacy empty-length and cancellation traces to safe failure summaries", () => {
    const emptyResponse = begin("Can the fictional plan be summarized?");
    appendAnswerAuditEvent(db, {
      id: "legacy-empty-trace",
      taskId: emptyResponse.taskId,
      ownerId: "token:external-token",
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: {
        terminalStopReason: "error",
        messages: [
          {
            parts: [
              {
                text: "Model request failed: http_empty_response: Model returned an empty response (finish_reason=length).",
              },
            ],
          },
        ],
      },
      now: 125,
    });
    failAnswerTask(db, emptyResponse.taskId, "token:external-token", 150);
    db.prepare(
      `UPDATE answer_audit_events
          SET display_json = '{"text":"Nothing was released."}'
        WHERE task_id = ? AND event_type = 'failed'`,
    ).run(emptyResponse.taskId);

    const canceled = begin("Can the fictional plan be rescheduled?");
    appendAnswerAuditEvent(db, {
      id: "legacy-canceled-trace",
      taskId: canceled.taskId,
      ownerId: "token:external-token",
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: { terminalStopReason: "canceled" },
      now: 225,
    });
    failAnswerTask(db, canceled.taskId, "token:external-token", 250);
    db.prepare(
      `UPDATE answer_audit_events
          SET display_json = '{"text":"Nothing was released."}'
        WHERE task_id = ? AND event_type = 'failed'`,
    ).run(canceled.taskId);

    expect(exchanges(emptyResponse.conversationId)[0]?.failure).toEqual({
      code: "http_empty_response",
      message:
        "The model returned an empty response (finish_reason=length) before producing a final answer.",
      stage: "answer_generation",
    });
    expect(exchanges(canceled.conversationId)[0]?.failure).toEqual({
      code: "answer_canceled",
      message: "The request was canceled before Omnesis completed it.",
      stage: "answer_generation",
    });
  });

  it("batches latest outcomes across conversations", () => {
    const ready = begin("What is the fictional project status?", 300);
    completeAnswerTask(db, {
      taskId: ready.taskId,
      ownerId: "token:external-token",
      review: baseReview,
      now: 310,
      outcome: {
        kind: "release",
        releaseId: "release-ready-batch",
        answer: "The fictional project is on schedule.",
        expectedDisclosureRevision: 0,
      },
    });
    const shared = begin("When is the fictional planning session?", 400);
    completeAnswerTask(db, {
      taskId: shared.taskId,
      ownerId: "token:external-token",
      review: baseReview,
      now: 410,
      outcome: {
        kind: "release",
        releaseId: "release-shared-batch",
        answer: "The fictional planning session is Friday.",
        expectedDisclosureRevision: 0,
      },
    });
    recordAnswerEgress(db, {
      id: "egress-shared-batch",
      taskId: shared.taskId,
      ownerId: "token:external-token",
      endpoint: "/answer",
      now: 420,
    });
    const pending = begin("What is in the fictional private note?", 500);
    completeAnswerTask(db, {
      taskId: pending.taskId,
      ownerId: "token:external-token",
      review: { ...baseReview, fallbackCause: "policy_requires_review" },
      now: 510,
      outcome: {
        kind: "approval",
        approvalId: "approval-batch",
        candidateAnswer: "A held fictional detail.",
        candidateDigest: digestCandidate("A held fictional detail."),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });

    statements.length = 0;
    const latestOutcomes = latestPrivacyExchangeOutcomes(
      db,
      [
        ready.conversationId,
        shared.conversationId,
        pending.conversationId,
        "missing-conversation",
        ready.conversationId,
      ],
      FIXTURE_NOW,
    );

    expect(statements).toHaveLength(2);
    expect(statements.join("\n")).not.toContain("answer_egress_payloads");
    expect(statements.join("\n")).not.toContain("response_json");
    expect(latestOutcomes).toEqual(
      new Map([
        [ready.conversationId, "ready"],
        [shared.conversationId, "shared"],
        [pending.conversationId, "needs_review"],
      ]),
    );
  });

  it("presents reductions from the released record without exposing another candidate", () => {
    const reduced = begin("Give an appropriately broad fictional availability summary.");
    completeAnswerTask(db, {
      taskId: reduced.taskId,
      ownerId: "token:external-token",
      review: baseReview,
      now: 250,
      outcome: {
        kind: "reduce",
        releaseId: "release-reduced",
        answer: "Available later this week.",
        reductions: ["Exact timing removed"],
        expectedDisclosureRevision: 0,
      },
    });

    expect(exchanges(reduced.conversationId)[0]).toMatchObject({
      outcome: "ready",
      sharedAnswer: null,
      sharedAt: null,
      pendingCandidate: null,
      reductions: ["Exact timing removed"],
    });
    recordAnswerEgress(db, {
      id: "egress-release-reduced",
      taskId: reduced.taskId,
      ownerId: "token:external-token",
      endpoint: "/answer",
      now: 260,
    });
    expect(exchanges(reduced.conversationId)[0]).toMatchObject({
      outcome: "shared_with_reductions",
      sharedAnswer: "Available later this week.",
      sharedAt: 260,
      pendingCandidate: null,
      reductions: ["Exact timing removed"],
    });
  });

  it("marks a private candidate as awaiting approval and never as shared", () => {
    const pending = begin("What is in the fictional private note?");
    const candidate = "The fictional note contains a private planning detail.";
    completeAnswerTask(db, {
      taskId: pending.taskId,
      ownerId: "token:external-token",
      review: { ...baseReview, fallbackCause: "policy_requires_review" },
      now: 350,
      outcome: {
        kind: "approval",
        approvalId: "approval-pending",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });

    expect(exchanges(pending.conversationId)[0]).toMatchObject({
      outcome: "needs_review",
      sharedAnswer: null,
      pendingCandidate: candidate,
      approval: { id: "approval-pending", status: "pending" },
      review: { fallbackCause: "policy_requires_review" },
    });
  });

  it("batches external-agent identities for approval lists", () => {
    function holdOne(index: number) {
      const task = begin(`Synthetic approval identity question ${index}`);
      const candidate = `Synthetic held answer ${index}`;
      completeAnswerTask(db, {
        taskId: task.taskId,
        ownerId: "token:external-token",
        review: { ...baseReview, fallbackCause: "policy_requires_review" },
        now: 700 + index,
        outcome: {
          kind: "approval",
          approvalId: `approval-identity-${index}`,
          candidateAnswer: candidate,
          candidateDigest: digestCandidate(candidate),
          releaseStatus: "released",
          reductions: [],
          expiresAt: 10_000,
        },
      });
    }

    function countStatementsForList(expected: number) {
      statements.length = 0;
      const approvals = listPrivacyApprovals(db, "pending", 100, FIXTURE_NOW);
      expect(approvals).toHaveLength(expected);
      expect(approvals.map((approval) => approval.externalAgent)).toEqual(
        Array.from({ length: expected }, () => OPENCLAW_IDENTITY),
      );
      return statements.length;
    }

    holdOne(1);
    holdOne(2);
    // Page + exact count + one column probe and one batched lookup for the
    // token namespace these owners are written under. A namespace no owner on
    // the page uses reads nothing.
    expect(countStatementsForList(2)).toBe(4);

    holdOne(3);
    holdOne(4);
    // The point of the number above: doubling the page costs nothing, because
    // every identity on it is resolved by the same two reads.
    expect(countStatementsForList(4)).toBe(4);
  });

  it("names every owner of one token, whichever access level it answers under", () => {
    const plain = tokenAnswerOwnerId("external-token");
    // The shape `tokenAnswerOwnerId` gives a token on an access level.
    const scoped = "token:external-token:answer-scope:c2NvcGUtZGlnZXN0";
    const identities = privacyExternalAgentIdentities(db, [plain, scoped]);
    expect(identities.get(plain)).toEqual(OPENCLAW_IDENTITY);
    expect(identities.get(scoped)).toEqual(OPENCLAW_IDENTITY);
  });

  it("names a token caller after the device the token belongs to, with its kind", () => {
    const withDevices = new Database(":memory:");
    withDevices.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, kind TEXT, capabilities TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE tokens (id TEXT PRIMARY KEY, name TEXT, device_id TEXT);
      INSERT INTO devices (id, name, kind) VALUES ('device-voice', 'Studio voice', 'cli');
      INSERT INTO tokens (id, name, device_id) VALUES
        ('token-initial', 'initial', 'device-voice'),
        ('token-labelled', 'Kitchen handler', 'device-voice'),
        ('token-loose', 'Loose script', NULL);
    `);
    const identities = privacyExternalAgentIdentities(withDevices, [
      "token:token-initial",
      "token:token-labelled",
      "token:token-loose",
    ]);
    expect(identities.get("token:token-initial")).toMatchObject({
      displayName: "Studio voice",
      deviceKind: "cli",
      source: "token",
    });
    expect(identities.get("token:token-initial")?.connectionName).toBeUndefined();
    expect(identities.get("token:token-labelled")).toMatchObject({
      displayName: "Studio voice",
      connectionName: "Kitchen handler",
      deviceKind: "cli",
    });
    expect(identities.get("token:token-loose")).toMatchObject({ displayName: "Loose script" });
    expect(identities.get("token:token-loose")?.deviceKind).toBeUndefined();
    withDevices.close();
  });

  describe("the caller's name", () => {
    function seedPrincipal() {
      db.exec(`
        INSERT INTO access_principals (id, name) VALUES ('principal-example', 'Mosaic assistant');
        INSERT INTO access_grants (id, principal_id, revision)
          VALUES ('grant-example', 'principal-example', 3);
        INSERT INTO principal_credentials (id, grant_id, label)
          VALUES ('credential-example', 'grant-example', 'Mosaic on desktop');
      `);
    }

    function principalOwner(
      overrides: Partial<{
        principalId: string;
        grantId: string;
        revision: number;
        credentialId: string;
      }> = {},
    ) {
      return externalAnswerOwnerId({
        principalId: overrides.principalId ?? "principal-example",
        grantId: overrides.grantId ?? "grant-example",
        grantRevision: overrides.revision ?? 2,
        credentialId: overrides.credentialId ?? "credential-example",
        accessTokenId: "access-token-example",
        capability: "answer",
        sourceMode: "all",
        sourceIds: [],
        releaseMode: "unreviewed",
        policyFamilyId: null,
        policyRevision: null,
        privacyPolicy: null,
        digest: "fictional-digest",
        restricted: false,
        allowsSource: () => true,
      } as Parameters<typeof externalAnswerOwnerId>[0]);
    }

    it("names an OAuth caller from its principal and connection", () => {
      seedPrincipal();
      const task = begin("Which principal is asking?", undefined, principalOwner());

      expect(exchanges(task.conversationId)[0]!.externalAgent).toEqual({
        displayName: "Mosaic assistant",
        narrativeName: "Mosaic assistant",
        integrationSlug: null,
        connectionName: "Mosaic on desktop",
        source: "principal",
      });
    });

    it("resolves multiple historical scopes for one credential in one batch", () => {
      seedPrincipal();
      const first = begin("What did the earlier scope ask?", 100, principalOwner({ revision: 2 }));
      const second = begin("What did the current scope ask?", 200, principalOwner({ revision: 3 }));

      const feed = listPrivacyExchangeFeed(db, { limit: 10 }, FIXTURE_NOW).exchanges;
      const byTask = new Map(feed.map((exchange) => [exchange.taskId, exchange.externalAgent]));
      expect(byTask.get(first.taskId)?.displayName).toBe("Mosaic assistant");
      expect(byTask.get(second.taskId)?.displayName).toBe("Mosaic assistant");
    });

    it("retains the historical identity after access is revoked", () => {
      seedPrincipal();
      db.exec(`
        UPDATE access_principals SET revoked_at = 100 WHERE id = 'principal-example';
        UPDATE access_grants SET revoked_at = 100 WHERE id = 'grant-example';
        UPDATE principal_credentials SET revoked_at = 100 WHERE id = 'credential-example';
      `);
      const task = begin("Who made this historical request?", undefined, principalOwner());

      expect(exchanges(task.conversationId)[0]!.externalAgent.displayName).toBe("Mosaic assistant");
    });

    it.each([
      ["principal", { principalId: "principal-other" }],
      ["grant", { grantId: "grant-other" }],
      ["credential", { credentialId: "credential-other" }],
    ])("does not trust an OAuth owner with a mismatched %s", (_label, overrides) => {
      seedPrincipal();
      const task = begin("Who is asking?", undefined, principalOwner(overrides));

      expect(exchanges(task.conversationId)[0]!.externalAgent).toEqual({
        displayName: "External agent",
        narrativeName: "External agent",
        integrationSlug: null,
        source: "fallback",
      });
    });

    it("does not trust a legacy OAuth owner with a mismatched future revision", () => {
      seedPrincipal();
      const task = begin(
        "Who is asking?",
        undefined,
        "principal:principal-example:grant:grant-example:revision:4:credential:credential-example:scope:legacy",
      );

      expect(exchanges(task.conversationId)[0]!.externalAgent.source).toBe("fallback");
    });

    it.each([
      ["Atlas (openclaw)", "Atlas", "openclaw"],
      ["Ledgerbot (hermes)", "Ledgerbot", "hermes"],
      // A slug is an integration Omnesis pairs with, not any lowercase word a
      // caller happens to end its name with.
      ["Deploybot (v2)", "Deploybot (v2)", null],
      ["Assistant (beta)", "Assistant (beta)", null],
      ["Quarterly Report (2024)", "Quarterly Report (2024)", null],
      ["Acme (support desk)", "Acme (support desk)", null],
      // Stripping would leave nothing to call the caller.
      ["(openclaw)", "(openclaw)", null],
      // Unbalanced parentheses mean the name is not the shape this reads.
      ["Atlas) (openclaw)", "Atlas) (openclaw)", null],
      ["Atlas", "Atlas", null],
    ])("projects %s", (name, narrativeName, integrationSlug) => {
      expect(externalAgentIdentity(name, "token")).toEqual({
        displayName: name,
        narrativeName,
        integrationSlug,
        source: "token",
      });
    });

    it.each([
      ["a blank name", "   "],
      ["a missing name", null],
      ["a name that is not a string", 42],
    ])("names an unnamed caller for %s", (_label, name) => {
      expect(externalAgentIdentity(name, "fallback")).toEqual({
        displayName: "External agent",
        narrativeName: "External agent",
        integrationSlug: null,
        source: "fallback",
      });
    });

    it("derives the split for callers read out of the token table", () => {
      db.prepare("UPDATE tokens SET name = ? WHERE id = ?").run(
        "Atlas (openclaw)",
        "external-token",
      );
      const task = begin("Which integration is asking?");
      expect(exchanges(task.conversationId)[0]!.externalAgent).toEqual({
        displayName: "Atlas (openclaw)",
        narrativeName: "Atlas",
        integrationSlug: "openclaw",
        source: "token",
      });
    });

    // A watch that wakes an integration is answered by the gateway itself, on
    // behalf of the anchor, so there is no caller token to read a name off. The
    // recipient is nevertheless known: the anchor names the device, and the
    // device declares which harness it is.
    it("names the integration a wake would disclose to, from the device's own capability", () => {
      pairDevice("device-atlas", "workshop-laptop", {
        agentIntegration: { harness: "openclaw" },
      });
      const task = begin("Who receives this?", undefined, "device:device-atlas");
      expect(exchanges(task.conversationId)[0]!.externalAgent).toEqual({
        displayName: "workshop-laptop",
        narrativeName: "workshop-laptop",
        integrationSlug: "openclaw",
        source: "integration",
      });
    });

    // The slug comes from the capability, never from the name — otherwise
    // whether the operator can see who receives a disclosure would depend on
    // how someone happened to name a device.
    it("takes the integration from the capability even when the name claims another", () => {
      pairDevice("device-mixed", "Atlas (hermes)", {
        agentIntegration: { harness: "openclaw" },
      });
      const task = begin("Which one is it really?", undefined, "device:device-mixed");
      expect(exchanges(task.conversationId)[0]!.externalAgent).toEqual({
        displayName: "Atlas (hermes)",
        narrativeName: "Atlas",
        integrationSlug: "openclaw",
        source: "integration",
      });
    });

    it.each([
      ["a device that is not an agent integration", "device-phone", {}],
      [
        "a harness this build does not pair with",
        "device-stranger",
        { agentIntegration: { harness: "some-other-harness" } },
      ],
    ])("keeps the generic label for %s", (_label, deviceId, capabilities) => {
      pairDevice(deviceId, "a-paired-device", capabilities);
      const task = begin("Is this an integration?", undefined, `device:${deviceId}`);
      expect(exchanges(task.conversationId)[0]!.externalAgent).toEqual({
        displayName: "External agent",
        narrativeName: "External agent",
        integrationSlug: null,
        source: "fallback",
      });
    });

    it("keeps the generic label for a device this install no longer has", () => {
      const task = begin("Who was that?", undefined, "device:device-unpaired");
      expect(exchanges(task.conversationId)[0]!.externalAgent).toEqual({
        displayName: "External agent",
        narrativeName: "External agent",
        integrationSlug: null,
        source: "fallback",
      });
    });

    // Both namespaces resolve in one read, so a feed mixing a caller's own
    // question with a wake names each of them rather than the first shape it met.
    it("resolves a token caller and a wake in the same batch", () => {
      pairDevice("device-both", "shared-runner", { agentIntegration: { harness: "hermes" } });
      const viaToken = begin("Asked with a token.", 100);
      const viaWake = begin("Raised by a wake.", 200, "device:device-both");

      const feed = listPrivacyExchangeFeed(db, { limit: 10 }, FIXTURE_NOW).exchanges;
      const byTask = new Map(feed.map((exchange) => [exchange.taskId, exchange.externalAgent]));
      expect(byTask.get(viaToken.taskId)).toEqual(OPENCLAW_IDENTITY);
      expect(byTask.get(viaWake.taskId)).toEqual({
        displayName: "shared-runner",
        narrativeName: "shared-runner",
        integrationSlug: "hermes",
        source: "integration",
      });
    });

    // The privacy store is opened over whatever database it is handed, and a
    // fixture that seeds only the answer tables is a legitimate one. A display
    // join is not worth a throw.
    it("keeps the generic label when the database carries no device capabilities", () => {
      const bare = new Database(":memory:");
      bare.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
      createAnswerPrivacyTables(bare);
      const task = beginAnswerTask(bare, {
        ownerId: "device:device-atlas",
        clientRequestId: "bare-request",
        question: "Who receives this?",
        workflowName: "Bare workflow",
        workflowPurpose: "Prepare a fictional summary.",
        ids: {
          workflowId: "workflow-bare",
          conversationId: "conversation-bare",
          taskId: "task-bare",
        },
        now: 100,
        workflowExpiresAt: 100_000,
      });
      expect(
        listPrivacyExchangePresentations(bare, task.conversationId, 50, undefined, FIXTURE_NOW)
          ?.exchanges[0]!.externalAgent,
      ).toEqual({
        displayName: "External agent",
        narrativeName: "External agent",
        integrationSlug: null,
        source: "fallback",
      });
      bare.close();
    });
  });

  describe("the landing feed", () => {
    it("is empty, and offers no cursor, when nothing has been asked", () => {
      expect(listPrivacyExchangeFeed(db, { limit: 10 }, FIXTURE_NOW)).toEqual({
        exchanges: [],
        nextCursor: null,
      });
    });

    it("reads newest-first, the opposite of the conversation detail it feeds into", () => {
      const first = begin("The oldest fictional question.", 100);
      const second = begin("A later fictional question.", 200);
      const third = begin("The newest fictional question.", 300);

      expect(
        listPrivacyExchangeFeed(db, { limit: 10 }, FIXTURE_NOW).exchanges.map(
          (exchange) => exchange.taskId,
        ),
      ).toEqual([third.taskId, second.taskId, first.taskId]);
      // The detail view of one conversation still reads oldest-first, so a
      // reader follows it top-down.
      expect(exchanges(first.conversationId).map((exchange) => exchange.taskId)).toEqual([
        first.taskId,
      ]);
    });

    it("hands back a cursor at the page boundary and resumes exactly after it", () => {
      const tasks = [
        begin("Fictional question one.", 100),
        begin("Fictional question two.", 200),
        begin("Fictional question three.", 300),
      ];

      const page = listPrivacyExchangeFeed(db, { limit: 2 }, FIXTURE_NOW);
      expect(page.exchanges.map((exchange) => exchange.taskId)).toEqual([
        tasks[2]!.taskId,
        tasks[1]!.taskId,
      ]);
      expect(page.nextCursor).toEqual(expect.any(String));

      const rest = listPrivacyExchangeFeed(db, { limit: 2, cursor: page.nextCursor! }, FIXTURE_NOW);
      expect(rest.exchanges.map((exchange) => exchange.taskId)).toEqual([tasks[0]!.taskId]);
      // The last page names no cursor, so a client knows it has the whole feed.
      expect(rest.nextCursor).toBeNull();
    });

    it("breaks a timestamp tie on the id, so no exchange is served twice or skipped", () => {
      // Three exchanges recorded in the same millisecond: without the id in the
      // cursor, paging past the first would either repeat or lose the others.
      const tied = [
        begin("Simultaneous fictional question one.", 500),
        begin("Simultaneous fictional question two.", 500),
        begin("Simultaneous fictional question three.", 500),
      ].map((task) => task.taskId);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = listPrivacyExchangeFeed(db, { limit: 1, cursor }, FIXTURE_NOW);
        seen.push(...page.exchanges.map((exchange) => exchange.taskId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toHaveLength(tied.length);
      expect(new Set(seen)).toEqual(new Set(tied));
      expect(seen).toEqual([...seen].sort().reverse());
    });
  });

  it("keeps an approved answer private until the external agent retrieves it", () => {
    const task = begin("Can a fictional summary be shared?");
    const candidate = "A fictional summary approved once.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external-token",
      review: { ...baseReview, fallbackCause: "low_confidence" },
      now: 450,
      outcome: {
        kind: "approval",
        approvalId: "approval-approved",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });
    recordAnswerEgress(db, {
      id: "egress-approval-required",
      taskId: task.taskId,
      ownerId: "token:external-token",
      endpoint: "/answer",
      now: 455,
    });
    resolvePrivacyApproval(db, {
      approvalId: "approval-approved",
      action: "approve",
      requestContext: { requestId: "admin-request", tokenId: null, deviceId: null },
      releaseId: "release-approved",
      now: 460,
    });

    expect(exchanges(task.conversationId)[0]).toMatchObject({
      outcome: "ready",
      sharedAnswer: null,
      sharedAt: null,
      pendingCandidate: null,
      userDecision: "approved",
      approval: { status: "approved" },
      review: { fallbackCause: "low_confidence" },
    });
    expect(latestPrivacyExchangeOutcomes(db, [task.conversationId])).toEqual(
      new Map([[task.conversationId, "ready"]]),
    );

    recordAnswerEgress(db, {
      id: "egress-release-approved",
      taskId: task.taskId,
      ownerId: "token:external-token",
      endpoint: "/answer/tasks/:id",
      now: 470,
    });
    expect(exchanges(task.conversationId)[0]).toMatchObject({
      outcome: "shared",
      sharedAnswer: candidate,
      sharedAt: 470,
      pendingCandidate: null,
      userDecision: "approved",
    });
    expect(latestPrivacyExchangeOutcomes(db, [task.conversationId])).toEqual(
      new Map([[task.conversationId, "shared"]]),
    );
  });

  it("shows user denial and hard stops as nothing shared", () => {
    const denied = begin("Can a fictional private detail be shared?");
    const candidate = "A held fictional detail.";
    completeAnswerTask(db, {
      taskId: denied.taskId,
      ownerId: "token:external-token",
      review: { ...baseReview, fallbackCause: "policy_requires_review" },
      now: 550,
      outcome: {
        kind: "approval",
        approvalId: "approval-denied",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });
    resolvePrivacyApproval(db, {
      approvalId: "approval-denied",
      action: "deny",
      requestContext: { requestId: "admin-request", tokenId: null, deviceId: null },
      releaseId: "unused-release",
      now: 560,
    });
    expect(exchanges(denied.conversationId)[0]).toMatchObject({
      outcome: "not_shared",
      sharedAnswer: null,
      pendingCandidate: null,
      userDecision: "denied",
    });

    const hardStop = begin("Return a forbidden fictional credential.");
    completeAnswerTask(db, {
      taskId: hardStop.taskId,
      ownerId: "token:external-token",
      review: { ...baseReview, fallbackCause: "hard_stop" },
      now: 650,
      outcome: { kind: "deny", reason: "hard_stop" },
    });
    expect(exchanges(hardStop.conversationId)[0]).toMatchObject({
      outcome: "not_shared",
      sharedAnswer: null,
      pendingCandidate: null,
      userDecision: null,
      review: { fallbackCause: "hard_stop" },
    });
  });

  it("shows the recorded draft and unavailable approval reason for unattended requests", () => {
    const task = begin("Can a fictional access instruction be shared?");
    const candidate = "Use the fictional reception desk during business hours.";
    appendAnswerAuditEvent(db, {
      id: "audit-unattended-candidate",
      taskId: task.taskId,
      ownerId: "token:external-token",
      kind: "candidate_generated",
      display: auditDisplay({
        title: "Candidate inside Omnesis",
        digest: digestCandidate(candidate),
      }),
      payload: { candidateAnswer: candidate, candidateDigest: digestCandidate(candidate) },
      now: 745,
    });
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external-token",
      review: { ...baseReview, fallbackCause: "policy_requires_review" },
      now: 750,
      outcome: { kind: "deny", reason: "approval_not_available" },
    });

    expect(exchanges(task.conversationId)[0]).toMatchObject({
      outcome: "not_shared",
      draftAnswer: candidate,
      pendingCandidate: null,
      denialReason: "approval_not_available",
      approval: null,
    });

    db.prepare("UPDATE answer_audit_payloads SET payload_json = ? WHERE event_id = ?").run(
      JSON.stringify({ candidateAnswer: "A substituted fictional answer." }),
      "audit-unattended-candidate",
    );
    expect(exchanges(task.conversationId)[0]?.draftAnswer).toBeNull();
  });

  it("reports attention only after three recent operational reviewer failures", () => {
    const now = 100_000_000;
    const causes = ["context_window_exceeded", "output_truncated", "invalid_output"] as const;
    for (const [index, fallbackCause] of causes.entries()) {
      const task = begin(`Synthetic operational review ${index}`, now - (index + 1) * 1_000);
      const candidate = `Held synthetic answer ${index}`;
      completeAnswerTask(db, {
        taskId: task.taskId,
        ownerId: "token:external-token",
        review: { ...baseReview, fallbackCause },
        now: now - (index + 1) * 1_000 + 1,
        outcome: {
          kind: "approval",
          approvalId: `approval-health-${index}`,
          candidateAnswer: candidate,
          candidateDigest: digestCandidate(candidate),
          releaseStatus: "released",
          reductions: [],
          expiresAt: now + 100_000,
        },
      });
      if (index === 1) {
        expect(getPrivacyReviewerHealth(db, now)).toMatchObject({
          status: "ok",
          recentOperationalFailureCount: 2,
        });
      }
    }

    const policyReview = begin("Synthetic policy review", now - 500);
    completeAnswerTask(db, {
      taskId: policyReview.taskId,
      ownerId: "token:external-token",
      review: { ...baseReview, fallbackCause: "policy_requires_review" },
      now: now - 499,
      outcome: { kind: "deny", reason: "privacy_policy" },
    });

    expect(getPrivacyReviewerHealth(db, now)).toEqual({
      status: "attention",
      recentOperationalFailureCount: 3,
      lastFailureAt: now - 1_000,
    });
    expect(
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT COUNT(*) AS failure_count, MAX(created_at) AS last_failure_at
             FROM answer_tasks
            WHERE created_at >= ?
              AND CASE
                    WHEN json_valid(review_json)
                    THEN json_extract(review_json, '$.fallbackCause')
                    ELSE NULL
                  END IN ('not_configured', 'request_failed', 'context_window_exceeded', 'output_truncated', 'invalid_output')`,
        )
        .all(now - 24 * 60 * 60 * 1_000),
    ).toEqual([
      expect.objectContaining({ detail: expect.stringContaining("idx_answer_tasks_created_at") }),
    ]);
    expect(getPrivacyReviewerHealth(db, now + 24 * 60 * 60 * 1_000)).toEqual({
      status: "ok",
      recentOperationalFailureCount: 0,
      lastFailureAt: null,
    });
  });

  it("keeps reviewer failure time stable when the user resolves an approval later", () => {
    const now = 200_000_000;
    const createdAt = now - 1_000;
    const task = begin("Synthetic delayed approval review", createdAt);
    const candidate = "A fictional summary held after an operational reviewer failure.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:external-token",
      review: { ...baseReview, fallbackCause: "request_failed" },
      now: createdAt + 100,
      outcome: {
        kind: "approval",
        approvalId: "approval-delayed-health",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: now + 100_000,
      },
    });
    expect(getPrivacyReviewerHealth(db, now)).toMatchObject({
      recentOperationalFailureCount: 1,
      lastFailureAt: createdAt,
    });

    resolvePrivacyApproval(db, {
      approvalId: "approval-delayed-health",
      action: "approve",
      requestContext: { requestId: "admin-delayed", tokenId: null, deviceId: null },
      releaseId: "release-delayed-health",
      now: now + 50_000,
    });

    expect(getPrivacyReviewerHealth(db, now + 60_000)).toMatchObject({
      recentOperationalFailureCount: 1,
      lastFailureAt: createdAt,
    });
  });
});

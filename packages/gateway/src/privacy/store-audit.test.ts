// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordMcpToolInvocationAudit } from "../access/store.js";
import { externalAnswerOwnerId } from "../access/corpus-authorization.js";
import { runSchemaSetup } from "../data/schema.js";
import {
  appendAnswerAuditEvents,
  auditDisplay,
  beginAnswerTask,
  completeAnswerTask,
  createAnswerPrivacyTables,
  deletePrivacyConversation,
  digestCandidate,
  getPrivacyAuditEvent,
  getPrivacyApproval,
  getPrivacyConversation,
  listPrivacyAuditEvents,
  listPrivacyConversations,
  loadPrivacyReviewerContext,
  MAX_DISTINCT_ANSWER_EGRESS_RESPONSES_PER_TASK,
  recordAnswerEgress,
  resolvePrivacyApproval,
} from "./store.js";
import { policyRevision } from "./policy-store.js";
import type { Db } from "../data/types.js";
import type { AnswerStoreError } from "./store.js";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";

const review: PrivacyReviewRecord = {
  recipeVersion: "privacy-reviewer-v2",
  provider: "synthetic-provider",
  model: "synthetic-reviewer",
  confidence: 0.96,
  policyRevision: "policy-a",
  envelopeDigest: "envelope-a",
  findings: [
    {
      category: "schedule",
      detailLevel: "summary",
      subject: "user",
      disposition: "allow",
      description: "General schedule information.",
    },
  ],
  rationale: "Allowed by the synthetic policy.",
};

const resolutionRequest = {
  requestId: "request-admin-1",
  tokenId: "token-admin-1",
  deviceId: "device-admin-1",
};
const LEGACY_ANSWER_EGRESS_EVENT_CAP = 1_000;

describe("trusted answer audit store", () => {
  let db: Database.Database;
  let serial: number;
  const tempDirs: string[] = [];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE tokens (id TEXT PRIMARY KEY)");
    createAnswerPrivacyTables(db);
    serial = 0;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function begin(options: { conversationId?: string; workflowId?: string; now?: number } = {}) {
    serial += 1;
    return beginAnswerTask(db, {
      ownerId: "token:synthetic",
      conversationId: options.conversationId,
      workflowId: options.workflowId,
      clientRequestId: `request-${serial}`,
      question: `Synthetic planning question ${serial}`,
      workflowName: "Planning assistant",
      workflowPurpose: "Prepare a fictional planning summary.",
      ids: {
        workflowId: `workflow-${serial}`,
        conversationId: `conversation-${serial}`,
        taskId: `task-${serial}`,
      },
      now: options.now ?? serial * 100,
      workflowExpiresAt: 100_000,
    });
  }

  it("paginates metadata separately from lazy trusted payloads", () => {
    const first = begin({ now: 100 });
    appendAnswerAuditEvents(db, [
      {
        id: "audit-candidate",
        taskId: first.taskId,
        ownerId: "token:synthetic",
        kind: "candidate_generated",
        display: auditDisplay({
          title: "Candidate inside Omnesis",
          text: "A bounded preview.",
          digest: "candidate-digest",
        }),
        payload: { candidateAnswer: "Full trusted candidate text." },
        now: 110,
      },
      {
        id: "audit-review",
        taskId: first.taskId,
        ownerId: "token:synthetic",
        kind: "privacy_review",
        display: auditDisplay({ title: "Privacy review", status: "ask" }),
        payload: { review },
        now: 120,
      },
    ]);
    const second = begin({ now: 200 });

    const firstPage = listPrivacyConversations(db, 1);
    expect(firstPage.conversations.map((conversation) => conversation.id)).toEqual([
      second.conversationId,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(
      listPrivacyConversations(db, 1, firstPage.nextCursor ?? undefined).conversations.map(
        (conversation) => conversation.id,
      ),
    ).toEqual([first.conversationId]);

    const eventPage = listPrivacyAuditEvents(db, first.conversationId, 10);
    expect(eventPage?.events.map((event) => event.kind)).toEqual([
      "external_request",
      "candidate_generated",
      "privacy_review",
    ]);
    expect(JSON.stringify(eventPage)).not.toContain("Full trusted candidate text.");
    expect(getPrivacyAuditEvent(db, first.conversationId, "audit-candidate")?.payload).toEqual({
      candidateAnswer: "Full trusted candidate text.",
    });
  });

  it("records the first occurrence of exact serialized egress bytes", () => {
    const task = begin();
    const response = completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "release",
        releaseId: "release-1",
        answer: "Friday afternoon.",
        expectedDisclosureRevision: 0,
      },
    });

    const first = recordAnswerEgress(db, {
      id: "egress-1",
      taskId: task.taskId,
      ownerId: "token:synthetic",
      endpoint: "/answer",
      now: 210,
    });
    const second = recordAnswerEgress(db, {
      id: "egress-2",
      taskId: task.taskId,
      ownerId: "token:synthetic",
      endpoint: "/answer/tasks/:id",
      now: 220,
    });

    expect(first?.responseJson).toBe(JSON.stringify(response));
    expect(second?.responseJson).toBe(first?.responseJson);
    expect(getPrivacyAuditEvent(db, task.conversationId, "audit_egress-1")?.payload).toMatchObject({
      responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      exactResponseJson: JSON.stringify(response),
    });
    db.prepare(
      `UPDATE answer_audit_payloads
          SET payload_json = '{"truncated":true,"reason":"owner_limit"}'
        WHERE event_id = 'audit_egress-1'`,
    ).run();
    expect(getPrivacyAuditEvent(db, task.conversationId, "audit_egress-1")?.payload).toMatchObject({
      truncated: true,
      exactResponseJson: JSON.stringify(response),
    });
    expect(db.prepare("SELECT * FROM answer_egress_events").all()).toHaveLength(1);
    expect(
      db.prepare("SELECT * FROM answer_audit_events WHERE event_type = 'egress'").all(),
    ).toHaveLength(1);
    expect(db.prepare("SELECT * FROM answer_egress_payloads").all()).toHaveLength(1);
    expect(
      db
        .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM answer_egress_events WHERE task_id = ?")
        .all(task.taskId),
    ).toEqual([
      expect.objectContaining({ detail: expect.stringContaining("idx_answer_egress_task") }),
    ]);
  });

  it("names the OAuth principal in the presented egress ledger", () => {
    const fullDb = new Database(":memory:") as unknown as Db;
    fullDb.pragma("foreign_keys = ON");
    runSchemaSetup(fullDb);
    fullDb.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('principal-ledger', 'Mosaic assistant', 'interactive', 100, 100);
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
      VALUES ('grant-ledger', 'principal-ledger', 'Answer access', 100, 100);
      INSERT INTO principal_credentials
        (id, grant_id, oauth_client_id, kind, status, label, created_at)
      VALUES ('credential-ledger', 'grant-ledger', 'client-ledger',
        'interactive', 'active', 'Desktop connection', 100);
    `);
    const ownerId = externalAnswerOwnerId({
      principalId: "principal-ledger",
      grantId: "grant-ledger",
      grantRevision: 1,
      credentialId: "credential-ledger",
      accessTokenId: "access-token-ledger",
      capability: "answer",
      sourceMode: "all",
      sourceIds: [],
      releaseMode: "unreviewed",
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
      digest: "fictional-scope-digest",
      restricted: false,
      allowsSource: () => true,
    } as Parameters<typeof externalAnswerOwnerId>[0]);
    const task = beginAnswerTask(fullDb, {
      ownerId,
      clientRequestId: "request-ledger",
      question: "Prepare a fictional planning summary.",
      workflowName: "Planning assistant",
      workflowPurpose: "Prepare a fictional planning summary.",
      ids: {
        workflowId: "workflow-ledger",
        conversationId: "conversation-ledger",
        taskId: "task-ledger",
      },
      now: 100,
      workflowExpiresAt: 10_000,
    });
    completeAnswerTask(fullDb, {
      taskId: task.taskId,
      ownerId,
      review,
      now: 200,
      outcome: {
        kind: "release",
        releaseId: "release-ledger",
        answer: "A fictional released summary.",
        expectedDisclosureRevision: 0,
      },
    });
    recordAnswerEgress(fullDb, {
      id: "egress-ledger",
      taskId: task.taskId,
      ownerId,
      endpoint: "/mcp",
      now: 210,
    });

    const egress = listPrivacyAuditEvents(fullDb, task.conversationId, 20)?.events.find(
      (event) => event.kind === "egress",
    );
    expect(egress?.display.text).toBe(
      "The first occurrence of this canonical Answer response was disclosed to Mosaic assistant.",
    );
    fullDb.close();
  });

  it("commits MCP authority attribution and Answer egress atomically", () => {
    const task = begin();
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "release",
        releaseId: "release-atomic-egress",
        answer: "A fictional released summary.",
        expectedDisclosureRevision: 0,
      },
    });
    db.exec("CREATE TABLE mcp_audit_marker (id TEXT PRIMARY KEY)");
    const audit = {
      accessTokenId: "access-token-atomic",
      principalId: "principal-atomic",
      grantId: "grant-atomic",
      grantRevision: 1,
      credentialId: "credential-atomic",
      oauthClientId: "client-atomic",
      capability: "answer" as const,
      tool: "ask_omnesis",
      outcome: "ok" as const,
      requestId: "request-atomic",
      sourceMode: "all" as const,
      requireActiveAuthority: true,
    };

    expect(() =>
      recordAnswerEgress(
        db,
        {
          id: "egress-atomic-refused",
          taskId: task.taskId,
          ownerId: "token:synthetic",
          endpoint: "/mcp",
          now: 210,
          mcpInvocationAudit: audit,
        },
        (writerDb) => {
          writerDb.prepare("INSERT INTO mcp_audit_marker (id) VALUES (?)").run("rolled-back");
          return false;
        },
      ),
    ).toThrow("MCP authority changed before Answer egress");
    expect(db.prepare("SELECT * FROM mcp_audit_marker").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM answer_egress_events").all()).toEqual([]);

    const released = recordAnswerEgress(
      db,
      {
        id: "egress-atomic-allowed",
        taskId: task.taskId,
        ownerId: "token:synthetic",
        endpoint: "/mcp",
        now: 220,
        mcpInvocationAudit: audit,
      },
      (writerDb) => {
        writerDb.prepare("INSERT INTO mcp_audit_marker (id) VALUES (?)").run("committed");
        return true;
      },
    );
    expect(released?.response).toMatchObject({ status: "released" });
    expect(db.prepare("SELECT id FROM mcp_audit_marker").all()).toEqual([{ id: "committed" }]);
    expect(db.prepare("SELECT id FROM answer_egress_events").all()).toEqual([
      { id: "egress-atomic-allowed" },
    ]);
  });

  it("uses writer time to fence authority that expired while egress waited", () => {
    const fullDb = new Database(":memory:") as unknown as Db;
    fullDb.pragma("foreign_keys = ON");
    runSchemaSetup(fullDb);
    const capturedAt = 1_800_000_000_000;
    const expiresAt = capturedAt + 500;
    fullDb.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('principal-writer-time', 'Synthetic principal', 'interactive', ${capturedAt - 1_000}, ${capturedAt - 1_000});
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
      VALUES ('grant-writer-time', 'principal-writer-time', 'Synthetic grant', ${capturedAt - 1_000}, ${capturedAt - 1_000});
      INSERT INTO access_grant_capabilities
        (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
      VALUES ('grant-writer-time', 'answer', 'all', '[]', 'unreviewed', NULL);
      INSERT INTO principal_credentials
        (id, grant_id, oauth_client_id, kind, status, label, created_at)
      VALUES ('credential-writer-time', 'grant-writer-time', 'client-writer-time',
        'interactive', 'active', 'Synthetic client', ${capturedAt - 1_000});
      INSERT INTO oauth_access_tokens
        (id, credential_id, token_hash, audience, scope, grant_revision, created_at, expires_at)
      VALUES ('access-writer-time', 'credential-writer-time', 'synthetic-hash',
        'https://gateway.example/mcp', 'omnesis:access', 1, ${capturedAt - 1_000}, ${expiresAt});
    `);
    const task = beginAnswerTask(fullDb, {
      ownerId: "token:synthetic",
      clientRequestId: "request-writer-time",
      question: "Prepare a synthetic planning summary.",
      workflowName: "Synthetic assistant",
      workflowPurpose: "Exercise the writer-time authority fence.",
      ids: {
        workflowId: "workflow-writer-time",
        conversationId: "conversation-writer-time",
        taskId: "task-writer-time",
      },
      now: capturedAt,
      workflowExpiresAt: capturedAt + 60_000,
    });
    completeAnswerTask(fullDb, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: capturedAt,
      outcome: {
        kind: "release",
        releaseId: "release-writer-time",
        answer: "A synthetic released summary.",
        expectedDisclosureRevision: 0,
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    try {
      expect(() =>
        recordAnswerEgress(
          fullDb,
          {
            id: "egress-writer-time",
            taskId: task.taskId,
            ownerId: "token:synthetic",
            endpoint: "/mcp",
            // This timestamp was captured before the writer queue wait and is
            // deliberately still earlier than token expiry.
            now: capturedAt,
            mcpInvocationAudit: {
              accessTokenId: "access-writer-time",
              principalId: "principal-writer-time",
              grantId: "grant-writer-time",
              grantRevision: 1,
              credentialId: "credential-writer-time",
              oauthClientId: "client-writer-time",
              capability: "answer",
              tool: "ask_omnesis",
              outcome: "ok",
              requestId: "request-writer-time",
              sourceMode: "all",
              requireActiveAuthority: true,
            },
          },
          (writerDb, audit) => recordMcpToolInvocationAudit(writerDb as unknown as Db, audit),
        ),
      ).toThrow("MCP authority changed before Answer egress");
    } finally {
      clock.mockRestore();
    }
    expect(fullDb.prepare("SELECT COUNT(*) AS count FROM answer_egress_events").get()).toEqual({
      count: 0,
    });
    expect(fullDb.prepare("SELECT COUNT(*) AS count FROM access_audit_events").get()).toEqual({
      count: 0,
    });
    fullDb.close();
  });

  it("checks a directly edited policy file at the release commit boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-policy-guard-"));
    tempDirs.push(dir);
    const path = join(dir, "privacy-policy.md");
    const reviewedPolicy = "# Synthetic policy\n\nAllow general planning summaries.\n";
    writeFileSync(path, reviewedPolicy, "utf8");
    const task = begin();
    writeFileSync(path, "# Synthetic policy\n\nRequire approval for every answer.\n", "utf8");

    expect(() =>
      completeAnswerTask(db, {
        taskId: task.taskId,
        ownerId: "token:synthetic",
        review,
        now: 200,
        outcome: {
          kind: "release",
          releaseId: "release-policy-race",
          answer: "A general planning summary.",
          expectedDisclosureRevision: 0,
          policyGuard: { path, expectedRevision: policyRevision(reviewedPolicy) },
        },
      }),
    ).toThrowError(expect.objectContaining<Partial<AnswerStoreError>>({ code: "policy_changed" }));
    expect(db.prepare("SELECT id FROM answer_releases").all()).toEqual([]);
    expect(db.prepare("SELECT status FROM answer_tasks WHERE id = ?").get(task.taskId)).toEqual({
      status: "running",
    });
  });

  it("guards a legacy on-disk policy by the same effective revision used for review", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-legacy-policy-guard-"));
    tempDirs.push(dir);
    const path = join(dir, "privacy-policy.md");
    const legacyPolicy = `# Legacy policy

| Information | Summary | Exact or original |
| --- | --- | --- |
| Schedule availability | Allow | Approval required |

\`\`\`omnesis-watch-auto-approval
integrations: fictional
\`\`\`
`;
    writeFileSync(path, legacyPolicy, "utf8");
    const task = begin();

    expect(
      completeAnswerTask(db, {
        taskId: task.taskId,
        ownerId: "token:synthetic",
        review,
        now: 200,
        outcome: {
          kind: "release",
          releaseId: "release-legacy-policy",
          answer: "A general planning summary.",
          expectedDisclosureRevision: 0,
          policyGuard: { path, expectedRevision: policyRevision(legacyPolicy) },
        },
      }).status,
    ).toBe("released");
    expect(readFileSync(path, "utf8")).toBe(legacyPolicy);
  });

  it("replaces an oversized audit payload with an explicit hashed truncation record", () => {
    const task = begin();
    appendAnswerAuditEvents(db, [
      {
        id: "audit-oversized",
        taskId: task.taskId,
        ownerId: "token:synthetic",
        kind: "agent_trace",
        display: auditDisplay({ title: "Agent activity" }),
        payload: { toolResult: "x".repeat(8 * 1024 * 1024) },
        now: 200,
      },
    ]);

    const event = getPrivacyAuditEvent(db, task.conversationId, "audit-oversized");
    expect(event).toMatchObject({
      payloadTruncated: true,
      payload: {
        truncated: true,
        reason: "event_limit",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("bounds distinct egress responses before recording or returning another response", () => {
    const task = begin();
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: { kind: "deny", reason: "privacy_policy" },
    });
    const insertPayload = db.prepare(
      `INSERT INTO answer_egress_payloads (digest, response_json, response_bytes)
       VALUES (?, ?, ?)`,
    );
    const insertEgress = db.prepare(
      `INSERT INTO answer_egress_events (
         id, task_id, conversation_id, owner_id, endpoint, http_status,
         response_digest, created_at
       ) VALUES (?, ?, ?, 'token:synthetic', '/answer/tasks/:id', 200, ?, ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < MAX_DISTINCT_ANSWER_EGRESS_RESPONSES_PER_TASK; index += 1) {
        const json = JSON.stringify({ syntheticVariant: index });
        const digest = createHash("sha256").update(json, "utf8").digest("hex");
        insertPayload.run(digest, json, Buffer.byteLength(json, "utf8"));
        insertEgress.run(
          `egress-distinct-${index}`,
          task.taskId,
          task.conversationId,
          digest,
          300 + index,
        );
      }
    })();

    expect(() =>
      recordAnswerEgress(db, {
        id: "egress-over-limit",
        taskId: task.taskId,
        ownerId: "token:synthetic",
        endpoint: "/answer/tasks/:id",
        now: 2_000,
      }),
    ).toThrowError(expect.objectContaining<Partial<AnswerStoreError>>({ code: "egress_limit" }));
    expect(
      db
        .prepare(
          "SELECT COUNT(DISTINCT response_digest) AS count FROM answer_egress_events WHERE task_id = ?",
        )
        .get(task.taskId),
    ).toEqual({ count: MAX_DISTINCT_ANSWER_EGRESS_RESPONSES_PER_TASK });
  });

  it("records an approved terminal response after a legacy pending poll ledger is full", () => {
    const task = begin();
    const candidate = "A fictional approved planning summary.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review: { ...review, fallbackCause: "policy_requires_review" },
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-after-legacy-polls",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });
    recordAnswerEgress(db, {
      id: "egress-pending-first",
      taskId: task.taskId,
      ownerId: "token:synthetic",
      endpoint: "/answer",
      now: 210,
    });
    const duplicate = db.prepare(
      `INSERT INTO answer_egress_events (
         id, task_id, conversation_id, owner_id, endpoint, http_status,
         response_digest, created_at
       )
       SELECT ?, task_id, conversation_id, owner_id, endpoint, http_status,
              response_digest, ?
         FROM answer_egress_events WHERE id = 'egress-pending-first'`,
    );
    db.transaction(() => {
      for (let index = 1; index < LEGACY_ANSWER_EGRESS_EVENT_CAP; index += 1) {
        duplicate.run(`egress-pending-legacy-${index}`, 210 + index);
      }
    })();
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM answer_egress_events WHERE task_id = ?")
        .get(task.taskId),
    ).toEqual({ count: LEGACY_ANSWER_EGRESS_EVENT_CAP });

    resolvePrivacyApproval(db, {
      approvalId: "approval-after-legacy-polls",
      action: "approve",
      requestContext: resolutionRequest,
      releaseId: "release-after-legacy-polls",
      now: 2_000,
    });
    const terminal = recordAnswerEgress(db, {
      id: "egress-terminal-after-legacy-polls",
      taskId: task.taskId,
      ownerId: "token:synthetic",
      endpoint: "/answer/tasks/:id",
      now: 2_010,
    });
    expect(terminal?.response).toMatchObject({
      status: "released",
      answer: candidate,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM answer_egress_events WHERE task_id = ?")
        .get(task.taskId),
    ).toEqual({ count: LEGACY_ANSWER_EGRESS_EVENT_CAP + 1 });
    recordAnswerEgress(db, {
      id: "egress-terminal-duplicate",
      taskId: task.taskId,
      ownerId: "token:synthetic",
      endpoint: "/answer/tasks/:id",
      now: 2_020,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM answer_egress_events WHERE task_id = ?")
        .get(task.taskId),
    ).toEqual({ count: LEGACY_ANSWER_EGRESS_EVENT_CAP + 1 });
  });

  it("keeps cumulative workflow disclosure separate from released conversation context", () => {
    const first = begin();
    completeAnswerTask(db, {
      taskId: first.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "release",
        releaseId: "release-1",
        answer: "Friday afternoon.",
        expectedDisclosureRevision: 0,
      },
    });
    const second = begin({ workflowId: first.workflowId, now: 300 });
    db.exec(`CREATE TABLE subscription_workflow_disclosure (
      workflow_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      existence_signals INTEGER NOT NULL,
      categories_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.prepare(
      `INSERT INTO subscription_workflow_disclosure
         (workflow_id, revision, existence_signals, categories_json, updated_at)
       VALUES (?, 2, 3, '[{"category":"documents","detailLevel":"existence","subject":"unknown","count":3}]', 300)`,
    ).run(first.workflowId);

    const context = loadPrivacyReviewerContext(
      db,
      first.workflowId,
      second.conversationId,
      "token:synthetic",
    );
    expect(context.priorExternalConversation).toEqual([]);
    expect(context.cumulativeDisclosure).toMatchObject({
      revision: 1,
      existenceRevision: 2,
      existenceSignals: 3,
      releasedTurns: 1,
      releasedCharacters: "Friday afternoon.".length,
      categories: [
        { category: "documents", detailLevel: "existence", subject: "unknown", count: 3 },
        { category: "schedule", count: 1 },
      ],
    });

    expect(deletePrivacyConversation(db, { conversationId: first.conversationId, now: 400 })).toBe(
      true,
    );
    const afterDeletion = begin({ workflowId: first.workflowId, now: 500 });
    expect(
      loadPrivacyReviewerContext(
        db,
        first.workflowId,
        afterDeletion.conversationId,
        "token:synthetic",
      ).cumulativeDisclosure,
    ).toMatchObject({
      revision: 1,
      existenceRevision: 2,
      existenceSignals: 3,
      releasedTurns: 1,
      releasedCharacters: "Friday afternoon.".length,
      categories: [
        { category: "documents", detailLevel: "existence", subject: "unknown", count: 3 },
        { category: "schedule", count: 1 },
      ],
    });
  });

  it("rejects a release reviewed against a stale workflow disclosure revision", () => {
    const first = begin();
    const second = begin({ workflowId: first.workflowId, now: 200 });
    completeAnswerTask(db, {
      taskId: first.taskId,
      ownerId: "token:synthetic",
      review,
      now: 300,
      outcome: {
        kind: "release",
        releaseId: "release-first",
        answer: "A general planning summary.",
        expectedDisclosureRevision: 0,
      },
    });

    expect(() =>
      completeAnswerTask(db, {
        taskId: second.taskId,
        ownerId: "token:synthetic",
        review,
        now: 310,
        outcome: {
          kind: "release",
          releaseId: "release-stale",
          answer: "Another general planning summary.",
          expectedDisclosureRevision: 0,
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AnswerStoreError>>({ code: "disclosure_changed" }),
    );
    expect(db.prepare("SELECT id FROM answer_releases ORDER BY id").all()).toEqual([
      { id: "release-first" },
    ]);
  });

  it("preserves reduced release semantics through a later approval", () => {
    const task = begin();
    const candidate = "Generalized planning answer.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-reduced",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released_with_reductions",
        reductions: ["Removed an exact date"],
        expiresAt: 10_000,
      },
    });
    const heldEgress = recordAnswerEgress(db, {
      id: "egress-held-reduction",
      taskId: task.taskId,
      ownerId: "token:synthetic",
      endpoint: "/answer",
      now: 250,
    });

    expect(
      resolvePrivacyApproval(db, {
        approvalId: "approval-reduced",
        action: "approve",
        requestContext: resolutionRequest,
        releaseId: "release-reduced",
        now: 300,
      }),
    ).toMatchObject({
      status: "released_with_reductions",
      answer: candidate,
      reductions: ["Removed an exact date"],
    });
    expect(
      getPrivacyAuditEvent(db, task.conversationId, "audit_egress-held-reduction")?.payload,
    ).toMatchObject({ exactResponseJson: heldEgress?.responseJson });
    expect(JSON.parse(heldEgress!.responseJson)).toMatchObject({ status: "approval_required" });
  });

  function appendCandidate(taskId: string, candidate: string, now: number): string {
    const id = `audit-candidate-${taskId}`;
    appendAnswerAuditEvents(db, [
      {
        id,
        taskId,
        ownerId: "token:synthetic",
        kind: "candidate_generated",
        display: auditDisplay({
          title: "Candidate inside Omnesis",
          text: candidate,
          digest: digestCandidate(candidate),
        }),
        payload: { candidateAnswer: candidate, candidateDigest: digestCandidate(candidate) },
        now,
      },
    ]);
    return id;
  }

  function releasedEvent(conversationId: string) {
    const events = listPrivacyAuditEvents(db, conversationId, 50)?.events ?? [];
    return events.find((event) => event.kind === "released");
  }

  it("stops the release step from reprinting the candidate it released unchanged", () => {
    const task = begin();
    const candidate = "The rehearsal is confirmed for Thursday afternoon.";
    appendCandidate(task.taskId, candidate, 150);
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "release",
        releaseId: "release-unchanged",
        answer: candidate,
        expectedDisclosureRevision: 0,
      },
    });

    const events = listPrivacyAuditEvents(db, task.conversationId, 50)?.events ?? [];
    const released = events.find((event) => event.kind === "released");
    expect(released?.display.text).toBeNull();
    expect(released?.answerComparison).toEqual({ kind: "identical" });
    const candidateEvent = events.find((event) => event.kind === "candidate_generated");
    expect(candidateEvent?.display.text).toBe(candidate);
    expect(candidateEvent?.answerComparison).toBeNull();

    const detail = getPrivacyAuditEvent(db, task.conversationId, released!.id);
    expect(detail?.display.text).toBeNull();
    expect(detail?.answerComparison).toEqual({ kind: "identical" });
    expect(detail?.payload).toMatchObject({ answer: candidate });
  });

  it("stops an approved release from reprinting the candidate it held", () => {
    const task = begin();
    const candidate = "The rehearsal is confirmed for Thursday afternoon.";
    appendCandidate(task.taskId, candidate, 150);
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-unchanged",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });
    resolvePrivacyApproval(db, {
      approvalId: "approval-unchanged",
      action: "approve",
      requestContext: resolutionRequest,
      releaseId: "release-approved",
      now: 300,
    });

    const released = releasedEvent(task.conversationId);
    expect(released?.display.title).toBe("Approved answer released");
    expect(released?.display.text).toBeNull();
    expect(released?.answerComparison).toEqual({ kind: "identical" });
  });

  it("shows what a reduction removed from the candidate", () => {
    const task = begin();
    const candidate = [
      "The showcase is confirmed for Thursday.",
      "Maya Reeves paid the deposit of 480 on the ninth.",
    ].join("\n");
    const answer = [
      "The showcase is confirmed for Thursday.",
      "Maya Reeves paid the deposit on the ninth.",
    ].join("\n");
    appendCandidate(task.taskId, candidate, 150);
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "reduce",
        releaseId: "release-reduced-diff",
        answer,
        reductions: ["An exact amount was removed."],
        expectedDisclosureRevision: 0,
      },
    });

    const released = releasedEvent(task.conversationId);
    expect(released?.display.text).toBe(answer);
    const comparison = released?.answerComparison;
    expect(comparison?.kind).toBe("diff");
    if (comparison?.kind !== "diff") throw new Error("Expected a diff comparison.");
    expect(comparison.lines.map((line) => line.op)).toEqual(["equal", "removed", "added"]);
    expect(
      (comparison.lines[1].spans ?? [])
        .filter((span) => span.op === "removed")
        .map((span) => span.text)
        .join("")
        .trim(),
    ).toBe("of 480");
    expect(getPrivacyAuditEvent(db, task.conversationId, released!.id)?.answerComparison).toEqual(
      comparison,
    );
  });

  it("leaves a release uncompared when no candidate was recorded for its task", () => {
    const task = begin();
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "reduce",
        releaseId: "release-no-candidate",
        answer: "The showcase is confirmed for Thursday.",
        reductions: ["An exact amount was removed."],
        expectedDisclosureRevision: 0,
      },
    });

    const released = releasedEvent(task.conversationId);
    expect(released?.display.text).toBe("The showcase is confirmed for Thursday.");
    expect(released?.answerComparison).toBeNull();
  });

  it("refuses to compare recorded text that no longer matches its digest", () => {
    const task = begin();
    const candidate = "Maya Reeves paid the deposit of 480 on the ninth.";
    const candidateEventId = appendCandidate(task.taskId, candidate, 150);
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "reduce",
        releaseId: "release-tampered",
        answer: "Maya Reeves paid the deposit on the ninth.",
        reductions: ["An exact amount was removed."],
        expectedDisclosureRevision: 0,
      },
    });
    db.prepare("UPDATE answer_audit_payloads SET payload_json = ? WHERE event_id = ?").run(
      JSON.stringify({ candidateAnswer: "Substituted text.", candidateDigest: "unchanged" }),
      candidateEventId,
    );

    const released = releasedEvent(task.conversationId);
    expect(released?.display.text).toBe("Maya Reeves paid the deposit on the ninth.");
    expect(released?.answerComparison).toBeNull();
  });

  it("does not let approval override a deterministic credential hard stop", () => {
    const task = begin();
    const candidate = "Bearer synthetic_token_value_1234567890";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-hard-stop",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });

    expect(
      resolvePrivacyApproval(db, {
        approvalId: "approval-hard-stop",
        action: "approve",
        requestContext: resolutionRequest,
        releaseId: "release-must-not-exist",
        now: 300,
      }),
    ).toMatchObject({ status: "denied", reason: "hard_stop" });
    expect(db.prepare("SELECT * FROM answer_releases").all()).toEqual([]);
    expect(getPrivacyApproval(db, "approval-hard-stop")?.review.fallbackCause).toBe("hard_stop");
    const resolution = listPrivacyAuditEvents(db, task.conversationId, 50)?.events.find(
      (event) => event.kind === "approval_resolved",
    );
    expect(resolution?.display.title).toBe("User approved; system blocked");
    expect(getPrivacyAuditEvent(db, task.conversationId, resolution!.id)?.payload).toMatchObject({
      status: "denied",
      action: "approve",
      outcome: "hard_stop",
      request: resolutionRequest,
    });
  });

  it("releases a detected credential only when its review carries the explicit one-time approval proof", () => {
    const task = begin();
    const candidate = "Bearer synthetic_token_value_1234567890";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review: {
        ...review,
        fallbackCause: "policy_requires_review",
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
      },
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-credential",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });

    expect(
      resolvePrivacyApproval(db, {
        approvalId: "approval-credential",
        action: "approve",
        requestContext: resolutionRequest,
        releaseId: "release-credential",
        now: 300,
      }),
    ).toMatchObject({
      status: "released",
      releaseId: "release-credential",
      answer: candidate,
    });
    expect(
      db.prepare("SELECT reductions_json FROM answer_tasks WHERE id = ?").get(task.taskId),
    ).toEqual({ reductions_json: "[]" });
    expect(db.prepare("SELECT * FROM answer_workflow_grants").all()).toEqual([]);
  });

  it("hard-deletes trusted content and tombstones the conversation id", () => {
    const task = begin();
    const candidate = "Held synthetic candidate.";
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: "token:synthetic",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-1",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        releaseStatus: "released",
        reductions: [],
        expiresAt: 10_000,
      },
    });

    expect(deletePrivacyConversation(db, { conversationId: task.conversationId, now: 300 })).toBe(
      true,
    );
    expect(getPrivacyConversation(db, task.conversationId)).toBeNull();
    expect(db.prepare("SELECT * FROM answer_tasks").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM answer_audit_payloads").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM answer_conversation_tombstones").get()).toEqual({
      id: task.conversationId,
    });

    expect(() =>
      beginAnswerTask(db, {
        ownerId: "token:synthetic",
        conversationId: task.conversationId,
        clientRequestId: "request-after-delete",
        question: "Continue the deleted conversation.",
        ids: {
          workflowId: "unused-workflow",
          conversationId: "unused-conversation",
          taskId: "unused-task",
        },
        now: 400,
        workflowExpiresAt: 100_000,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AnswerStoreError>>({ code: "conversation_deleted" }),
    );

    expect(() =>
      beginAnswerTask(db, {
        ownerId: "token:synthetic",
        clientRequestId: "request-1",
        question: "Synthetic planning question 1",
        workflowName: "Planning assistant",
        workflowPurpose: "Prepare a fictional planning summary.",
        ids: {
          workflowId: "replacement-workflow",
          conversationId: "replacement-conversation",
          taskId: "replacement-task",
        },
        now: 400,
        workflowExpiresAt: 100_000,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AnswerStoreError>>({ code: "conversation_deleted" }),
    );
  });
  describe("the status a row shows", () => {
    it.each([
      // Reviewer decisions.
      ["allow", "allowed", "Allowed"],
      ["reduce", "reduced", "Details removed"],
      ["ask", "held", "Held for review"],
      ["deny", "blocked", "Blocked"],
      // Task outcomes — the rows that say what actually left the machine.
      ["released", "allowed", "Allowed"],
      ["released_with_reductions", "reduced", "Details removed"],
      ["reduced", "reduced", "Details removed"],
      ["approval_required", "held", "Held for review"],
      ["denied", "blocked", "Blocked"],
      // Approval resolutions.
      ["approved", "allowed", "Allowed"],
      ["expired", "blocked", "Blocked"],
    ] as const)("maps the producer token %s", (token, code, label) => {
      expect(auditDisplay({ title: "Synthetic row", status: token }).status).toEqual({
        code,
        label,
      });
    });

    it.each(["running", "failed"] as const)(
      "shows no outcome for %s, because none was decided",
      (token) => {
        // A request in flight has no outcome yet and a broken one has none at
        // all. Badging either would claim a privacy decision Omnesis never made.
        expect(auditDisplay({ title: "Synthetic row", status: token }).status).toBeNull();
      },
    );

    it("badges the outcome rows the writers actually produce", () => {
      const released = begin({ now: 100 });
      completeAnswerTask(db, {
        taskId: released.taskId,
        ownerId: "token:synthetic",
        review,
        now: 150,
        outcome: {
          kind: "release",
          releaseId: "release-status",
          answer: "A fictional planning summary.",
          expectedDisclosureRevision: 0,
        },
      });
      const denied = begin({ now: 200 });
      completeAnswerTask(db, {
        taskId: denied.taskId,
        ownerId: "token:synthetic",
        review,
        now: 250,
        outcome: { kind: "deny", reason: "privacy_policy" },
      });

      const statuses = (conversationId: string) =>
        new Map(
          listPrivacyAuditEvents(db, conversationId, 50)!.events.map((event) => [
            event.display.title,
            event.display.status?.code ?? null,
          ]),
        );

      expect(statuses(released.conversationId).get("Released unchanged")).toBe("allowed");
      expect(statuses(denied.conversationId).get("Nothing released")).toBe("blocked");
      // The request that opened each exchange is still in flight when it is
      // written, so it carries no outcome.
      expect(statuses(released.conversationId).get("External request")).toBeNull();
    });

    it("renders nothing for a token written by a gateway this one does not know", () => {
      const task = begin({ now: 100 });
      // A model stop reason reached the column on some earlier gateway. It is
      // not a privacy outcome, so it must not arrive styled as one.
      db.prepare(
        `INSERT INTO answer_audit_events (
           id, conversation_id, task_id, owner_id, event_type, display_json,
           payload_bytes, original_payload_bytes, payload_truncated, created_at
         ) VALUES (?, ?, ?, 'token:synthetic', 'privacy_review', ?, 0, 0, 0, 130)`,
      ).run(
        "audit-legacy",
        task.conversationId,
        task.taskId,
        JSON.stringify({ title: "Privacy review", status: "stop" }),
      );

      const legacy = listPrivacyAuditEvents(db, task.conversationId, 50)!.events.find(
        (event) => event.id === "audit-legacy",
      );
      expect(legacy!.display.status).toBeNull();
    });

    it("reads back a status persisted as the raw producer token", () => {
      const task = begin({ now: 100 });
      db.prepare(
        `INSERT INTO answer_audit_events (
           id, conversation_id, task_id, owner_id, event_type, display_json,
           payload_bytes, original_payload_bytes, payload_truncated, created_at
         ) VALUES (?, ?, ?, 'token:synthetic', 'released', ?, 0, 0, 0, 140)`,
      ).run(
        "audit-raw-token",
        task.conversationId,
        task.taskId,
        JSON.stringify({ title: "Released unchanged", status: "released" }),
      );

      const row = listPrivacyAuditEvents(db, task.conversationId, 50)!.events.find(
        (event) => event.id === "audit-raw-token",
      );
      expect(row!.display.status).toEqual({ code: "allowed", label: "Allowed" });
    });
  });
});

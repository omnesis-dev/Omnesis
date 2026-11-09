// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The privacy page's exchange pages, read on the real io worker against a
 * temp database: every page returns exactly what the same read on a direct
 * handle returns, and the admin service serves them from the worker without
 * touching its own handle, so moving the read off the main event loop changes
 * nothing the operator is shown.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { IoOps, ioGateFromScheduler } from "../scheduler/io-ops.js";
import { PrivacyAdminService } from "./admin-service.js";
import {
  directPrivacyExchangeReads,
  exchangePage,
  type PrivacyExchangeReads,
} from "./exchange-reads.js";
import {
  appendAnswerAuditEvent,
  auditDisplay,
  beginAnswerTask,
  completeAnswerTask,
  digestCandidate,
  failAnswerTask,
  PrivacyCursorError,
  recordAnswerEgress,
  resolvePrivacyApproval,
} from "./store.js";
import type Database from "better-sqlite3";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";

const WORKER_URL = new URL("../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

const OWNERS = ["token:feed-token", "device:feed-integration", "token:feed-missing"];
const NOW = 1_000_000;

const review: PrivacyReviewRecord = {
  recipeVersion: "privacy-reviewer-v2",
  provider: "synthetic-provider",
  model: "synthetic-reviewer",
  confidence: 0.9,
  policyRevision: "policy-a",
  fallbackCause: null,
  findings: [],
  rationale: "The fictional policy permits a schedule summary.",
};

/** One exchange of every kind the feed presents, across owners and conversations. */
function seed(db: Database.Database): void {
  db.prepare(
    "INSERT INTO devices (id, name, kind, capabilities, paired_at) VALUES (?, ?, 'agent', ?, 0)",
  ).run("feed-device", "studio laptop", "{}");
  db.prepare(
    "INSERT INTO devices (id, name, kind, capabilities, paired_at) VALUES (?, ?, 'agent', ?, 0)",
  ).run(
    "feed-integration",
    "Hermes on the studio box",
    JSON.stringify({ agentIntegration: { harness: "hermes" } }),
  );
  db.prepare(
    "INSERT INTO tokens (id, device_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, 0)",
  ).run("feed-token", "feed-device", "hash-feed", "Atlas (openclaw)");

  const kinds = [
    "release",
    "reduce",
    "pending",
    "lapsed",
    "approved",
    "user-denied",
    "hard-stop",
    "failed-named",
    "failed-generic",
    "canceled",
    "running",
  ] as const;
  let clock = 1_000;
  kinds.forEach((kind, index) => {
    const ownerId = OWNERS[index % OWNERS.length]!;
    const taskId = `feed-task-${index}`;
    // Two exchanges share a millisecond, so the cursor's tie-break is exercised.
    clock += index === 4 ? 0 : 100;
    beginAnswerTask(db, {
      ownerId,
      clientRequestId: `feed-request-${index}`,
      question: `Fictional question ${index}?`,
      ids: {
        workflowId: `feed-workflow-${index}`,
        conversationId: `feed-conversation-${index % 4}-${index}`,
        taskId,
      },
      now: clock,
      workflowExpiresAt: NOW * 10,
    });
    appendAnswerAuditEvent(db, {
      id: `feed-trace-${index}`,
      taskId,
      ownerId,
      kind: "agent_trace",
      display: auditDisplay({ title: "Agent activity" }),
      payload: {
        provider: "synthetic-provider",
        model: "synthetic-model",
        sessionId: `session-${index}`,
        terminalStopReason: kind === "canceled" ? "canceled" : "error",
        messages: [
          {
            role: "assistant",
            parts: [{ kind: "text", text: "Model request failed: http_request_error: detail" }],
          },
        ],
      },
      now: clock + 1,
    });
    const answer = `A fictional answer ${index}.`;
    const citations = [{ documentId: `doc-${index}`, sourceType: "notes", title: "Agenda" }];
    if (!["failed-named", "failed-generic", "canceled", "running"].includes(kind)) {
      appendAnswerAuditEvent(db, {
        id: `feed-candidate-${index}`,
        taskId,
        ownerId,
        kind: "candidate_generated",
        display: auditDisplay({ title: "Candidate", digest: digestCandidate(answer, citations) }),
        payload: {
          candidateAnswer: answer,
          candidateCitations: citations,
          candidateDigest: digestCandidate(answer, citations),
        },
        now: clock + 2,
      });
    }
    const at = clock + 10;
    const hold = (expiresAt: number) =>
      completeAnswerTask(db, {
        taskId,
        ownerId,
        review: { ...review, fallbackCause: "policy_requires_review" },
        now: at,
        outcome: {
          kind: "approval",
          approvalId: `feed-approval-${index}`,
          candidateAnswer: answer,
          candidateCitations: citations,
          candidateDigest: digestCandidate(answer, citations),
          releaseStatus: "released_with_reductions",
          reductions: ["Exact timing removed"],
          expiresAt,
        },
      });
    const resolve = (action: "approve" | "deny") =>
      resolvePrivacyApproval(db, {
        approvalId: `feed-approval-${index}`,
        action,
        requestContext: { requestId: `feed-admin-${index}`, tokenId: null, deviceId: null },
        releaseId: `feed-release-${index}`,
        now: at + 5,
      });
    switch (kind) {
      case "release":
      case "reduce":
        completeAnswerTask(db, {
          taskId,
          ownerId,
          review,
          now: at,
          outcome:
            kind === "release"
              ? {
                  kind: "release",
                  releaseId: `feed-release-${index}`,
                  answer,
                  citations,
                  expectedDisclosureRevision: 0,
                }
              : {
                  kind: "reduce",
                  releaseId: `feed-release-${index}`,
                  answer,
                  citations,
                  reductions: ["A name generalized"],
                  expectedDisclosureRevision: 0,
                },
        });
        recordAnswerEgress(db, {
          id: `feed-egress-${index}`,
          taskId,
          ownerId,
          endpoint: "/answer",
          includeCitations: true,
          now: at + 1,
        });
        break;
      case "pending":
        hold(NOW * 2);
        break;
      case "lapsed":
        hold(NOW - 1);
        break;
      case "approved":
        hold(NOW * 2);
        resolve("approve");
        break;
      case "user-denied":
        hold(NOW * 2);
        resolve("deny");
        break;
      case "hard-stop":
        completeAnswerTask(db, {
          taskId,
          ownerId,
          review: { ...review, fallbackCause: "hard_stop" },
          now: at,
          outcome: { kind: "deny", reason: "hard_stop" },
        });
        break;
      case "failed-named":
        failAnswerTask(db, taskId, ownerId, at, {
          code: "rate_limited",
          message: "The model provider rate-limited this request. Try again shortly.",
          detail: "status 429",
        });
        break;
      case "failed-generic":
        failAnswerTask(db, taskId, ownerId, at);
        break;
      case "canceled":
        db.prepare("UPDATE answer_tasks SET status = 'canceled', resolved_at = ? WHERE id = ?").run(
          at,
          taskId,
        );
        db.prepare("UPDATE answer_conversations SET active_task_id = NULL WHERE id = ?").run(
          `feed-conversation-${index % 4}-${index}`,
        );
        break;
      case "running":
        break;
    }
  });
}

async function feedPages(reads: PrivacyExchangeReads, limit: number) {
  const pages = [];
  let cursor: string | undefined;
  do {
    const page = exchangePage(
      await reads.privacyExchangeFeed({ limit, ...(cursor ? { cursor } : {}) }, NOW),
    );
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

describe.each(["empty", "seeded"])("the %s exchange history on the io worker", (fixture) => {
  let dbPath: string;
  let db: Database.Database;
  let scheduler: Scheduler;
  let worker: PrivacyExchangeReads;
  let direct: PrivacyExchangeReads;

  beforeAll(async () => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath) as unknown as Database.Database;
    if (fixture === "seeded") seed(db);
    direct = directPrivacyExchangeReads(db);
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(
      new IoTaskRunner({
        gatewayDbPath: dbPath,
        heartbeatIntervalMs: 1_000,
        heartbeatWarnGapMs: 10_000,
        workerUrl: WORKER_URL,
        workerExecArgv: ["--import", LOADER_URL],
      }),
    );
    await scheduler.start();
    worker = ioGateFromScheduler(scheduler);
  });

  afterAll(async () => {
    await scheduler.dispose();
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  });

  it("pages the feed exactly as the handle does", async () => {
    for (const limit of [1, 3, 50]) {
      expect(await feedPages(worker, limit)).toStrictEqual(await feedPages(direct, limit));
    }
    if (fixture === "seeded") {
      const outcomes = (await feedPages(direct, 50))[0]!.exchanges.map((e) => e.outcome);
      expect(new Set(outcomes)).toEqual(
        new Set([
          "shared",
          "shared_with_reductions",
          "needs_review",
          "not_shared",
          "ready",
          "failed",
          "canceled",
          "checking",
        ]),
      );
    }
  });

  it("pages each conversation, with and without one exchange's transcripts, as the handle does", async () => {
    const tasks = (await feedPages(direct, 100)).flatMap((page) => page.exchanges);
    for (const { conversationId, taskId } of tasks) {
      for (const request of [
        { conversationId, limit: 50 },
        { conversationId, limit: 50, includeAgentTracesTaskId: taskId },
        { conversationId, limit: 1 },
      ]) {
        expect(await worker.privacyConversationExchanges(request, NOW)).toStrictEqual(
          await direct.privacyConversationExchanges(request, NOW),
        );
      }
    }
    expect(
      await worker.privacyConversationExchanges({ conversationId: "missing", limit: 50 }, NOW),
    ).toStrictEqual({ page: null });
  });

  it("refuses a malformed cursor where the handle does, and only there", async () => {
    const conversationId =
      (await feedPages(direct, 1))[0]!.exchanges[0]?.conversationId ?? "missing";
    const cases = [
      () => ["feed", { limit: 50, cursor: "not-a-cursor" }] as const,
      () => ["conversation", { conversationId, limit: 50, cursor: "not-a-cursor" }] as const,
      // A conversation that does not exist is missing, whatever its cursor.
      () =>
        ["conversation", { conversationId: "missing", limit: 50, cursor: "not-a-cursor" }] as const,
    ];
    for (const make of cases) {
      const [kind, request] = make();
      const read = (reads: PrivacyExchangeReads) =>
        kind === "feed"
          ? reads.privacyExchangeFeed(request as { limit: number; cursor: string }, NOW)
          : reads.privacyConversationExchanges(
              request as { conversationId: string; limit: number; cursor: string },
              NOW,
            );
      expect(await read(worker)).toStrictEqual(await read(direct));
    }
    expect(
      await worker.privacyConversationExchanges(
        { conversationId: "missing", limit: 50, cursor: "not-a-cursor" },
        NOW,
      ),
    ).toStrictEqual({ page: null });
    if (fixture === "seeded") {
      expect(
        await worker.privacyExchangeFeed({ limit: 50, cursor: "not-a-cursor" }, NOW),
      ).toStrictEqual({ invalidCursor: true });
    }
  });

  it("serves the admin service's pages from the worker, never its own handle", async () => {
    const service = new PrivacyAdminService({
      db: new Proxy(db, {
        get(target, property, receiver) {
          if (property === "prepare" || property === "exec") {
            return () => {
              throw new Error("the exchange pages must not read on the main handle");
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
      policyStore: {} as never,
      writeGate: {} as never,
      now: () => NOW,
      exchangeReads: worker,
    });
    const [firstPage] = await feedPages(direct, 2);
    expect(await service.listExchangeFeed(2)).toStrictEqual(firstPage);
    const conversationId = firstPage!.exchanges[0]?.conversationId ?? "missing";
    expect(await service.listExchanges(conversationId, 50)).toStrictEqual(
      exchangePage(await direct.privacyConversationExchanges({ conversationId, limit: 50 }, NOW)),
    );
    // A refused cursor reaches the route as the error it maps to a 400.
    await expect(service.listExchangeFeed(50, "not-a-cursor")).rejects.toBeInstanceOf(
      PrivacyCursorError,
    );
    if (fixture === "seeded") {
      await expect(
        service.listExchanges(conversationId, 50, "not-a-cursor"),
      ).rejects.toBeInstanceOf(PrivacyCursorError);
    }
    await expect(service.listExchanges("missing", 50, "not-a-cursor")).resolves.toBeNull();
  });
});

describe("the exchange pages' place on the io worker", () => {
  it("runs each as a user-priority io op", () => {
    for (const op of ["io.privacyExchangeFeed", "io.privacyConversationExchanges"]) {
      expect(IoOps.get(op)).toMatchObject({ runner: "io", priority: "user" });
    }
  });
});

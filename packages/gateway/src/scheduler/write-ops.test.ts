// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `writeGateFromScheduler` end-to-end test — proves the typed
 * `WriteGate` surface (the surface every server.ts call site uses)
 * works against Scheduler + WriterTaskRunner + the real writer worker.
 *
 * If this test passes, switching production wiring from
 * `WriterWorkerProxy` to `Scheduler + writeGateFromScheduler` is a
 * mechanical change in `index.ts`. The behavior is the same; only the
 * routing changes.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DeviceId, SourceId } from "@omnesis/types";
import { createDatabase } from "../db.js";
import { digestCandidate, type AnswerStoreError } from "../privacy/store.js";
import { listPrivacyExchangePresentations } from "../privacy/presentation.js";
import { runWithPriority } from "../priority.js";
import { withRequestTiming, getRequestTiming } from "../request-timing.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { TaskExecutionError } from "./types.js";
import { writeGateFromScheduler, WriteOps } from "./write-ops.js";
import { writerHandlers, writerYieldableHandlers } from "./writer-handlers.js";
import type { SourceModeTransitionPrepareError } from "../data/repositories/SourceModeTransitionRepository.js";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";

const WORKER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("writeGateFromScheduler", () => {
  let dbPath: string;
  let scheduler: Scheduler;

  beforeEach(async () => {
    dbPath = testDbPath();
    const db = createDatabase(dbPath);
    db.close();
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(
      new WriterTaskRunner({
        gatewayDbPath: dbPath,
        journalMode: "WAL",
        heartbeatIntervalMs: 1_000,
        heartbeatWarnGapMs: 10_000,
        workerUrl: WORKER_URL,
        workerExecArgv: ["--import", LOADER_URL],
      }),
    );
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
    cleanupDb(dbPath);
  });

  test("policy rename and deletion run through the registered writer operations", async () => {
    const gate = writeGateFromScheduler(scheduler);
    const familyId = randomUUID();
    await gate.commitPrivacyPolicy({
      familyId,
      familyName: "Scheduler policy",
      policy: "# Fictional policy\n",
      digest: "a".repeat(64),
      revision: "b".repeat(64),
      expectedRevision: null,
      action: "template",
      revertedFromGeneration: null,
      createdAt: 1,
    });
    expect(await gate.renamePrivacyPolicyFamily(familyId, " Renamed scheduler policy ", 2)).toEqual(
      { outcome: "renamed", name: "Renamed scheduler policy" },
    );
    const db = new Database(dbPath);
    try {
      expect(
        db.prepare("SELECT name FROM privacy_policy_families WHERE id = ?").get(familyId),
      ).toEqual({ name: "Renamed scheduler policy" });
      expect(
        db.prepare("SELECT revision FROM privacy_policy_state WHERE family_id = ?").get(familyId),
      ).toEqual({ revision: "b".repeat(64) });
    } finally {
      db.close();
    }
    expect(await gate.deletePrivacyPolicyFamily(familyId, 3)).toEqual({ outcome: "deleted" });
    expect(await gate.renamePrivacyPolicyFamily(familyId, "Archived policy", 4)).toEqual({
      outcome: "not-found",
    });
  });

  test("every WriteOps entry has a matching handler in writerHandlers / writerYieldableHandlers", () => {
    // The TS layer (`WRITE_OP_DEFS[].name: WriterOpName`) catches drift
    // at compile time, but a belt-and-suspenders runtime check matters
    // because (a) yieldable + non-yieldable handlers live in two maps
    // and the writer worker dispatches yieldable first, and (b) a stray
    // `as` cast or any-typed handler could in principle bypass the
    // compile-time fence.
    const handlerNames = new Set([
      ...Object.keys(writerHandlers),
      ...Object.keys(writerYieldableHandlers),
    ]);
    for (const [name, task] of WriteOps) {
      expect(handlerNames, `WriteOps "${name}" missing from handler registry`).toContain(name);
      expect(task.runner).toBe("writer");
    }
  });

  test("every handler in the registry has a WriteOps entry (no orphan handlers)", () => {
    // The reverse coverage check: a handler with no Task entry would
    // silently never get scheduling metadata (priority, latency budget)
    // and would only run if a test injected a synthetic Task.
    const opNames = new Set(WriteOps.keys());
    for (const name of Object.keys(writerHandlers)) {
      expect(opNames, `writerHandlers "${name}" missing from WRITE_OP_DEFS`).toContain(name);
    }
    for (const name of Object.keys(writerYieldableHandlers)) {
      expect(opNames, `writerYieldableHandlers "${name}" missing from WRITE_OP_DEFS`).toContain(
        name,
      );
    }
  });

  test("the people passes that loop over clusters are dispatched yieldably", () => {
    // Both walk a set of alias clusters one bounded merge at a time, and both
    // are driven from a periodic on a graph whose refused clusters never leave
    // the set. Registered non-yieldably, either holds the writer — the
    // gateway's single serialization point for every write — for the whole set
    // with no seam for a sync page or a phone note waiting behind it.
    for (const name of ["people.physicalDedupSharedAliases", "people.upsertAutoDetectedRules"]) {
      expect(Object.keys(writerYieldableHandlers), `${name} lost its preempt seam`).toContain(name);
      expect(Object.keys(writerHandlers), `${name} is registered twice`).not.toContain(name);
    }
  });

  test("a pairing minted through the gate keeps every option, the access level included", async () => {
    const gate = writeGateFromScheduler(scheduler);
    const levelId = "00000000-0000-4000-8000-00000000a1e1";
    const pending = await gate.createPairing({
      name: "Desk integration",
      kind: "integration",
      scopes: ["answer"],
      accessLevelId: levelId,
      tlsFingerprintSha256: "ab".repeat(32),
    });
    expect(pending).toMatchObject({
      name: "Desk integration",
      kind: "integration",
      accessLevelId: levelId,
      tlsFingerprint: "ab".repeat(32),
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        db
          .prepare("SELECT access_level_id FROM device_pairings WHERE pairing_code = ?")
          .get(pending.pairingCode),
      ).toEqual({ access_level_id: levelId });
    } finally {
      db.close();
    }
  });

  test("upsertDocuments through the gate hits the worker and resolves", async () => {
    const gate = writeGateFromScheduler(scheduler);
    // Empty docs array — exercises dispatch path, not the SQL hot path.
    // Worker handler returns void; protocol wraps as `null` on the wire,
    // The fenced legacy path reports rejected source ids; an empty list proves
    // dispatch reached the writer and accepted the no-op batch.
    await expect(gate.upsertDocuments([])).resolves.toEqual({
      rejectedSourceIds: [],
      ignoredReplicaDocuments: [],
      suppressedDocuments: [],
    });
  });

  test("persists run-id-fenced device doctor transitions through the writer", async () => {
    const gate = writeGateFromScheduler(scheduler);
    const device = await gate.createDevice({ name: "Fictional doctor target", kind: "collector" });

    await expect(
      gate.beginDeviceDoctorRun({
        deviceId: device.id,
        runId: "doctor-run-current",
        requestedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      gate.startDeviceDoctorRun({
        deviceId: device.id,
        runId: "doctor-run-current",
        startedAt: "2026-01-01T00:00:01.000Z",
        deadlineAt: "2026-01-01T00:01:31.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      gate.completeDeviceDoctorRun({
        deviceId: device.id,
        runId: "doctor-run-stale",
        completedAt: "2026-01-01T00:00:02.000Z",
        reportJson: '{"status":"stale"}',
      }),
    ).resolves.toBe(false);
    await expect(
      gate.completeDeviceDoctorRun({
        deviceId: device.id,
        runId: "doctor-run-current",
        completedAt: "2026-01-01T00:00:03.000Z",
        reportJson: '{"status":"healthy"}',
      }),
    ).resolves.toBe(true);

    const reader = new Database(dbPath, { readonly: true });
    try {
      expect(
        reader
          .prepare("SELECT run_id, state, report_json FROM device_doctor_runs WHERE device_id = ?")
          .get(device.id),
      ).toEqual({
        run_id: "doctor-run-current",
        state: "complete",
        report_json: '{"status":"healthy"}',
      });
    } finally {
      reader.close();
    }
  });

  test("records MCP invocation metadata through the real writer operation", async () => {
    const gate = writeGateFromScheduler(scheduler);
    await gate.recordMcpToolInvocationAudit({
      principalId: "11111111-1111-4111-8111-111111111111",
      grantId: "22222222-2222-4222-8222-222222222222",
      grantRevision: 2,
      credentialId: "33333333-3333-4333-8333-333333333333",
      oauthClientId: "omn_oc_writer_test",
      capability: "answer",
      tool: "answer",
      outcome: "ok",
      requestId: "44444444-4444-4444-8444-444444444444",
      sourceMode: "all",
    });

    const reader = new Database(dbPath, { readonly: true });
    try {
      const row = reader
        .prepare(
          `SELECT event_type, principal_id, grant_id, grant_revision,
                  credential_id, oauth_client_id, detail
             FROM access_audit_events`,
        )
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({
        event_type: "mcp-tool-invoked",
        principal_id: "11111111-1111-4111-8111-111111111111",
        grant_id: "22222222-2222-4222-8222-222222222222",
        grant_revision: 2,
        credential_id: "33333333-3333-4333-8333-333333333333",
        oauth_client_id: "omn_oc_writer_test",
      });
      expect(JSON.parse(row.detail as string)).toEqual({
        capability: "answer",
        tool: "answer",
        outcome: "ok",
        requestId: "44444444-4444-4444-8444-444444444444",
        sourceMode: "all",
      });
    } finally {
      reader.close();
    }
  });

  test("hard retracts enqueue dependent rechecks through the real writer worker", async () => {
    const gate = writeGateFromScheduler(scheduler);
    const now = 1_786_786_800_000;
    await gate.upsertDocuments(
      ["doc_subject", "doc_evidence"].map((externalId) => ({
        providerId: "fictional",
        sourceId: "fictional:local",
        externalId,
        title: externalId,
        content: "Fictional rehearsal note",
        contentHash: `hash-${externalId}`,
        metadata: {},
        sourceCreatedAt: "2026-01-01T00:00:00Z",
        sourceUpdatedAt: "2026-01-01T00:00:00Z",
      })),
    );
    const lookupDb = new Database(dbPath, { readonly: true });
    const ids = new Map(
      lookupDb
        .prepare<[], { id: string; external_id: string }>(
          "SELECT id, external_id FROM documents WHERE source_id = 'fictional:local'",
        )
        .all()
        .map((row) => [row.external_id, row.id]),
    );
    lookupDb.close();
    await gate.createDocAnnotation(
      {
        id: "anno_worker",
        docId: ids.get("doc_subject")!,
        claimType: "schedule",
        claimText: "the rehearsal is on Tuesday",
        evidenceDocId: ids.get("doc_evidence")!,
        evidenceQuote: "rehearsal is Tuesday",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      now,
    );
    await gate.createPersonAnnotation(
      {
        id: "panno_worker",
        personId: "person_fictional",
        claimType: "role",
        claimText: "coordinates the rehearsal",
        evidenceDocId: "doc_evidence",
        evidenceQuote: "coordinates the rehearsal",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      now,
    );
    await gate.createBrief(
      {
        id: "brief_doc_worker",
        createdByRun: "run_brief_doc",
        kind: "info",
        title: "Rehearsal schedule",
        confidence: 0.8,
        urgency: 0.4,
      },
      {
        priors: [{ priorStore: "doc", priorAnnotationId: "anno_worker" }],
        runId: "run_brief_doc",
      },
      now,
    );
    await gate.createBrief(
      {
        id: "brief_person_worker",
        createdByRun: "run_brief_person",
        kind: "info",
        title: "Rehearsal coordinator",
        confidence: 0.8,
        urgency: 0.4,
      },
      {
        priors: [{ priorStore: "person", priorAnnotationId: "panno_worker" }],
        runId: "run_brief_person",
      },
      now,
    );

    await expect(gate.deleteDocAnnotation("anno_worker", now + 1)).resolves.toBe(true);
    await expect(gate.retractPersonAnnotation("panno_worker", now + 2)).resolves.toBe(true);

    const readDb = new Database(dbPath, { readonly: true });
    try {
      expect(readDb.prepare("SELECT id FROM doc_annotations WHERE id = 'anno_worker'").get()).toBe(
        undefined,
      );
      expect(
        readDb.prepare("SELECT id FROM person_annotations WHERE id = 'panno_worker'").get(),
      ).toBe(undefined);
      expect(
        readDb
          .prepare<[], { dedupe_key: string }>(
            `SELECT dedupe_key FROM cognition_runs
              WHERE dedupe_key LIKE 'feedback:provenance:%'
              ORDER BY dedupe_key`,
          )
          .all()
          .map((row) => row.dedupe_key),
      ).toEqual([
        "feedback:provenance:brief:brief_doc_worker",
        "feedback:provenance:brief:brief_person_worker",
      ]);
    } finally {
      readDb.close();
    }
  });

  test("rehydrates idempotency conflicts raised by privacy writer operations", async () => {
    const gate = writeGateFromScheduler(scheduler);
    const input = {
      ownerId: "token:external",
      clientRequestId: "request-conflict",
      question: "Summarize the fictional project status.",
      ids: {
        workflowId: "workflow-conflict",
        conversationId: "conversation-conflict",
        taskId: "task-conflict",
      },
      now: 100,
      workflowExpiresAt: 10_000,
    };
    await gate.beginAnswerTask(input);

    await expect(
      gate.beginAnswerTask({ ...input, question: "Use the same key for a different question." }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AnswerStoreError>>({
        name: "AnswerStoreError",
        code: "idempotency_conflict",
      }),
    );
  });

  test("carries the failure summary to the writer instead of dropping it in transit", async () => {
    const gate = writeGateFromScheduler(scheduler);
    await gate.beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "request-failed",
      question: "Summarize the fictional project status.",
      ids: {
        workflowId: "workflow-failed",
        conversationId: "conversation-failed",
        taskId: "task-failed",
      },
      now: 100,
      workflowExpiresAt: 10_000,
    });

    await gate.failAnswerTask("task-failed", "token:external", 200, {
      code: "http_api_error",
      message: "The model provider does not have the assigned model.",
      detail: "HTTP 404 · NOT_FOUND · param=model",
    });

    // The queued gate marshals arguments by position; an argument omitted here
    // is invisible at the call site and silently degrades every failure to the
    // store's default reason.
    const db = new Database(dbPath, { readonly: true });
    try {
      const exchange = listPrivacyExchangePresentations(db, "conversation-failed")?.exchanges.at(0);
      expect(exchange?.failure).toMatchObject({
        code: "http_api_error",
        message: "The model provider does not have the assigned model.",
        detail: "HTTP 404 · NOT_FOUND · param=model",
      });
    } finally {
      db.close();
    }
  });

  test("rehydrates a busy conversation conflict while approval is pending", async () => {
    const gate = writeGateFromScheduler(scheduler);
    const first = await gate.beginAnswerTask({
      ownerId: "token:external",
      clientRequestId: "request-pending",
      question: "Share the fictional project status.",
      ids: {
        workflowId: "workflow-pending",
        conversationId: "conversation-pending",
        taskId: "task-pending",
      },
      now: 100,
      workflowExpiresAt: 10_000,
    });
    const review: PrivacyReviewRecord = {
      recipeVersion: "privacy-reviewer-v1",
      provider: "test",
      model: "reviewer",
      confidence: 0.7,
      policyRevision: "policy-a",
      findings: [],
      rationale: "Synthetic review requires approval.",
    };
    const candidate = "The fictional project is on schedule.";
    await gate.completeAnswerTask({
      taskId: first.taskId,
      ownerId: "token:external",
      review,
      now: 200,
      outcome: {
        kind: "approval",
        approvalId: "approval-pending",
        candidateAnswer: candidate,
        candidateDigest: digestCandidate(candidate),
        expiresAt: 5_000,
      },
    });

    await expect(
      gate.beginAnswerTask({
        ownerId: "token:external",
        conversationId: first.conversationId,
        clientRequestId: "request-follow-up",
        question: "Add another detail.",
        ids: {
          workflowId: "unused-workflow",
          conversationId: "unused-conversation",
          taskId: "unused-task",
        },
        now: 300,
        workflowExpiresAt: 10_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AnswerStoreError>>({
        name: "AnswerStoreError",
        code: "conversation_busy",
      }),
    );
  });

  test("leaves unrelated writer failures wrapped by the scheduler", async () => {
    const cause = Object.assign(new Error("Synthetic unrelated write failure."), {
      name: "AnswerStoreError",
      code: "idempotency_conflict",
    });
    vi.spyOn(scheduler, "enqueue").mockRejectedValueOnce(
      new TaskExecutionError("db.upsertDocuments", cause),
    );
    const gate = writeGateFromScheduler(scheduler);

    await expect(gate.upsertDocuments([])).rejects.toBeInstanceOf(TaskExecutionError);
  });

  test("rehydrates a source mode prepare refusal across the writer boundary", async () => {
    const cause = Object.assign(new Error("Synthetic membership changed."), {
      name: "SourceModeTransitionPrepareError",
      code: "source-mode-transition-prepare:membership-conflict",
    });
    vi.spyOn(scheduler, "enqueue").mockRejectedValueOnce(
      new TaskExecutionError("sources.prepareModeTransition", cause),
    );
    const gate = writeGateFromScheduler(scheduler);

    await expect(
      gate.prepareSourceModeTransition(
        SourceId("notes-synth:fictional"),
        "partitioned",
        DeviceId("00000000-0000-4000-8000-000000000001"),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SourceModeTransitionPrepareError>>({
        name: "SourceModeTransitionPrepareError",
        reason: "membership-conflict",
      }),
    );
  });

  test("rehydrates an owner revocation across the writer boundary", async () => {
    const cause = Object.assign(new Error("Synthetic owner was revoked."), {
      name: "SourceModeTransitionPrepareError",
      code: "source-mode-transition-prepare:owner-revoked",
    });
    vi.spyOn(scheduler, "enqueue").mockRejectedValueOnce(
      new TaskExecutionError("sources.prepareModeTransition", cause),
    );
    const gate = writeGateFromScheduler(scheduler);

    await expect(
      gate.prepareSourceModeTransition(
        SourceId("notes-synth:fictional"),
        "partitioned",
        DeviceId("00000000-0000-4000-8000-000000000001"),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SourceModeTransitionPrepareError>>({
        name: "SourceModeTransitionPrepareError",
        reason: "owner-revoked",
      }),
    );
  });

  test("leaves unrecognized privacy error codes wrapped by the scheduler", async () => {
    const cause = Object.assign(new Error("Synthetic unrecognized privacy failure."), {
      name: "AnswerStoreError",
      code: "not_a_store_error_code",
    });
    vi.spyOn(scheduler, "enqueue").mockRejectedValueOnce(
      new TaskExecutionError("privacy.answerBegin", cause),
    );
    const gate = writeGateFromScheduler(scheduler);

    await expect(
      gate.beginAnswerTask({
        ownerId: "token:external",
        clientRequestId: "request-unrecognized",
        question: "Synthetic question.",
        ids: {
          workflowId: "unused-workflow",
          conversationId: "unused-conversation",
          taskId: "unused-task",
        },
        now: 100,
        workflowExpiresAt: 10_000,
      }),
    ).rejects.toBeInstanceOf(TaskExecutionError);
  });

  test("unknown op via the gate factory rejects clearly", async () => {
    // Build a minimal `call` that the factory would have produced
    // for an op missing from the registry. Hits the same lookup path
    // that user-typed code can't reach (the typed gate methods all
    // map to known ops); exists so a future drift is caught.
    const fakeCall = <T>(op: string): Promise<T> => {
      const task = WriteOps.get(op);
      if (!task) return Promise.reject(new Error(`unknown write op: ${op}`));
      return scheduler.enqueue(task, []) as Promise<T>;
    };
    await expect(fakeCall("not.a.real.op")).rejects.toThrow("unknown write op");
  });

  test("accumulates writer queue + exec time into the active RequestTiming", async () => {
    const gate = writeGateFromScheduler(scheduler);
    // Wrap the call in withRequestTiming so the Scheduler's enqueue
    // captures the active timing reference and the runner records the
    // op's queue/exec ms back into it.
    const captured = await withRequestTiming(async () => {
      await gate.upsertDocuments([]);
      await gate.upsertDocuments([]);
      return getRequestTiming();
    });
    expect(captured).not.toBeNull();
    expect(captured!.writerCalls).toBe(2);
    expect(captured!.writerQueueMs).toBeGreaterThanOrEqual(0);
    expect(captured!.writerExecMs).toBeGreaterThanOrEqual(0);
  });

  test("concurrent cognition.notesAppend ops both survive (atomic read-modify-write)", async () => {
    const gate = writeGateFromScheduler(scheduler);
    // Two appends dispatched at once. The old tool-layer read-modify-write
    // spanned the write gate, so two overlapping runs could each read the
    // same base and clobber the other's line. The atomic append op reads +
    // concatenates + writes inside the single-writer gate, so both land.
    await Promise.all([
      gate.appendCognitionNotes("lesson-alpha", { maxBytes: 8192, now: 1 }),
      gate.appendCognitionNotes("lesson-beta", { maxBytes: 8192, now: 2 }),
    ]);
    const readDb = createDatabase(dbPath);
    try {
      const row = readDb
        .prepare<[], { content: string }>("SELECT content FROM cognition_notes WHERE id = 1")
        .get();
      const lines = (row?.content ?? "").split("\n").sort();
      expect(lines).toEqual(["lesson-alpha", "lesson-beta"]);
    } finally {
      readDb.close();
    }
  });

  test("runWithPriority overrides the task's default priority", async () => {
    const gate = writeGateFromScheduler(scheduler);
    // tokens.touchTokenUsage default priority is "background". Wrap
    // the call in runWithPriority("user") and assert via the snapshot
    // that the "user" SLA bucket caught a sample.
    await runWithPriority("user", async () => {
      // The op will fail (bogus token id), but the call goes through
      // the priority resolution path before hitting the worker. We
      // catch the rejection — the priority override is recorded in
      // metrics regardless.
      await gate.touchTokenUsage("tok_bogus" as never, "dev_bogus" as never).catch(() => undefined);
    });
    const snap = scheduler.snapshot(60);
    // userSla.count tracks user-priority samples — should be ≥1.
    expect(snap.userSla.count).toBeGreaterThanOrEqual(1);
  });
});

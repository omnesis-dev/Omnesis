// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Criteria 2 and 3 end-to-end at the module level, zero tokens: bus
 * event → buffer → drain → one debounced `data` run through the write
 * gate; the diff engine's payload (event-time diff + transient fold
 * snapshot); the double-update fold spanning both edits; and the
 * no-prior-version guarantee after settle — all on a real SQLite db,
 * a real EventBus, and a compressed injectable clock.
 */

import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { EventBus, type DocumentProjection, type DocumentUpsertedEvent } from "../../events.js";
import {
  parseCognitionDataRunPayload,
  dataRunDedupeKey,
  dataRunThreadDedupeKey,
} from "../run-payloads.js";
import { getCognitionRun, getPendingRunByDedupeKey } from "../storage/run-queue.js";
import { cognitionSpendDay } from "../storage/spend.js";
import { DERIVATION_STAGES, type DerivationStage } from "../../domain/DocumentDerivation.js";
import { briefsWakerDrainTask, type BriefsWakerDrainBundle } from "./drain-task.js";
import { createBriefsWakerBuffer, subscribeBriefsWaker } from "./event-handler.js";
import type Database from "better-sqlite3";
import type { Scheduler } from "../../scheduler/scheduler.js";

type Db = Database.Database;

const log = createLogger("test").child("waker-drain");

// periodicJob reads the scheduler only inside observe(), which these
// tests never call — a bare stub keeps the bundle constructible.
const schedulerStub = {} as unknown as Scheduler;

const NOW = Date.parse("2026-07-02T12:00:00Z");

const CFG = {
  recencyWindowMs: 7 * 24 * 60 * 60_000,
  conversationDebounceMs: 60 * 60_000,
  documentUpdateDebounceMs: 30 * 60_000,
  conversationMaxDeferMs: 6 * 60 * 60_000,
  documentMaxDeferMs: 4 * 60 * 60_000,
};

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}

function projection(overrides: Partial<DocumentProjection> = {}): DocumentProjection {
  const base: DocumentProjection = {
    id: "doc-1",
    providerId: "google",
    sourceId: "drive:maya@example.com",
    externalId: "ext-1",
    documentType: "file",
    title: "Marathon entry form",
    contentHash: "hash-a",
    metadata: {},
    sourceCreatedAt: new Date(NOW - 60_000).toISOString(),
    sourceUpdatedAt: new Date(NOW - 60_000).toISOString(),
    people: [],
  };
  return { ...base, ...overrides };
}

function insertEvent(overrides: Partial<DocumentProjection> = {}): DocumentUpsertedEvent {
  return {
    before: null,
    after: projection(overrides),
    afterContent: "v1",
    changedFields: [],
    contentChanged: true,
  };
}

function updateEvent(
  beforeContent: string,
  afterContent: string,
  overrides: Partial<DocumentProjection> = {},
): DocumentUpsertedEvent {
  const after = projection(overrides);
  return {
    before: { ...after, contentHash: `hash-of-${beforeContent}` },
    after: { ...after, contentHash: `hash-of-${afterContent}` },
    afterContent,
    beforeContent,
    changedFields: ["contentHash"],
    contentChanged: true,
  };
}

describe("briefs waker drain", () => {
  let dbPath: string;
  let db: Db;
  let writeGate: WriteGate;
  let bus: EventBus;
  let bundle: BriefsWakerDrainBundle;
  let enqueueCalls: number;
  let now: number;
  let enabled: boolean;
  let barrierMs: number;
  let activeStages: readonly DerivationStage[];

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    const direct = directWriteGate(db);
    enqueueCalls = 0;
    writeGate = {
      ...direct,
      enqueueCognitionRun: async (input, atNow) => {
        enqueueCalls++;
        return direct.enqueueCognitionRun(input, atNow);
      },
    };
    bus = new EventBus();
    now = NOW;
    enabled = true;
    const buffer = createBriefsWakerBuffer({ log });
    subscribeBriefsWaker({ eventBus: bus, buffer, getConfig: () => CFG, clock: () => now });
    barrierMs = 0;
    activeStages = DERIVATION_STAGES;
    bundle = briefsWakerDrainTask(
      {
        db,
        writeGate,
        buffer,
        log,
        isEnabled: () => enabled,
        derivationBarrierMs: () => barrierMs,
        activeDerivationStages: () => activeStages,
        clock: () => now,
      },
      schedulerStub,
    );
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      /* already gone */
    }
  });

  function pendingRows(): Array<{ id: string; kind: string; status: string }> {
    return db
      .prepare<
        [],
        { id: string; kind: string; status: string }
      >("SELECT id, kind, status FROM cognition_runs")
      .all();
  }

  test("an eligible insert enqueues exactly one ASAP data run (criterion 2)", async () => {
    bus.emit("document.upserted", insertEvent());
    // Hot-path safety: the emit itself dispatched no writer work.
    expect(enqueueCalls).toBe(0);
    expect(pendingRows()).toHaveLength(0);

    await bundle.flushNow();
    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("data");
    const run = getCognitionRun(db, rows[0].id)!;
    expect(run.nextAttemptAt).toBe(now); // no debounce on fresh inserts
    expect(run.dedupeKey).toBe(dataRunDedupeKey("doc-1"));
    const payload = parseCognitionDataRunPayload(run.payload)!;
    expect(payload).toMatchObject({ docId: "doc-1", event: "created", datumAt: NOW - 60_000 });
    expect(payload.diff).toBeUndefined();
  });

  test("an ineligible event enqueues nothing", async () => {
    bus.emit("document.upserted", insertEvent({ documentType: "webpage" }));
    bus.emit("document.upserted", insertEvent({ id: "doc-2", metadata: { bulkMail: true } }));
    await bundle.flushNow();
    expect(pendingRows()).toHaveLength(0);
    expect(enqueueCalls).toBe(0);
  });

  test("conversation events debounce by the conversation window", async () => {
    bus.emit("document.upserted", insertEvent({ documentType: "conversation" }));
    await bundle.flushNow();
    const run = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;
    expect(run.nextAttemptAt).toBe(now + CFG.conversationDebounceMs);

    // A follow-up message an hour of activity later pushes the run out
    // (trailing debounce) and still folds into the SAME row.
    now += 10 * 60_000;
    bus.emit("document.upserted", updateEvent("v1", "v2", { documentType: "conversation" }));
    await bundle.flushNow();
    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    const folded = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;
    expect(folded.id).toBe(run.id);
    expect(folded.nextAttemptAt).toBe(now + CFG.conversationDebounceMs);
  });

  test("a forever-active conversation clamps to the max-defer ceiling (debounce-starvation guard)", async () => {
    // Insert anchors the cycle; the debounce alone would push the run out on
    // every message and it would never become claimable while active.
    bus.emit("document.upserted", insertEvent({ documentType: "conversation" }));
    await bundle.flushNow();
    const inserted = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;
    const anchor = inserted.cycleAnchorAt;
    expect(anchor).toBe(NOW);

    // Keep folding faster than the 1h debounce, past the 6h ceiling. Each fold
    // clamps next_attempt_at to anchor + ceiling instead of now + debounce.
    for (const offset of [5 * 60 * 60_000, 5.5 * 60 * 60_000, 6.5 * 60 * 60_000]) {
      now = NOW + offset;
      bus.emit(
        "document.upserted",
        updateEvent(`v${offset}`, `v${offset}x`, {
          documentType: "conversation",
        }),
      );
      await bundle.flushNow();
      const folded = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;
      expect(folded.id).toBe(inserted.id);
      // The anchor is immutable across folds; the ceiling never moves.
      expect(folded.cycleAnchorAt).toBe(anchor);
      // Claimable by anchor + ceiling regardless of continued activity —
      // never the naive now + debounce (which would defer it forever).
      expect(folded.nextAttemptAt).toBe(anchor + CFG.conversationMaxDeferMs);
    }
  });

  test("same-thread email arrivals fold into ONE run keyed on the thread (B6)", async () => {
    const threadMeta = { extra: { threadId: "thr-1" } };
    const threadKey = "gmail:maya@example.com:thr-1";
    // Two DISTINCT email documents (distinct ids) sharing one thread id.
    bus.emit(
      "document.upserted",
      insertEvent({
        id: "email-1",
        documentType: "email",
        sourceId: "gmail:maya@example.com",
        metadata: threadMeta,
      }),
    );
    await bundle.flushNow();
    const first = getPendingRunByDedupeKey(db, dataRunThreadDedupeKey(threadKey))!;
    expect(first).toBeTruthy();
    // Threaded email is conversation-like: it debounces, it does not fire ASAP.
    expect(first.nextAttemptAt).toBe(now + CFG.conversationDebounceMs);

    now += 10 * 60_000;
    bus.emit(
      "document.upserted",
      insertEvent({
        id: "email-2",
        documentType: "email",
        sourceId: "gmail:maya@example.com",
        metadata: threadMeta,
      }),
    );
    await bundle.flushNow();
    // Still one run — the second message folded onto the thread row.
    expect(pendingRows()).toHaveLength(1);
    const folded = getPendingRunByDedupeKey(db, dataRunThreadDedupeKey(threadKey))!;
    expect(folded.id).toBe(first.id);
    expect(folded.nextAttemptAt).toBe(now + CFG.conversationDebounceMs);
    // The batched run points at the LATEST message (the settled thread state).
    expect(parseCognitionDataRunPayload(folded.payload)!.docId).toBe("email-2");
    // No per-document key was ever created for either message.
    expect(getPendingRunByDedupeKey(db, dataRunDedupeKey("email-1"))).toBeNull();
    expect(getPendingRunByDedupeKey(db, dataRunDedupeKey("email-2"))).toBeNull();
  });

  test("a forever-active email thread stays claimable within the conversation ceiling (B6 × ceiling)", async () => {
    const threadMeta = { extra: { threadId: "thr-hot" } };
    const threadKey = "gmail:maya@example.com:thr-hot";
    bus.emit(
      "document.upserted",
      insertEvent({
        id: "email-a",
        documentType: "email",
        sourceId: "gmail:maya@example.com",
        metadata: threadMeta,
      }),
    );
    await bundle.flushNow();
    const inserted = getPendingRunByDedupeKey(db, dataRunThreadDedupeKey(threadKey))!;
    const anchor = inserted.cycleAnchorAt;
    expect(anchor).toBe(NOW);

    // A steady stream of new messages faster than the 1h debounce, past the 6h
    // ceiling — each folds onto the thread row and clamps to anchor + ceiling.
    let n = 0;
    for (const offset of [5 * 60 * 60_000, 5.5 * 60 * 60_000, 6.5 * 60 * 60_000]) {
      now = NOW + offset;
      n += 1;
      bus.emit(
        "document.upserted",
        insertEvent({
          id: `email-${n}`,
          documentType: "email",
          sourceId: "gmail:maya@example.com",
          metadata: threadMeta,
        }),
      );
      await bundle.flushNow();
      const folded = getPendingRunByDedupeKey(db, dataRunThreadDedupeKey(threadKey))!;
      expect(folded.id).toBe(inserted.id);
      expect(folded.cycleAnchorAt).toBe(anchor);
      expect(folded.nextAttemptAt).toBe(anchor + CFG.conversationMaxDeferMs);
    }
  });

  test("a document update carries the event-time diff and the fold snapshot (criterion 3)", async () => {
    bus.emit("document.upserted", updateEvent("alpha\nbeta\ngamma", "alpha\nbeta edited\ngamma"));
    await bundle.flushNow();
    const run = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;
    expect(run.nextAttemptAt).toBe(now + CFG.documentUpdateDebounceMs);
    const payload = parseCognitionDataRunPayload(run.payload)!;
    expect(payload.event).toBe("updated");
    expect(payload.diff).toContain("-beta");
    expect(payload.diff).toContain("+beta edited");
    expect(payload.snapshot).toMatchObject({ content: "alpha\nbeta\ngamma" });
  });

  test("a double-update before claim folds into one run whose diff spans both edits", async () => {
    bus.emit("document.upserted", updateEvent("v0 line\ncommon", "v1 line\ncommon"));
    await bundle.flushNow();
    const first = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;

    now += 5 * 60_000;
    bus.emit("document.upserted", updateEvent("v1 line\ncommon", "v2 line\ncommon\nappended"));
    await bundle.flushNow();

    const rows = pendingRows();
    expect(rows).toHaveLength(1);
    const folded = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;
    expect(folded.id).toBe(first.id);
    const payload = parseCognitionDataRunPayload(folded.payload)!;
    // Diff spans v0 → v2: the first edit's removal and the second
    // edit's addition both appear; the intermediate v1 does not.
    expect(payload.diff).toContain("-v0 line");
    expect(payload.diff).toContain("+v2 line");
    expect(payload.diff).toContain("+appended");
    expect(payload.diff).not.toContain("v1 line");
    // Snapshot still the FIRST enqueue's pre-update content.
    expect(payload.snapshot).toMatchObject({ content: "v0 line\ncommon" });
  });

  test("a created addressed aggregate retains every changed entry id across a later fold", async () => {
    const entry = (id: string) => ({
      id,
      capturedAt: "2026-07-02T11:58:00.000Z",
      updatedAt: "2026-07-02T11:58:00.000Z",
      capturedTimeZoneId: "Europe/London",
    });
    bus.emit(
      "document.upserted",
      insertEvent({
        metadata: { addressedToAgent: true, addressedEntries: [entry("entry-a")] },
      }),
    );
    await bundle.flushNow();

    const update = updateEvent("v1", "v2", {
      metadata: {
        addressedToAgent: true,
        addressedEntries: [entry("entry-a"), entry("entry-b")],
      },
    });
    update.before = {
      ...update.before!,
      metadata: { addressedToAgent: true, addressedEntries: [entry("entry-a")] },
    };
    bus.emit("document.upserted", update);
    await bundle.flushNow();

    const run = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;
    expect(parseCognitionDataRunPayload(run.payload)?.changedAddressedEntryIds).toEqual([
      "entry-a",
      "entry-b",
    ]);
  });

  test("addressed content stamps the no-delay marker on its run payload", async () => {
    // The settle path reads this marker: an in-flight fold on addressed
    // content resurrects due now instead of re-entering the conversation
    // quiet window (see run-drainer). Without it on the payload the run is
    // indistinguishable from an ordinary document once it reaches the queue.
    bus.emit("document.upserted", insertEvent({ metadata: { addressedToAgent: true } }));
    await bundle.flushNow();
    const addressed = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-1"))!;
    expect(parseCognitionDataRunPayload(addressed.payload)?.immediate).toBe(true);

    // An ordinary document makes no such claim.
    bus.emit("document.upserted", insertEvent({ id: "doc-2" }));
    await bundle.flushNow();
    const ordinary = getPendingRunByDedupeKey(db, dataRunDedupeKey("doc-2"))!;
    expect(parseCognitionDataRunPayload(ordinary.payload)?.immediate).toBeUndefined();
  });

  test("no prior version survives a completed run (criterion 3, compressed clock)", async () => {
    bus.emit("document.upserted", updateEvent("secret v0", "v1"));
    await bundle.flushNow();

    now += CFG.documentUpdateDebounceMs + 1;
    const [claimed] = await writeGate.claimDueCognitionRuns({ now, limit: 1 });
    expect(claimed).toBeDefined();
    await writeGate.finalizeCognitionRun({
      runId: claimed.id,
      now,
      day: cognitionSpendDay(now),
      mechanism: "data",
      modelId: null,
      usage: null,
      claimedPayloadJson: claimed.payloadJson,
      outcome: { kind: "completed" },
    });
    const raw = db
      .prepare<
        [string],
        { payload_json: string; status: string }
      >("SELECT payload_json, status FROM cognition_runs WHERE id = ?")
      .get(claimed.id)!;
    expect(raw.status).toBe("completed");
    // The criterion is no PRIOR-VERSION content: the pre-update snapshot
    // and the diff text (both quote "secret v0") must die with the run.
    // The reference-shaped rest of the payload survives the settle.
    expect(raw.payload_json).not.toContain("secret v0");
    expect(raw.payload_json).not.toContain("snapshot");
    expect(raw.payload_json).not.toContain("diff");
    expect(JSON.parse(raw.payload_json)).toMatchObject({ docId: "doc-1", event: "updated" });
  });

  test("no prior version survives a terminal failure", async () => {
    bus.emit("document.upserted", updateEvent("secret v0", "v1"));
    await bundle.flushNow();
    now += CFG.documentUpdateDebounceMs + 1;
    const [claimed] = await writeGate.claimDueCognitionRuns({ now, limit: 1 });
    await writeGate.finalizeCognitionRun({
      runId: claimed.id,
      now,
      day: cognitionSpendDay(now),
      mechanism: "data",
      modelId: null,
      usage: null,
      claimedPayloadJson: claimed.payloadJson,
      outcome: { kind: "failed", errorMessage: "backend down", terminal: true, nextAttemptAt: now },
    });
    const raw = db
      .prepare<
        [string],
        { payload_json: string; status: string }
      >("SELECT payload_json, status FROM cognition_runs WHERE id = ?")
      .get(claimed.id)!;
    expect(raw.status).toBe("failed");
    // Same criterion as the completed case: prior-version content
    // (snapshot + diff) must not survive, even a failed run.
    expect(raw.payload_json).not.toContain("secret v0");
    expect(raw.payload_json).not.toContain("snapshot");
    expect(raw.payload_json).not.toContain("diff");
    expect(JSON.parse(raw.payload_json)).toMatchObject({ docId: "doc-1", event: "updated" });
  });

  test("a fold landing while the run is in flight resurrects the row instead of being swallowed", async () => {
    const entry = (id: string, updatedAt: string) => ({
      id,
      capturedAt: "2026-07-02T11:58:00.000Z",
      updatedAt,
    });
    const first = updateEvent("v0", "v1", {
      metadata: {
        addressedToAgent: true,
        addressedEntries: [entry("entry-a", "2026-07-02T11:59:00.000Z")],
      },
    });
    first.before = {
      ...first.before!,
      metadata: {
        addressedToAgent: true,
        addressedEntries: [entry("entry-a", "2026-07-02T11:58:00.000Z")],
      },
    };
    bus.emit("document.upserted", first);
    await bundle.flushNow();
    now += CFG.documentUpdateDebounceMs + 1;
    const [claimed] = await writeGate.claimDueCognitionRuns({ now, limit: 1 });
    expect(claimed).toBeDefined();

    // While the (single) claimed run executes, another edit arrives and
    // folds into the still-`pending` row.
    const second = updateEvent("v1", "v2", {
      metadata: {
        addressedToAgent: true,
        addressedEntries: [
          entry("entry-a", "2026-07-02T11:59:00.000Z"),
          entry("entry-b", "2026-07-02T12:00:00.000Z"),
        ],
      },
    });
    second.before = {
      ...second.before!,
      metadata: {
        addressedToAgent: true,
        addressedEntries: [entry("entry-a", "2026-07-02T11:59:00.000Z")],
      },
    };
    bus.emit("document.upserted", second);
    await bundle.flushNow();

    // The attempt settles — but the row carries a payload it never saw,
    // so it returns to pending as a logically fresh run.
    await writeGate.finalizeCognitionRun({
      runId: claimed.id,
      now,
      day: cognitionSpendDay(now),
      mechanism: "data",
      modelId: null,
      usage: { promptTokens: 10, completionTokens: 2 },
      claimedPayloadJson: claimed.payloadJson,
      outcome: { kind: "completed" },
    });
    const row = getCognitionRun(db, claimed.id)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    const payload = parseCognitionDataRunPayload(row.payload)!;
    expect(payload.diff).toContain("+v2");
    expect(payload.changedAddressedEntryIds).toEqual(["entry-a", "entry-b"]);
  });

  test("a deleted document's buffered wake is evicted (no run for vanished docs)", async () => {
    bus.emit("document.upserted", insertEvent());
    bus.emit("document.deleted", {
      id: "doc-1",
      providerId: "google",
      sourceId: "drive:maya@example.com",
      externalId: "ext-1",
    });
    await bundle.flushNow();
    expect(pendingRows()).toHaveLength(0);
  });

  test("live deactivation discards buffered wakes instead of enqueueing", async () => {
    bus.emit("document.upserted", insertEvent());
    enabled = false;
    await bundle.flushNow();
    expect(pendingRows()).toHaveLength(0);
    expect(enqueueCalls).toBe(0);
  });

  test("a failed enqueue re-buffers the wake for the next tick", async () => {
    bus.emit("document.upserted", insertEvent());
    const original = writeGate.enqueueCognitionRun;
    let failures = 0;
    writeGate.enqueueCognitionRun = async () => {
      failures++;
      throw new Error("writer stalled");
    };
    await bundle.flushNow();
    expect(failures).toBe(1);
    expect(pendingRows()).toHaveLength(0);

    writeGate.enqueueCognitionRun = original;
    await bundle.flushNow();
    expect(pendingRows()).toHaveLength(1);
  });

  describe("readiness barrier", () => {
    // The barrier holds a data run until its datum's deterministic derivation
    // has finished, so the agent reasons about a document whose edges, people
    // and dates already exist — up to a bounded wait.
    const BARRIER_MS = 30 * 60_000;

    function seedDatum(id: string, opts: { derived?: boolean } = {}): void {
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
         VALUES (?, 'google', 'drive:maya@example.com', ?, ?, '', ?, '{}', ?, ?, ?, ?)`,
      ).run(
        id,
        id,
        `Title ${id}`,
        `h-${id}`,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
      );
      if (opts.derived === true) markDerived(id);
    }

    function markDerived(id: string): void {
      db.prepare(
        "UPDATE documents SET links_extracted_at = ?, people_resolved_at = ?, dates_extracted_at = ? WHERE id = ?",
      ).run(
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
        id,
      );
    }

    function dueAt(): number {
      return db
        .prepare<
          [],
          { next_attempt_at: number }
        >("SELECT next_attempt_at FROM cognition_runs WHERE kind = 'data'")
        .get()!.next_attempt_at;
    }

    test("an underived datum's run is deferred to the barrier, not its debounce", async () => {
      barrierMs = BARRIER_MS;
      seedDatum("doc-1");
      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();
      // A fresh insert would otherwise be claimable immediately.
      expect(dueAt()).toBe(NOW + BARRIER_MS);
    });

    test("an already-derived datum is not delayed at all", async () => {
      barrierMs = BARRIER_MS;
      seedDatum("doc-1", { derived: true });
      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();
      expect(dueAt()).toBe(NOW);
    });

    test("completing derivation releases the run immediately", async () => {
      barrierMs = BARRIER_MS;
      seedDatum("doc-1");
      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();
      expect(dueAt()).toBe(NOW + BARRIER_MS);

      // The derivation drips finish with the document a few seconds later.
      now = NOW + 5_000;
      markDerived("doc-1");
      await bundle.flushNow();
      expect(dueAt()).toBe(now);
    });

    test("release never cuts an unelapsed debounce short", async () => {
      // An update carries a 30m debounce. Derivation finishing after 5s must
      // make the run due at its debounce deadline, not immediately — the
      // barrier is a separate wait, and clearing it does not clear the other.
      barrierMs = 10 * 60_000;
      seedDatum("doc-1");
      bus.emit("document.upserted", updateEvent("v1", "v2"));
      await bundle.flushNow();
      const debounceDeadline = NOW + CFG.documentUpdateDebounceMs;
      expect(dueAt()).toBe(debounceDeadline);

      now = NOW + 5_000;
      markDerived("doc-1");
      await bundle.flushNow();
      expect(dueAt()).toBe(debounceDeadline);
    });

    test("a still-underived run keeps its barrier deadline", async () => {
      barrierMs = BARRIER_MS;
      seedDatum("doc-1");
      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();

      now = NOW + 60_000;
      db.prepare("UPDATE documents SET links_extracted_at = ? WHERE id = ?").run(
        new Date(NOW).toISOString(),
        "doc-1",
      );
      await bundle.flushNow();
      // People and dates are still outstanding — partial derivation is not
      // readiness, so the run stays parked until the barrier expires.
      expect(dueAt()).toBe(NOW + BARRIER_MS);
    });

    test("a deleted datum is never held", async () => {
      // Nothing will ever derive it; the data-run prompt handles the deletion.
      barrierMs = BARRIER_MS;
      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();
      expect(dueAt()).toBe(NOW);
    });

    test("deleting a barrier-held datum releases it without cutting its debounce short", async () => {
      barrierMs = 2 * CFG.documentUpdateDebounceMs;
      seedDatum("doc-1");
      bus.emit("document.upserted", updateEvent("v1", "v2"));
      await bundle.flushNow();
      expect(dueAt()).toBe(NOW + barrierMs);

      db.prepare("DELETE FROM documents WHERE id = ?").run("doc-1");
      now = NOW + 5_000;
      await bundle.flushNow();

      expect(dueAt()).toBe(NOW + CFG.documentUpdateDebounceMs);
    });

    test("a datum recreated between the readiness read and writer CAS stays held", async () => {
      barrierMs = 2 * CFG.documentUpdateDebounceMs;
      seedDatum("doc-1");
      bus.emit("document.upserted", updateEvent("v1", "v2"));
      await bundle.flushNow();
      const barrierDeadline = NOW + barrierMs;
      expect(dueAt()).toBe(barrierDeadline);

      db.prepare("DELETE FROM documents WHERE id = ?").run("doc-1");
      const atomicPull = writeGate.pullForwardCognitionRuns;
      writeGate.pullForwardCognitionRuns = async (entries, stageIds) => {
        seedDatum("doc-1");
        return atomicPull(entries, stageIds);
      };
      now = NOW + 5_000;
      await bundle.flushNow();

      expect(dueAt()).toBe(barrierDeadline);
    });

    test("a same-schedule fold changing the datum invalidates the readiness read", async () => {
      barrierMs = 2 * CFG.documentUpdateDebounceMs;
      seedDatum("doc-1");
      bus.emit("document.upserted", updateEvent("v1", "v2"));
      await bundle.flushNow();
      const barrierDeadline = NOW + barrierMs;

      now = NOW + 5_000;
      markDerived("doc-1");
      const atomicPull = writeGate.pullForwardCognitionRuns;
      writeGate.pullForwardCognitionRuns = async (entries, stageIds) => {
        seedDatum("doc-2");
        db.prepare(
          "UPDATE cognition_runs SET payload_json = json_set(payload_json, '$.docId', 'doc-2') WHERE kind = 'data'",
        ).run();
        return atomicPull(entries, stageIds);
      };
      await bundle.flushNow();

      expect(dueAt()).toBe(barrierDeadline);
    });

    test("retry backoff survives the release pass", async () => {
      // A soft failure reschedules the row and leaves its payload alone, so a
      // stale debounce deadline sits in the past. Releasing on that would burn
      // the whole attempt budget in seconds and delete the backoff that exists
      // to ride out a transient backend outage.
      barrierMs = BARRIER_MS;
      seedDatum("doc-1", { derived: true });
      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();

      const runId = db
        .prepare<[], { id: string }>("SELECT id FROM cognition_runs WHERE kind = 'data'")
        .get()!.id;
      const backoffUntil = NOW + 60_000;
      db.prepare("UPDATE cognition_runs SET next_attempt_at = ?, attempts = 1 WHERE id = ?").run(
        backoffUntil,
        runId,
      );

      now = NOW + 1_000;
      await bundle.flushNow();
      expect(dueAt()).toBe(backoffUntil);
    });

    test("a fold landing after the readiness read keeps its fresh quiet window", async () => {
      // The release is a compare-and-set on the schedule that was observed:
      // anything that reschedules the row in between invalidates it, so a run
      // never fires on a document that started changing again.
      barrierMs = BARRIER_MS;
      seedDatum("doc-1");
      bus.emit("document.upserted", updateEvent("v1", "v2"));
      await bundle.flushNow();

      const runId = db
        .prepare<[], { id: string }>("SELECT id FROM cognition_runs WHERE kind = 'data'")
        .get()!.id;
      const refolded = NOW + 45 * 60_000;
      db.prepare("UPDATE cognition_runs SET next_attempt_at = ? WHERE id = ?").run(refolded, runId);

      now = NOW + 5_000;
      markDerived("doc-1");
      await bundle.flushNow();
      expect(dueAt()).toBe(refolded);
    });

    test("content addressed to the assistant is never held", async () => {
      // That marker's whole contract is bypassing the volume gates; making it
      // wait on background derivation would contradict it.
      barrierMs = BARRIER_MS;
      seedDatum("doc-1");
      bus.emit("document.upserted", insertEvent({ metadata: { addressedToAgent: true } }));
      await bundle.flushNow();
      expect(dueAt()).toBe(NOW);
    });

    test("a stage that is switched off is not waited on", async () => {
      // A stage whose producer never runs never stamps, so counting it would
      // turn the barrier into a flat ceiling-length delay on every document.
      barrierMs = BARRIER_MS;
      activeStages = DERIVATION_STAGES.filter((s) => s.id !== "dates");
      seedDatum("doc-1");
      db.prepare(
        "UPDATE documents SET links_extracted_at = ?, people_resolved_at = ? WHERE id = ?",
      ).run(new Date(NOW).toISOString(), new Date(NOW).toISOString(), "doc-1");

      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();
      expect(dueAt()).toBe(NOW);
    });

    test("a disabled engine's queue is left alone", async () => {
      barrierMs = BARRIER_MS;
      seedDatum("doc-1");
      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();

      now = NOW + 5_000;
      markDerived("doc-1");
      enabled = false;
      await bundle.flushNow();
      expect(dueAt()).toBe(NOW + BARRIER_MS);
    });

    test("a zero barrier leaves scheduling exactly as it was", async () => {
      barrierMs = 0;
      seedDatum("doc-1");
      bus.emit("document.upserted", insertEvent());
      await bundle.flushNow();
      expect(dueAt()).toBe(NOW);
    });
  });
});

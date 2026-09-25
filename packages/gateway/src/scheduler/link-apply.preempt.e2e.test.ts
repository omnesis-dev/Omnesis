// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The writer half of link extraction and reconcile, against a real writer
 * worker under forced preemption.
 *
 * Both link jobs compute on a read handle and hand the writer a plan built
 * from a snapshot of the corpus. Two of the invariants that make that split
 * safe live at the worker boundary rather than inside the SQL, which is why
 * they need a real `WriterTaskRunner` rather than a unit test that drives the
 * domain function in-process with a hand-made token:
 *
 *   - A preempted apply returns a continuation — `appliedLinks` /
 *     `deletedThroughLinkId` / `deletionComplete` for extraction, the
 *     `{batch, phase, offset, …}` state for reconcile — which crosses the
 *     worker's `postMessage` hop as `{kind:"yield", resume}` and is
 *     re-enqueued at the back of the background lane. It must resume where it
 *     stopped. If it restarts, a document with thousands of links never
 *     reaches its last chunk under steady write pressure, and a reconcile
 *     batch silently drops every phase after the one it yielded in.
 *   - The replacement delete is scoped to the link types extraction owns, so
 *     `cited` edges from the agent's citation writer and the source-declared
 *     `replies-to` family survive re-extraction. Every multi-turn agent
 *     conversation is this shape: the conversation document is re-upserted on
 *     each turn while carrying one `cited` row per annotation. Production
 *     reaches that delete through `deleteManagedChunk` — the bounded,
 *     resumable path — not through the whole-document `processDocumentLinks`
 *     helper the existing unit tests drive.
 *
 * The suite boots a Scheduler with preemption enabled and a real
 * `WriterTaskRunner` against a temp DB — no gateway subprocess — because the
 * yield has to be *forced*, not waited for: `Scheduler.enqueue` pushes, then
 * runs `maybePreempt` and `dispatch` synchronously, so enqueuing a
 * user-priority write in the same turn that dispatches the background apply
 * sets the SharedArrayBuffer flag before the worker has deserialized its
 * batch. Through HTTP that ordering is a race. The compute halves run
 * in-process via the same domain functions the io and cpu handlers call
 * (`extractLinksForBatch`, `computeLinkResolutions`), so the batch handed to
 * the writer is the batch production hands it.
 *
 * Every assertion is on committed state or on scheduler sample counts. None
 * is on wall-clock time, and the pressure loop is bounded, so a lost
 * continuation fails an assertion instead of hanging — this file shares the
 * box with other E2E suites.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, invalidateUrlIdPatternCache } from "../db.js";
import { runWithPriority } from "../priority.js";
import { LINK_APPLY_CHUNK_SIZE, extractLinksForBatch } from "../domain/LinkExtraction.js";
import {
  LINK_RECONCILE_APPLY_CHUNK_SIZE,
  computeLinkResolutions,
} from "../domain/LinkGraphService.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { writeGateFromScheduler } from "./write-ops.js";
import type { WriteGate } from "../write-gate.js";
import type { SchedulerMetricsSnapshot } from "./metrics.js";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

const WORKER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/** Invented, corpus-free fixture source. Both halves of a `SourceId` are the same string. */
const NOTES_SOURCE = "notes-synth:local";
const THREADS_SOURCE = "notes-synth:threads";

const SEED_TIME = "2026-01-05T09:00:00.000Z";
const CURSOR: SyncCursor = { type: "incremental", lastSyncTime: SEED_TIME } as SyncCursor;

/**
 * Fixture prose. No `scheme://` run (which `extractLinks` step 1 turns into a
 * `url` link) and no digits at all (step 6 turns a structurally-valid NANP
 * digit run into a `shares-phone` link). Both types are extraction-managed, so
 * one stray match would move every "exactly N links" count in this file.
 */
const PLAIN_CONTENT_V1 = "Retrospective notes, with follow-ups still to sort and nothing to link.";
const PLAIN_CONTENT_V2 = "Revised retrospective notes, with a fresh set of follow-ups to sort.";

interface SeedDocument {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  sourceUrl: string | null;
  /** Stamped documents are invisible to `extractLinksForBatch`'s fetch window. */
  extracted: boolean;
}

interface RawLink {
  sourceDocId: string;
  normalizedTarget: string;
}

function testDbPath(): string {
  return `/tmp/omnesis-link-apply-${randomUUID()}.db`;
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function seedDoc(
  sourceId: string,
  externalId: string,
  opts: Partial<Omit<SeedDocument, "sourceId" | "externalId">> = {},
): SeedDocument {
  return {
    id: opts.id ?? randomUUID(),
    sourceId,
    externalId,
    title: opts.title ?? externalId,
    content: opts.content ?? PLAIN_CONTENT_V1,
    contentHash: opts.contentHash ?? `hash-${externalId}`,
    metadata: opts.metadata ?? { documentType: "note" },
    sourceUrl: opts.sourceUrl ?? null,
    extracted: opts.extracted ?? true,
  };
}

/**
 * Write the corpus with a plain handle and close it BEFORE the scheduler
 * starts, so the writer worker is the only thing that ever holds the write
 * connection while a test is running.
 */
function seedCorpus(
  dbPath: string,
  docs: readonly SeedDocument[],
  links: readonly RawLink[],
): void {
  const db = createDatabase(dbPath);
  try {
    const insertDoc = db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
          content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at,
          source_url, links_extracted_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLink = db.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target,
          target_doc_id, resolved_at, created_at, provenance_kind, provenance_origin, declared_at)
       VALUES (?, 'url', ?, ?, NULL, NULL, ?, 'content-derived', ?, ?)`,
    );
    db.transaction(() => {
      for (const doc of docs) {
        insertDoc.run(
          doc.id,
          doc.sourceId,
          doc.sourceId,
          doc.externalId,
          doc.title,
          doc.content,
          doc.contentHash,
          JSON.stringify(doc.metadata),
          SEED_TIME,
          SEED_TIME,
          SEED_TIME,
          SEED_TIME,
          doc.sourceUrl,
          doc.extracted ? SEED_TIME : null,
        );
      }
      for (const link of links) {
        insertLink.run(
          link.sourceDocId,
          link.normalizedTarget,
          link.normalizedTarget,
          SEED_TIME,
          link.sourceDocId,
          SEED_TIME,
        );
      }
    })();
  } finally {
    db.close();
  }
}

/** `document_links` is `INTEGER PRIMARY KEY AUTOINCREMENT`; absent until the first insert. */
function rowidsEverAllocated(read: Database.Database): number {
  const row = read
    .prepare<[string], { seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = ?")
    .get("document_links");
  return row?.seq ?? 0;
}

function taskStats(snapshot: SchedulerMetricsSnapshot, name: string) {
  const stats = snapshot.perTask.find((t) => t.name === name);
  expect(stats, `no samples recorded for ${name}`).toBeDefined();
  return stats!;
}

/**
 * Anti-drift guard: nothing but the ops this test issues may touch the writer.
 * A periodic or wakeable registered by a future change would otherwise shift
 * the attempt counts these tests bound, silently, instead of reddening here.
 */
function expectOnlyTasks(snapshot: SchedulerMetricsSnapshot, allowed: readonly string[]): void {
  const unexpected = snapshot.perTask.map((t) => t.name).filter((n) => !allowed.includes(n));
  expect(unexpected).toEqual([]);
}

describe("link apply under forced preemption", () => {
  let dbPath: string;
  let scheduler: Scheduler;
  let gate: WriteGate;
  let read: Database.Database;
  let pressureSeq = 0;

  beforeEach(() => {
    dbPath = testDbPath();
    pressureSeq = 0;
  });

  afterEach(async () => {
    read?.close();
    await scheduler?.dispose();
    invalidateUrlIdPatternCache();
    cleanupDb(dbPath);
  });

  /**
   * Start the writer AFTER the corpus is seeded. The read handle is opened
   * only once `start()` has resolved: it awaits the worker's `ready`, and the
   * `-shm` that a read-only open of a WAL database needs exists only once the
   * worker has the file open.
   */
  async function startScheduler(): Promise<void> {
    scheduler = new Scheduler({ enablePreemption: true });
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
    gate = writeGateFromScheduler(scheduler);
    read = new Database(dbPath, { readonly: true });
  }

  /** Links stored for a document right now, on the read handle. */
  function storedLinks(docId: string): number {
    return read
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM document_links WHERE source_doc_id = ?")
      .get(docId)!.n;
  }

  /** The extraction stamp — NULL until a document's last chunk commits. */
  function extractedAt(docId: string): string | null {
    return (
      read
        .prepare<
          [string],
          { links_extracted_at: string | null }
        >("SELECT links_extracted_at FROM documents WHERE id = ?")
        .get(docId)?.links_extracted_at ?? null
    );
  }

  /** One user-priority writer op — the thing that outranks a background apply. */
  async function pressureOp(): Promise<boolean> {
    const sourceId = `pressure-${pressureSeq++}`;
    return runWithPriority("user", () => gate.setSyncState(sourceId, CURSOR, undefined));
  }

  /**
   * Dispatch a background writer op and preempt it in the same synchronous
   * turn. `enqueue` runs `dispatch` synchronously, so by the time the second
   * statement enqueues the user op the background task is already in
   * `state.inflight` and `maybePreempt` fires `requestYield()` — before the
   * worker has read its first chunk. Nothing here awaits between the two.
   */
  function forceYield<T>(start: () => Promise<T>): {
    applyPromise: Promise<T>;
    firstPressure: Promise<boolean>;
  } {
    const applyPromise = start();
    const firstPressure = pressureOp();
    return { applyPromise, firstPressure };
  }

  /**
   * Keep a user-priority op arriving while the apply's continuations run, so
   * each one is preempted again. Bounded: once the loop stops, no further
   * preempt is requested, `dispatch`'s `preempt.reset()` leaves the flag
   * clear, and the last continuation runs to completion — which is what makes
   * the caller's `await applyPromise` non-hanging. A lost continuation
   * therefore fails an assertion rather than running out the test timeout.
   *
   * Settle detection is a flag set by ONE handler attached before the loop.
   * A `Promise.race` would leave the loser attached, and `dispose()` rejects
   * everything still queued, which would surface as an unhandled rejection in
   * a later test.
   */
  async function keepPressure(
    applyPromise: Promise<unknown>,
    maxIterations: number,
    onTick?: () => void,
  ): Promise<void> {
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void applyPromise.then(markSettled, markSettled);
    for (let i = 0; i < maxIterations && !settled; i++) {
      // The scheduler dispatches the next continuation from a `.finally()`
      // microtask on the completing task. Hopping to a macrotask puts this
      // enqueue after that dispatch, so the continuation is in flight and
      // there is something for `maybePreempt` to preempt.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (settled) break;
      onTick?.();
      await pressureOp();
    }
  }

  test("a link-heavy document preempted mid-apply carries its resume fields through the worker round trip", async () => {
    const targets = Array.from({ length: 600 }, (_, i) =>
      seedDoc(NOTES_SOURCE, `ref-${String(i).padStart(3, "0")}`),
    );
    const subject = seedDoc(NOTES_SOURCE, "link-heavy-note", {
      extracted: false,
      metadata: {
        documentType: "note",
        extra: { links: targets.map((t) => t.externalId) },
      },
    });
    seedCorpus(dbPath, [...targets, subject], []);
    await startScheduler();

    // No link has ever been written, so every rowid this test observes was
    // allocated by the apply under test.
    expect(rowidsEverAllocated(read)).toBe(0);

    const batch = extractLinksForBatch(read, 5, [], [], true, [], true);
    expect(batch).toHaveLength(1);
    expect(batch[0].docId).toBe(subject.id);
    expect(batch[0].links).toHaveLength(600);
    expect(new Set(batch[0].links.map((l) => l.type))).toEqual(new Set(["references"]));
    // Every link resolved on the read handle, so each chunk does 50 inserts
    // plus 50 EXISTS-guarded target updates — the shape production applies.
    expect(Object.keys(batch[0].resolvedTargets ?? {})).toHaveLength(600);

    const { applyPromise, firstPressure } = forceYield(() => gate.upsertExtractedLinksBatch(batch));
    // The user op could only run because the apply yielded, so this reads
    // the document mid-apply: some chunks committed, `links_extracted_at`
    // still NULL. That stamp is the only thing that re-queues a document,
    // so stamping it before the last chunk would freeze a half-written
    // link set in place until the document changed again.
    await firstPressure;
    const midFlight = storedLinks(subject.id);
    expect(midFlight).toBeGreaterThan(0);
    expect(midFlight).toBeLessThan(600);
    expect(extractedAt(subject.id)).toBeNull();

    await keepPressure(applyPromise, 40);
    const result = await applyPromise;

    // The runner drops a yielding call's result object, so these counters
    // describe the final, non-yielding attempt: it closed the document.
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);

    const rows = read
      .prepare<
        [string],
        { link_type: string; target_doc_id: string | null }
      >("SELECT link_type, target_doc_id FROM document_links WHERE source_doc_id = ?")
      .all(subject.id);
    expect(rows).toHaveLength(600);
    expect(new Set(rows.map((r) => r.link_type))).toEqual(new Set(["references"]));
    expect(rows.filter((r) => r.target_doc_id !== null)).toHaveLength(600);
    expect(extractedAt(subject.id)).not.toBeNull();

    // The discriminator between resume and restart. Each row's id is
    // allocated exactly once when the continuation resumes at its offset;
    // a continuation that lost `appliedLinks` re-enters the delete branch,
    // removes the chunks it just wrote and re-inserts them, consuming fresh
    // rowids every attempt. `ON CONFLICT … DO UPDATE` bumps the sequence
    // even when it inserts nothing, so a re-applied chunk shows up here too.
    expect(rowidsEverAllocated(read)).toBe(600);

    const snapshot = scheduler.snapshot(120);
    const stats = taskStats(snapshot, "links.upsertExtractedLinksBatch");
    expect(stats.yieldCount).toBeGreaterThanOrEqual(1);
    // Every yield follows a committed chunk, and the final chunk cannot
    // yield, so a resuming apply costs at most one attempt per chunk.
    expect(stats.count).toBeLessThanOrEqual(Math.ceil(600 / LINK_APPLY_CHUNK_SIZE) + 2);
    // A run where preemption was inert would otherwise read as a green resume.
    expect(snapshot.preemptRequestCount).toBeGreaterThanOrEqual(1);
    expectOnlyTasks(snapshot, ["links.upsertExtractedLinksBatch", "db.setSyncState"]);
  }, 120_000);

  test("re-extraction deletes only the edge types it owns; agent citations and source-declared edges survive it", async () => {
    const oldTargets = Array.from({ length: 120 }, (_, i) =>
      seedDoc(THREADS_SOURCE, `msg-old-${String(i).padStart(3, "0")}`),
    );
    const newTargets = Array.from({ length: 120 }, (_, i) =>
      seedDoc(THREADS_SOURCE, `msg-new-${String(i).padStart(3, "0")}`),
    );
    // `applyDeclaredEdges` resolves an `internal` ref against the DECLARING
    // source, so the reply target has to live in the conversation's own
    // source — otherwise the edge parks in `pending_edges`, no `replies-to`
    // row is ever written, and the preservation assertion would compare an
    // empty set to an empty set.
    const replyTarget = seedDoc(THREADS_SOURCE, "msg-reply-target");
    const citedA = seedDoc(THREADS_SOURCE, "msg-cited-a");
    const citedB = seedDoc(THREADS_SOURCE, "msg-cited-b");
    const conversation = seedDoc(THREADS_SOURCE, "conv-1", {
      extracted: false,
      content: PLAIN_CONTENT_V1,
      contentHash: "conv-hash-v1",
      metadata: {
        documentType: "conversation",
        extra: { links: oldTargets.map((t) => t.externalId) },
      },
    });
    seedCorpus(
      dbPath,
      [...oldTargets, ...newTargets, replyTarget, citedA, citedB, conversation],
      [],
    );
    await startScheduler();

    // Foreign rows are written with their real production writers and
    // sequenced so they sit on BOTH sides of the extraction-managed id
    // range: citations take the lowest ids, the v1 extraction the middle,
    // the source-declared edge the highest.
    const citations = await gate.upsertConversationCitations(conversation.id, [
      { targetDocId: citedA.id, quote: "the retro action items", note: "why this matters" },
      { targetDocId: citedB.id, note: "second annotation" },
    ]);
    expect(citations.inserted).toBe(2);

    const batchV1 = extractLinksForBatch(read, 5, [], [], true, [], true);
    expect(batchV1).toHaveLength(1);
    expect(batchV1[0].docId).toBe(conversation.id);
    expect(batchV1[0].links).toHaveLength(120);
    expect(await gate.upsertExtractedLinksBatch(batchV1)).toMatchObject({
      applied: 1,
      skipped: 0,
    });

    await gate.upsertWithCursor({
      providerId: THREADS_SOURCE,
      sourceId: THREADS_SOURCE,
      documents: [],
      edges: [
        {
          from: { kind: "internal", sourceDocumentId: conversation.externalId },
          to: { kind: "internal", sourceDocumentId: replyTarget.externalId },
          type: "replies-to",
        },
      ],
      hasMore: false,
      cursor: CURSOR,
    });

    const foreignRows = () =>
      read
        .prepare<
          [string],
          Record<string, unknown>
        >(`SELECT id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, metadata_json, provenance_kind, provenance_origin, declared_at FROM document_links WHERE source_doc_id = ? AND link_type IN ('cited', 'replies-to') ORDER BY id`)
        .all(conversation.id);
    const managedRows = () =>
      read
        .prepare<
          [string],
          { id: number; link_type: string; normalized_target: string; target_doc_id: string | null }
        >(
          `SELECT id, link_type, normalized_target, target_doc_id FROM document_links
              WHERE source_doc_id = ? AND link_type NOT IN ('cited', 'replies-to') ORDER BY id`,
        )
        .all(conversation.id);

    const foreignBefore = foreignRows();
    // Three foreign rows, actually written — not parked in `pending_edges`.
    expect(foreignBefore).toHaveLength(3);
    expect(foreignBefore.map((r) => r.link_type)).toEqual(["cited", "cited", "replies-to"]);
    const managedBefore = managedRows();
    expect(managedBefore).toHaveLength(120);
    // The managed range is bracketed by foreign ids on both sides, so an
    // id-range delete would take a foreign row with it.
    expect(Number(foreignBefore[1].id)).toBeLessThan(managedBefore[0].id);
    expect(Number(foreignBefore[2].id)).toBeGreaterThan(managedBefore[119].id);

    // Re-upsert the conversation the way another agent turn would: new
    // content and a new reference set. The upsert clears `links_extracted_at`.
    await gate.upsertDocuments([
      {
        providerId: ProviderId(THREADS_SOURCE),
        sourceId: SourceId(THREADS_SOURCE),
        externalId: conversation.externalId,
        title: conversation.title,
        content: PLAIN_CONTENT_V2,
        contentHash: "conv-hash-v2",
        sourceCreatedAt: SEED_TIME,
        sourceUpdatedAt: "2026-01-06T09:00:00.000Z",
        metadata: {
          documentType: "conversation",
          extra: { links: newTargets.map((t) => t.externalId) },
        },
      } satisfies DocumentInput,
    ]);
    expect(extractedAt(conversation.id)).toBeNull();

    const batchV2 = extractLinksForBatch(read, 5, [], [], true, [], true);
    expect(batchV2).toHaveLength(1);
    expect(batchV2[0].docId).toBe(conversation.id);
    expect(batchV2[0].links).toHaveLength(120);
    expect(new Set(batchV2[0].links.map((l) => l.type))).toEqual(new Set(["references"]));

    const { applyPromise, firstPressure } = forceYield(() =>
      gate.upsertExtractedLinksBatch(batchV2),
    );
    // Mid-delete — the user op ran because the bounded delete yielded
    // between chunks. The foreign rows are already untouched HERE, not just
    // once the whole document has been rewritten: a delete widened by one
    // type takes them out on its very first chunk.
    await firstPressure;
    expect(foreignRows()).toEqual(foreignBefore);
    expect(extractedAt(conversation.id)).toBeNull();

    await keepPressure(applyPromise, 20);
    expect(await applyPromise).toMatchObject({ applied: 1, skipped: 0 });

    // Row identity, not a count: a delete widened by one type, or one
    // rewritten as a range over the id cursor instead of a filter on
    // `link_type`, both show up as vanished or altered foreign rows.
    expect(foreignRows()).toEqual(foreignBefore);

    const managedAfter = managedRows();
    expect(managedAfter).toHaveLength(120);
    expect(new Set(managedAfter.map((r) => r.link_type))).toEqual(new Set(["references"]));
    // Exactly the v2 targets: a delete cursor that skipped a range — or a
    // resume that lost `deletedThroughLinkId` and restarted past rows it had
    // already walked — leaves stale v1 rows alongside the new ones.
    expect(new Set(managedAfter.map((r) => r.normalized_target))).toEqual(
      new Set(newTargets.map((t) => t.externalId)),
    );
    // The targets the read phase found rode the whole round trip with the
    // continuation, so every re-inserted row is resolved.
    expect(managedAfter.filter((r) => r.target_doc_id !== null)).toHaveLength(120);

    const snapshot = scheduler.snapshot(120);
    const stats = taskStats(snapshot, "links.upsertExtractedLinksBatch");
    expect(stats.yieldCount).toBeGreaterThanOrEqual(1);
    // One attempt per delete chunk plus one per insert chunk. The final
    // DELETE chunk can yield too — the token check precedes the
    // `deletion.complete` break — so both phases cost a full ceil().
    // The +2 covers the v1 apply's own single attempt and headroom.
    expect(stats.count).toBeLessThanOrEqual(Math.ceil(120 / LINK_APPLY_CHUNK_SIZE) * 2 + 2);
    expect(snapshot.preemptRequestCount).toBeGreaterThanOrEqual(1);
    expectOnlyTasks(snapshot, [
      "links.upsertExtractedLinksBatch",
      "omnesisChat.upsertConversationCitations",
      "db.upsertWithCursor",
      "db.upsertDocuments",
      "db.setSyncState",
    ]);
  }, 120_000);

  test("a preempted reconcile resumes its phase and offset across the resolve→delete boundary", async () => {
    const hub = seedDoc(NOTES_SOURCE, "hub-page-index");
    const pages = Array.from({ length: 400 }, (_, i) => {
      const suffix = String(i).padStart(3, "0");
      return seedDoc(NOTES_SOURCE, `page-${suffix}`, {
        sourceUrl: `https://example.com/page-${suffix}`,
      });
    });
    // Both sides of the resolution join are seeded raw and identical.
    // Routing the documents through `upsertDocuments` would normalize
    // `metadata.sourceUrl` on the document side only, the equality join
    // would miss, and all 460 links would land in the prune set instead.
    const resolvable: RawLink[] = pages.map((p) => ({
      sourceDocId: hub.id,
      normalizedTarget: p.sourceUrl!,
    }));
    const unresolvable: RawLink[] = Array.from({ length: 60 }, (_, i) => ({
      sourceDocId: hub.id,
      normalizedTarget: `https://absent.example.org/gone-${String(i).padStart(3, "0")}`,
    }));
    seedCorpus(dbPath, [hub, ...pages], [...resolvable, ...unresolvable]);
    await startScheduler();

    const linkIds = read
      .prepare<
        [string],
        { id: number; normalized_target: string }
      >("SELECT id, normalized_target FROM document_links WHERE source_doc_id = ? ORDER BY id")
      .all(hub.id);
    expect(linkIds).toHaveLength(460);
    const maxLinkId = linkIds[459].id;
    const doomedIds = new Set(
      linkIds.filter((r) => r.normalized_target.includes("absent")).map((r) => r.id),
    );
    expect(doomedIds.size).toBe(60);

    // `expectedCollectorRosterRevision` is deliberately left undefined:
    // `rosterMatches()` then short-circuits true on the writer. Wiring a
    // real revision in would let the writer abandon the batch and return
    // `remaining: null` having written nothing, turning every assertion
    // below into a silent zero rather than a red.
    const batch = computeLinkResolutions(read, 500, [], [], true, [], true, undefined);
    // Assert the batch is the shape the derivations below assume, so a
    // seeding mistake fails loudly instead of widening a bound.
    expect(batch.resolutions).toHaveLength(460);
    expect(batch.resolutions.filter((r) => r.targetDocId !== null)).toHaveLength(400);
    expect(batch.deletableLinkIds).toHaveLength(60);
    expect(new Set(batch.deletableLinkIds)).toEqual(doomedIds);
    expect(batch.scannedMaxId).toBe(maxLinkId);
    // With no fallback / reference-only prefixes the ownership planner is
    // switched off entirely, so those phases contribute no chunks and the
    // finish transaction skips their cursors.
    expect(batch.retargets ?? []).toHaveLength(0);
    expect(batch.sameResourceUpdates ?? []).toHaveLength(0);
    expect(batch.ownershipLinkScannedMaxId).toBeUndefined();
    expect(batch.expectedCollectorRosterRevision).toBeUndefined();

    const reconcileState = () =>
      read
        .prepare<
          [],
          { cursor: number; url_cycle_max_id: number }
        >("SELECT cursor, url_cycle_max_id FROM link_reconcile_state WHERE id = 1")
        .get()!;
    const resolvedCount = () =>
      read
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_links WHERE source_doc_id = ? AND target_doc_id IS NOT NULL")
        .get(hub.id)!.n;
    expect(reconcileState().cursor).toBe(0);

    const samples: Array<{ cursor: number; resolved: number }> = [];
    const sample = () =>
      samples.push({ cursor: reconcileState().cursor, resolved: resolvedCount() });

    const { applyPromise, firstPressure } = forceYield(() => gate.upsertLinkResolutions(batch));
    // The user op ran because the apply yielded between chunks, so this
    // samples the batch part-way through its `resolve` phase. The durable
    // cursor must still be 0: a cursor that runs ahead of applied work
    // drops the tail of the batch for a whole reconcile cycle — days on a
    // large corpus — with nothing to show that it happened.
    await firstPressure;
    sample();
    expect(samples[0].resolved).toBeLessThan(400);
    expect(samples[0].cursor).toBe(0);

    await keepPressure(applyPromise, 40, sample);
    const result = await applyPromise;

    // The reconcile's continuation carries its running counters, so unlike
    // the extraction apply the final result describes the whole batch.
    expect(result).toEqual({ updated: 400, deleted: 60, retargeted: 0 });

    const after = read
      .prepare<
        [string],
        { id: number; target_doc_id: string | null }
      >("SELECT id, target_doc_id FROM document_links WHERE source_doc_id = ? ORDER BY id")
      .all(hub.id);
    // The delete phase ran, which is only true if the continuation resumed
    // at the phase it yielded in instead of restarting at `resolve`.
    expect(after).toHaveLength(400);
    expect(after.filter((r) => r.target_doc_id !== null)).toHaveLength(400);
    expect(after.filter((r) => doomedIds.has(r.id))).toEqual([]);

    // The cursor advances only in the final transaction, after every
    // mutation phase committed.
    expect(reconcileState()).toEqual({ cursor: maxLinkId, url_cycle_max_id: maxLinkId });
    // Monotone guard over whatever else the bounded loop caught. It can
    // flag a violation but never manufacture one, so it stays safe on a
    // loaded box; the deterministic signal is the sample above plus the
    // terminal state.
    for (const s of samples) {
      if (s.cursor > 0) expect(s.resolved).toBe(400);
    }

    const snapshot = scheduler.snapshot(120);
    const stats = taskStats(snapshot, "links.upsertLinkResolutions");
    expect(stats.yieldCount).toBeGreaterThanOrEqual(1);
    // Derived from the batch, not hand-counted: the `resolve` phase carries
    // all 460 rows (the 60 nulls ride along and do no writer work), the
    // `delete` phase the 60 prune ids. +3 covers the finish-only attempt
    // and headroom without admitting a restart.
    const expectedChunks =
      Math.ceil(batch.resolutions.length / LINK_RECONCILE_APPLY_CHUNK_SIZE) +
      Math.ceil(batch.deletableLinkIds.length / LINK_RECONCILE_APPLY_CHUNK_SIZE);
    expect(stats.count).toBeLessThanOrEqual(expectedChunks + 3);
    expect(snapshot.preemptRequestCount).toBeGreaterThanOrEqual(1);
    expectOnlyTasks(snapshot, ["links.upsertLinkResolutions", "db.setSyncState"]);
  }, 120_000);
});

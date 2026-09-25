// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What search is ready to answer, and when.
 *
 * A search answer is assembled from stores that settle at different times:
 * chunks in `index.db`, attribution in `document_people`, and the read handle
 * the query happens to be served through. Each lag is invisible to the caller,
 * and none of them can be expressed in a unit test — a fixture that hands one
 * function a database it just wrote cannot say "the writer has committed and
 * this reader cannot see it yet", which is the only interesting state. Here the
 * stores are separate connections in separate threads of a real gateway, so
 * they can genuinely disagree.
 *
 * Five readiness claims are pinned:
 *
 *   - **The search-worker pool comes up in a spawned gateway.** It is the one
 *     subsystem whose failure is invisible: on an init throw, a crash, or a
 *     worker entry that will not resolve under tsx or in a published build,
 *     `SearchPipeline.candidateGen` runs the identical core inline on main and
 *     every search still answers. Nothing else in the tree would redden. The
 *     worker's own `ready` line is the whole signal — the pool's `starting N`
 *     line is logged before it awaits readiness, so it appears verbatim on a
 *     pool that then throws in init and is disposed.
 *
 *   - **The boot cache pre-warm completes on its own thread.** It runs on a
 *     throwaway worker whose entry has to resolve the same way the search
 *     worker's does, and it is fire-and-forget: a warm that never came back
 *     would cost the operator nothing but a cold first search and one missing
 *     log line. The completion line, with its row count, is the whole signal.
 *
 *   - **An update that changes no embedding input keeps its vectors and still
 *     advances the semantic clock.** Label moves, RSVP changes and read
 *     receipts land in this branch by the thousand. If `event_indexed_at`
 *     stopped moving, the subscription cursor would leave those rows behind its
 *     watermark forever while the vectors stayed correct and search kept
 *     working — a silence with no other symptom.
 *
 *   - **A document is text-searchable before it is person-searchable, and the
 *     person filter reports the gap as an absence.** Chunks reach `index.db` on
 *     the indexer path; `document_people` is filled by a background drip whose
 *     window is one tick for a single document and the whole corpus during a
 *     first sync. It is frozen here with the background pause rather than
 *     raced, and the freeze is verified on both edges from the very column the
 *     drip stamps.
 *
 *   - **The lane that serves a query decides what it can see.** The pipeline's
 *     delegate-or-fallback gate documents the fallback as byte-identical over
 *     "the same `index.db` handle". The handles are not the same: the worker's
 *     is opened read-only with no held transaction and takes a fresh snapshot
 *     per statement, while the main thread reads a handle anchored in a `BEGIN`
 *     that advances only on the configured refresh cadence. The last test
 *     drives both lanes over the same corpus and pins the asymmetry, so a
 *     change on either side — a snapshot for the worker, a live handle for main
 *     — has to come past this file.
 *
 * Every wait terminates on an observed row, counter, status field or log line
 * read straight from the gateway's own stores; nothing waits on elapsed time.
 * All fixture data is invented.
 */

import "./synth-env.js";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import SqliteDatabase from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { waitForCondition } from "./multi-collector-harness.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

/** `pushDocument`'s default source. Ingest self-registers it on first arrival. */
const SOURCE = "synthetic:test@example.com";

/** The metadata-only-update fixture. Its embedding inputs never move. */
const META_EXTERNAL_ID = "readiness-meta-1";
const META_TITLE = "Causeway crossing timetable";
const META_CONTENT = "Ferry timetable for the Northmoor causeway crossing";
/**
 * Pinned rather than defaulted to "now": `source_created_at` is one of the four
 * embedding-preamble inputs, so freezing it is what makes the second push a
 * metadata-only update rather than a re-embed.
 */
const META_CREATED_AT = "2026-04-02T09:00:00.000Z";

/** The attribution fixture. Priya is resolved in `beforeAll`; Theo arrives frozen. */
const PEOPLE_EXTERNAL_ID = "readiness-people-1";
const PEOPLE_TITLE = "Spinnaker quote";
const PEOPLE_CONTENT = "Sailmaker quote for the Northmoor regatta spinnaker";
const PRIYA = { name: "Priya Anand", email: "priya.anand@example.com" } as const;
const THEO = { name: "Theo Marsh", email: "theo.marsh@example.com" } as const;

/** The lane fixtures. Each is pushed after the boot it is meant to be invisible to. */
const LANE_A_EXTERNAL_ID = "readiness-lane-a";
const LANE_A_CONTENT = "Tidal survey addendum for the kestrel bay crossing";
const LANE_B_EXTERNAL_ID = "readiness-lane-b";
const LANE_B_CONTENT = "Harrowgate lighthouse keeper's ledger";

/** The worker's own readiness line, posted immediately before `post({type:"ready"})`. */
const WORKER_READY_LINE = "ready — read-only index.db handle on";
/** The pool's construction line. Logged BEFORE it awaits readiness — see the header. */
const POOL_STARTING_LINE = "starting 1 search worker(s)";
const PIPELINE_ATTACHED_LINE = "Search pipeline: worker pool attached";
/**
 * Search-scoped exit/error strings. The bare phrase "exited unexpectedly" is
 * shared with the cpu, io and writer runners, so matching on it would redden
 * this file for an unrelated pool.
 */
const POOL_FAILURES = [
  "search worker pool failed to start",
  "search worker 0 error",
  "search worker 0 exited unexpectedly",
] as const;
/** The pipeline's per-query fallback warning — proof a query did NOT reach the worker. */
const WORKER_FALLBACK_LINE = "search-worker candidate-gen failed, running on main";
/** The warm thread's completion, logged by the main thread once it reports. */
const PREWARM_COMPLETE_LINE = "search cache pre-warm complete in";
const PREWARM_FAILED_LINE = "search cache pre-warm failed";

let harness: SyntheticE2EHarness;
/** `process.env` value to put back in `afterAll`; `undefined` means "was absent". */
let priorSearchWorkerConcurrency: string | undefined;

// ── Reading the two stores ─────────────────────────────────────────────────

interface IndexedRow {
  content_hash: string;
  chunk_count: number;
  source_event_at: string;
  event_indexed_at: string;
}

interface ChunkRow {
  chunk_index: number;
  tags: string | null;
  relevance_score: number | null;
  embedding: Buffer | null;
}

/**
 * A read-only connection per read rather than one hoisted handle: the indexer
 * worker writes `index.db` while this reads it, and a fresh connection is what
 * lets a transient `SQLITE_BUSY` be retried by the caller instead of poisoning
 * a long-lived handle. Every predicate below funnels its throws into "ask
 * again", never into "there are none".
 */
function readIndexDb<T>(fn: (db: SqliteDatabase.Database) => T): T {
  const db = new SqliteDatabase(join(harness.getConfigDir(), "index.db"), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readGatewayDb<T>(fn: (db: SqliteDatabase.Database) => T): T {
  const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The gateway document id for a pushed external id. Throws when it is not stored. */
function docIdOf(externalId: string): string {
  const row = readGatewayDb((db) =>
    db
      .prepare<
        [string, string],
        { id: string }
      >("SELECT id FROM documents WHERE source_id = ? AND external_id = ?")
      .get(SOURCE, externalId),
  );
  if (!row) throw new Error(`no document ${externalId} stored for ${SOURCE}`);
  return row.id;
}

/** The gateway's revision clock for a document — what the indexer stamps as its event. */
function docUpdatedAt(documentId: string): string {
  const row = readGatewayDb((db) =>
    db
      .prepare<[string], { updated_at: string }>("SELECT updated_at FROM documents WHERE id = ?")
      .get(documentId),
  );
  if (!row) throw new Error(`no document row for ${documentId}`);
  return row.updated_at;
}

/** `documents.people_resolved_at` — the exact column `backfillOnePerson` stamps. */
function peopleResolvedAt(documentId: string): string | null {
  const row = readGatewayDb((db) =>
    db
      .prepare<
        [string],
        { people_resolved_at: string | null }
      >("SELECT people_resolved_at FROM documents WHERE id = ?")
      .get(documentId),
  );
  if (!row) throw new Error(`no document row for ${documentId}`);
  return row.people_resolved_at;
}

function indexRow(documentId: string): IndexedRow | undefined {
  return readIndexDb((db) =>
    db
      .prepare<
        [string],
        IndexedRow
      >("SELECT content_hash, chunk_count, source_event_at, event_indexed_at FROM indexed_documents WHERE document_id = ?")
      .get(documentId),
  );
}

function chunkRows(documentId: string): ChunkRow[] {
  return readIndexDb((db) =>
    db
      .prepare<
        [string],
        ChunkRow
      >("SELECT chunk_index, tags, relevance_score, embedding FROM chunks WHERE document_id = ? ORDER BY chunk_index")
      .all(documentId),
  );
}

/** A polling predicate's view of the index: a throw means "ask again". */
function settledIndexRow(documentId: string): IndexedRow | undefined {
  try {
    return indexRow(documentId);
  } catch {
    return undefined;
  }
}

function settledChunkRows(documentId: string): ChunkRow[] {
  try {
    return chunkRows(documentId);
  } catch {
    return [];
  }
}

// ── Talking to the gateway ─────────────────────────────────────────────────

interface SearchResponse {
  results?: Array<{ documentId: string }>;
  notices?: Array<{ filter: string; level: string; token?: string; message: string }>;
}

async function search(text: string): Promise<SearchResponse> {
  return harness.gatewayJson<SearchResponse>("/search", {
    method: "POST",
    body: JSON.stringify({ text, limit: 20 }),
  });
}

function hitIds(response: SearchResponse): string[] {
  return (response.results ?? []).map((r) => r.documentId);
}

interface SnapshotStatus {
  enabled: boolean;
  refreshCount: number;
}

async function snapshotStatus(): Promise<SnapshotStatus> {
  return harness.gatewayJson<SnapshotStatus>("/admin/search-snapshot/status");
}

function gatewayLog(): string {
  return readFileSync(harness.getGatewayLogPath(), "utf8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Wait until a pushed document has a row in `documents`, and answer its id. */
async function waitForStoredDoc(externalId: string): Promise<string> {
  await waitForCondition(
    () => {
      try {
        docIdOf(externalId);
        return true;
      } catch {
        return false;
      }
    },
    60_000,
    `the ${externalId} document to be stored`,
  );
  return docIdOf(externalId);
}

/** Wait until a document has both an `indexed_documents` row and at least one chunk. */
async function waitForIndexed(documentId: string, label: string): Promise<void> {
  await waitForCondition(
    () => settledIndexRow(documentId) !== undefined && settledChunkRows(documentId).length > 0,
    90_000,
    label,
  );
}

describe("Search readiness: the pool, the semantic clock, attribution lag, and the serving lane", () => {
  beforeAll(async () => {
    priorSearchWorkerConcurrency = process.env.OMNESIS_SEARCH_WORKER_CONCURRENCY;

    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      // `getEmbedCount()` is the only way to prove the indexer did NOT re-embed.
      embedderBackend: "fake",
      extraGatewayConfig: {
        search: {
          // Snapshot isolation stays ON (the shipped default) — it is the
          // subject of the last test. The refresh cadence is pinned an hour out
          // so the periodic refresher can neither rescue the main-thread lane
          // mid-test nor advance the snapshot under an assertion that has
          // already read `refreshCount`.
          snapshot: { enabled: true, refreshIntervalMs: 3_600_000 },
        },
      },
      extraGatewayEnv: {
        // The pool's start line and the worker's ready line are info-level;
        // the harness defaults the spawned gateway to warn.
        OMNESIS_LOG_LEVEL: "info",
        // Two info-level boots must not rotate the first boot's lines out.
        OMNESIS_LOG_MAX_BYTES: "268435456",
      },
    });
    await harness.start();

    // No `syncAllSources()`. The harness runs the roster at a 999999s interval
    // with `skipInitialSync`, so an unsynced roster produces no documents at
    // all: the corpus is exactly the four documents this file pushes, which is
    // what makes "this one document is the people backlog" a statement rather
    // than a hope. Devices are still paired and registered, so ingest, the
    // writer, the indexer, the scheduler and the search pipeline are real.
    await harness.pushDocuments([
      {
        externalId: META_EXTERNAL_ID,
        title: META_TITLE,
        content: META_CONTENT,
        sourceCreatedAt: META_CREATED_AT,
        sourceUpdatedAt: META_CREATED_AT,
      },
      {
        externalId: PEOPLE_EXTERNAL_ID,
        title: PEOPLE_TITLE,
        content: PEOPLE_CONTENT,
        metadata: { people: [{ role: "sender", name: PRIYA.name, emails: [PRIYA.email] }] },
      },
    ]);

    const metaDocId = await waitForStoredDoc(META_EXTERNAL_ID);
    const peopleDocId = await waitForStoredDoc(PEOPLE_EXTERNAL_ID);

    await waitForIndexed(metaDocId, "the metadata fixture to be indexed");
    await waitForIndexed(peopleDocId, "the attribution fixture to be indexed");
    await waitForCondition(
      () => peopleResolvedAt(peopleDocId) !== null,
      60_000,
      "the people drip to attribute the attribution fixture",
    );

    // Advance the boot snapshot once, so BOTH lanes can see the two long-lived
    // documents. Without this the main-thread lane reads a `BEGIN` anchored
    // before either existed, and every search assertion in this file would
    // silently depend on the worker pool having readied — turning a pool fault
    // into "search returned nothing" instead of a named failure. It costs one
    // `COMMIT; BEGIN;`, and it does not cost the last test its
    // `refreshCount === 0` assertion: that boot opens a fresh handle.
    await harness.refreshSearchSnapshot();
  }, 300_000);

  afterAll(async () => {
    if (priorSearchWorkerConcurrency === undefined) {
      delete process.env.OMNESIS_SEARCH_WORKER_CONCURRENCY;
    } else {
      process.env.OMNESIS_SEARCH_WORKER_CONCURRENCY = priorSearchWorkerConcurrency;
    }
    await harness.destroy();
  });

  test("the search-worker pool comes up in a spawned gateway and nothing faults it back to the main thread", async () => {
    // The pool is started fire-and-forget at boot (`pool.start().catch(...)`),
    // so nothing in the boot sequence — not `/health`, not the two indexing
    // waits — orders the worker's readiness against this read. Gate on the line
    // itself. Its absence, once the budget is spent, IS the finding.
    await waitForCondition(
      () => gatewayLog().includes(WORKER_READY_LINE),
      90_000,
      "the search worker to post its own ready line",
    );

    const log = gatewayLog();

    // The worker opened its read-only `index.db` handle and its usearch
    // registry and posted `ready`. That is the `readyCount >= concurrency`
    // condition `isReady` gates on, and the pool has no other observable:
    // `getSearchWorkerFallbacks()` is never routed, `isReady` is never
    // surfaced, and a dead pool changes no HTTP response.
    expect(log).toContain(WORKER_READY_LINE);
    // Weaker companions, worth pinning only for what they actually mean: the
    // pool was constructed at the configured concurrency, and the pipeline
    // holds it rather than an undefined. Both are logged before the pool awaits
    // readiness, so neither says anything about the worker being alive.
    expect(log).toContain(POOL_STARTING_LINE);
    expect(log).toContain(PIPELINE_ATTACHED_LINE);

    // The three lines that mark a pool which has silently and permanently
    // reverted every query to the main thread.
    for (const failure of POOL_FAILURES) expect(log).not.toContain(failure);
  }, 120_000);

  test("the boot cache pre-warm completes on its own thread and reports what it scanned", async () => {
    // Scheduled right after the `Listening on` line and awaited by nothing,
    // so the line is gated on directly. Its absence, once the budget is
    // spent, is the finding: the worker entry did not resolve, the thread
    // died before reporting, or the main thread never heard back.
    await waitForCondition(
      () => gatewayLog().includes(PREWARM_COMPLETE_LINE),
      90_000,
      "the boot pre-warm to report completion",
    );
    const log = gatewayLog();
    expect(log).not.toContain(PREWARM_FAILED_LINE);
    // The thread ran the scans and counted rows — a number, not a placeholder.
    expect(log).toMatch(/search cache pre-warm complete in \d+ms \(\d+ rows/);
  }, 120_000);

  test("an update that changes no embedding input keeps its vectors and still advances the semantic clock", async () => {
    const documentId = docIdOf(META_EXTERNAL_ID);
    const before = indexRow(documentId);
    expect(before, "the metadata fixture is indexed before it is updated").toBeDefined();
    const beforeChunks = chunkRows(documentId);
    expect(beforeChunks.length).toBeGreaterThan(0);
    expect(beforeChunks.every((row) => row.embedding !== null)).toBe(true);
    const beforeEmbeds = harness.getEmbedCount();
    const beforeUpdatedAt = docUpdatedAt(documentId);
    expect(before!.source_event_at).toBe(beforeUpdatedAt);

    // Byte-identical content, title, and both source timestamps, so the
    // recomputed sha256 matches and the embedding preamble (documentType +
    // title + author + sourceCreatedAt) is unchanged. Only the two
    // denormalized non-embedding metadata fields move.
    await harness.pushDocument({
      externalId: META_EXTERNAL_ID,
      title: META_TITLE,
      content: META_CONTENT,
      sourceCreatedAt: META_CREATED_AT,
      sourceUpdatedAt: META_CREATED_AT,
      metadata: { tags: ["triaged"], relevanceScore: 0.75 },
    });

    // Barrier on the LAST write of the branch, not the first.
    // `updateChunkNonEmbeddingMetadata` and `markIndexedDocumentEvent` are two
    // separately auto-committed statements with no surrounding transaction, so
    // waking on the chunk write would let the event assertions read an
    // `indexed_documents` row that has not been stamped yet.
    await waitForCondition(
      () => {
        try {
          // Require the document row to have moved on from the pre-push
          // revision as well, so a read that raced the ingest commit cannot
          // satisfy the barrier against the OLD clock on both sides.
          const revision = docUpdatedAt(documentId);
          if (revision === beforeUpdatedAt) return false;
          return settledIndexRow(documentId)?.source_event_at === revision;
        } catch {
          return false;
        }
      },
      90_000,
      "the indexer to stamp the metadata-only update's gateway event",
    );
    const updatedAt = docUpdatedAt(documentId);

    const after = indexRow(documentId)!;
    const afterChunks = chunkRows(documentId);

    // The update really happened, and it really was the metadata-only branch.
    expect(updatedAt).not.toBe(before!.source_event_at);
    expect(after.content_hash).toBe(before!.content_hash);
    expect(after.chunk_count).toBe(before!.chunk_count);
    expect(afterChunks.length).toBe(beforeChunks.length);
    expect(afterChunks.length).toBeGreaterThan(0);
    expect(afterChunks.every((row) => row.tags === '["triaged"]')).toBe(true);
    expect(afterChunks.every((row) => row.relevance_score === 0.75)).toBe(true);

    // The vectors survived. Blob identity first: the fake embedder is
    // deterministic, so identical blobs would also survive a wasteful re-embed
    // — but a write that clobbered them with nulls shows here and nowhere else.
    for (const [i, chunk] of afterChunks.entries()) {
      const original = beforeChunks[i]!.embedding;
      expect(chunk.embedding, `chunk ${chunk.chunk_index} kept an embedding`).not.toBeNull();
      expect(
        Buffer.compare(chunk.embedding!, original!),
        `chunk ${chunk.chunk_index} vector is byte-identical`,
      ).toBe(0);
    }
    // And no embedding was even requested. The window is bounded by two
    // adjacent statements over a quiescent corpus — nothing else in this
    // gateway embeds — so a moved counter names a widened `embeddingChanged`
    // predicate rather than ambient noise.
    expect(harness.getEmbedCount()).toBe(beforeEmbeds);

    // The subscription cursor moved. `sweepIndexed` pages on
    // `event_indexed_at > ?`, and `nextIndexedEventAt` deliberately adds a
    // millisecond rather than repeat a clock, so this is strictly greater —
    // a stamp that failed to move leaves the row behind the watermark forever.
    expect(after.event_indexed_at > before!.event_indexed_at).toBe(true);
  }, 150_000);

  test("a document is text-searchable before it is person-searchable, and the person filter reports the gap as an absence", async () => {
    const documentId = docIdOf(PEOPLE_EXTERNAL_ID);
    const metaDocumentId = docIdOf(META_EXTERNAL_ID);

    // Drain first. The previous test's re-push nulled the metadata fixture's
    // attribution too, so the drip has outstanding work; pausing while a tick
    // is mid-loop would let that tick adopt the row this test is about to null.
    // Waiting for the backlog to empty is what makes the pause a freeze.
    await waitForCondition(
      () => peopleResolvedAt(metaDocumentId) !== null && peopleResolvedAt(documentId) !== null,
      90_000,
      "the people drip to drain its backlog before the freeze",
    );

    const paused = await harness.gatewayJson<{ paused: boolean }>("/admin/background/pause", {
      method: "POST",
    });
    expect(paused.paused, "background dispatch is paused").toBe(true);

    let resumed: { paused: boolean } | undefined;
    try {
      // `db.upsertDocuments` is realtime priority, so ingest itself is
      // unaffected by the pause; `backfill.peopleBatch` is background, so the
      // tick the ingest nudge kicks is enqueued and refused until resume.
      await harness.pushDocument({
        externalId: PEOPLE_EXTERNAL_ID,
        title: PEOPLE_TITLE,
        content: PEOPLE_CONTENT,
        metadata: {
          people: [
            { role: "sender", name: PRIYA.name, emails: [PRIYA.email] },
            { role: "recipient", name: THEO.name, emails: [THEO.email] },
          ],
        },
      });

      // The upsert's ON CONFLICT nulls `people_resolved_at` on any metadata
      // change, so the document is back in the backlog — and frozen there.
      await waitForCondition(
        () => peopleResolvedAt(documentId) === null,
        60_000,
        "the re-pushed document to re-enter the people backlog",
      );

      // Control first: if the corpus or a lane is broken, this is what says so,
      // rather than the absence assertion reading as a correct absence.
      const freeText = await search("Northmoor regatta spinnaker");
      expect(hitIds(freeText)).toContain(documentId);

      // Attribution degrades by going out of date, never by going blank:
      // `resolveDocumentPeople` deletes and reinserts `document_people` only
      // when it actually runs. A fix that eagerly cleared rows on ingest would
      // make the whole corpus person-invisible for the length of the backlog.
      const withPriya = await search(`Northmoor with:${PRIYA.email}`);
      expect(hitIds(withPriya)).toContain(documentId);

      // The new mention is not reachable by any route the caller has. The
      // notice's `level` is the discriminator that makes this assertion mean
      // what the title says: `error` is "no person in the people graph matches
      // this ref", `info` is "the person exists but has no documents in that
      // role" — both carry filter `person` and this exact token.
      const withTheo = await search(`Northmoor with:${THEO.email}`);
      expect(hitIds(withTheo)).toEqual([]);
      expect(withTheo.notices ?? []).toContainEqual(
        expect.objectContaining({
          filter: "person",
          level: "error",
          token: `with:${THEO.email}`,
        }),
      );

      const attributed = await harness.gatewayJson<{
        people: Array<{ canonicalName: string; role: string }>;
      }>(`/documents/${documentId}/people`);
      expect(attributed.people.map((p) => p.canonicalName)).toContain(PRIYA.name);
      expect(attributed.people.map((p) => p.canonicalName)).not.toContain(THEO.name);

      // The freeze held for the whole window. Without this, a tick that slipped
      // through would resolve Theo and green the absence assertion above by
      // making it a race rather than a statement.
      expect(peopleResolvedAt(documentId), "attribution stayed frozen").toBeNull();
    } finally {
      resumed = await harness.gatewayJson<{ paused: boolean }>("/admin/background/resume", {
        method: "POST",
      });
    }

    // Load-bearing for the next test: `indexer.wake` is background priority, so
    // a stranded pause turns its indexing waits into unexplained timeouts.
    expect(resumed?.paused, "background dispatch resumed").toBe(false);

    // The gap is a lag, not a hole: the drip reaches a document whose
    // attribution was invalidated by a metadata-only update.
    await waitForCondition(
      () => peopleResolvedAt(documentId) !== null,
      90_000,
      "the people drip to re-attribute the document after resume",
    );
    await waitForCondition(
      async () => hitIds(await search(`Northmoor with:${THEO.email}`)).includes(documentId),
      60_000,
      "the newly-attributed person filter to return the document",
    );
    expect(hitIds(await search(`Northmoor with:${PRIYA.email}`))).toContain(documentId);
  }, 240_000);

  test("candidate generation on a worker sees the WAL head while the main-thread lane serves the boot snapshot", async () => {
    // ── Lane A: the pool is on, and it reads the WAL head ──────────────────
    //
    // The worker's handle is opened read-only with no held transaction, so
    // better-sqlite3's per-statement autocommit takes a fresh snapshot on every
    // query. A document indexed after boot is therefore visible with no admin
    // refresh — which is what a real client has.
    expect(gatewayLog()).toContain(WORKER_READY_LINE);
    const beforeLaneA = await snapshotStatus();
    expect(beforeLaneA.enabled).toBe(true);

    await harness.pushDocument({
      externalId: LANE_A_EXTERNAL_ID,
      title: "Tidal survey addendum",
      content: LANE_A_CONTENT,
    });
    const laneADocId = await waitForStoredDoc(LANE_A_EXTERNAL_ID);
    await waitForIndexed(laneADocId, "the lane-A document to be indexed");

    const logBeforeLaneA = gatewayLog();
    const laneA = await search("kestrel bay tidal survey addendum");
    const afterLaneA = await snapshotStatus();

    // Preconditions that make the hit mean something. The snapshot did not
    // advance while lane A was indexed and queried (the periodic refresher is
    // pinned an hour out), and the query was actually served by the worker
    // rather than falling back to main on a rejection.
    expect(afterLaneA.refreshCount, "the boot snapshot did not advance under lane A").toBe(
      beforeLaneA.refreshCount,
    );
    expect(
      countOccurrences(gatewayLog(), WORKER_FALLBACK_LINE),
      "no query fell back to the main thread during lane A",
    ).toBe(countOccurrences(logBeforeLaneA, WORKER_FALLBACK_LINE));
    expect(hitIds(laneA)).toContain(laneADocId);

    // ── Switch lanes ──────────────────────────────────────────────────────
    //
    // `e2eGatewayEnv(base = process.env)` preserves unrelated process env over
    // its E2E default of "1", and the harness's own explicit keys do not include
    // this one, so the respawned gateway resolves `searchWorkerConcurrency` to 0,
    // skips the pool block entirely, and serves every query from
    // `runCandidateGen` on main over the snapshot handle. The config key cannot
    // do this: `runtime-settings` reads the env var first, unconditionally.
    process.env.OMNESIS_SEARCH_WORKER_CONCURRENCY = "0";
    await harness.restartGateway();

    const logAfterRestart = gatewayLog();
    // The lane really did switch. Asserted before anything else in arm B, so a
    // gateway that came back up with a pool reads as "the lane did not switch"
    // rather than as a snapshot finding.
    expect(countOccurrences(logAfterRestart, POOL_STARTING_LINE)).toBe(1);
    expect(countOccurrences(logAfterRestart, PIPELINE_ATTACHED_LINE)).toBe(1);

    // ── Lane B: main only, over a snapshot anchored before the document ────
    await harness.pushDocument({
      externalId: LANE_B_EXTERNAL_ID,
      title: "Lighthouse keeper's ledger",
      content: LANE_B_CONTENT,
    });
    const laneBDocId = await waitForStoredDoc(LANE_B_EXTERNAL_ID);
    await waitForIndexed(laneBDocId, "the lane-B document to be indexed");

    const beforeRefresh = await search("Harrowgate lighthouse keeper ledger");
    const status = await snapshotStatus();
    await harness.refreshSearchSnapshot();
    const afterRefresh = await search("Harrowgate lighthouse keeper ledger");

    // Ordered so the failure message carries the diagnosis. The handle this
    // boot opened has never been advanced, and the document IS in `index.db` —
    // so a miss below is the snapshot, not an indexing lag.
    expect(status.refreshCount, "this boot's snapshot handle has never advanced").toBe(0);
    expect(chunkRows(laneBDocId).length).toBeGreaterThan(0);

    // The shipped contract, pinned as it is rather than as the pipeline's
    // doc comment describes it. `candidateGen` calls the main-thread fallback
    // "byte-identical because it is the same function over the same `index.db`
    // + usearch read handle"; it is not the same handle. The worker's is
    // unpinned (lane A above found its document with no refresh); main's is
    // anchored in a `BEGIN` taken at boot, so a document indexed afterwards is
    // invisible until the snapshot advances — for the whole post-restart boot
    // window, on every saturation fallback, while a crashed worker is respawned,
    // and always at concurrency 0. The day either side changes, this reddens.
    expect(hitIds(beforeRefresh)).not.toContain(laneBDocId);
    expect(hitIds(afterRefresh)).toContain(laneBDocId);
  }, 300_000);
});

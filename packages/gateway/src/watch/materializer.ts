// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The materializer — the gateway half of the journal contract.
 *
 * A watch does not subscribe to the event bus. The bus is in-memory and
 * at-most-once, people are resolved after a document is written, and embeddings
 * land later still, so an event taken straight off it is unordered, unpeopled
 * and blind to the semantic clock. This turns that raw signal into the durable,
 * ordered, enriched feed the runtime actually reads.
 *
 * Everything expensive happens here rather than in the handlers, because the
 * bus runs handlers synchronously on the main thread while this drain is a
 * scheduler task whose batch is capped. Four things it does that the bus
 * cannot:
 *
 * - **Defers a document until its people settle.** Person resolution runs after
 *   the upsert, so a bus-time event carries no person ids at all and every
 *   person-keyed predicate would be undefined. The document waits, bounded; on
 *   timeout it ships with what mentions it has and says `degraded`.
 * - **Deduplicates analytics rows** against their last-seen stable-column hash,
 *   because the ingest signal re-fires for every row on every page.
 * - **Sweeps the semantic clock** — `indexed_documents(event_indexed_at, id)` —
 *   which is the only clock a semantic match can ride.
 * - **Recovers what the bus lost while the gateway was down**, by sweeping
 *   documents past a persisted checkpoint at startup.
 *
 * ## The checkpoint discipline
 *
 * The checkpoint is the claim "every document at or before this point is in the
 * journal", and every rule about how it moves exists to keep that claim true,
 * because the startup sweep is going to trust it. Three rules, and each costs a
 * little duplication in exchange for never stepping over an event:
 *
 * - **It does not move while the startup sweep is still catching up.** The
 *   sweep walks a historical gap while live documents keep arriving, and a live
 *   document is newer than the whole gap by construction; letting one push the
 *   checkpoint to now would declare the unwalked remainder already done.
 * - **It does not move while any document is held back.** A deferred document —
 *   waiting for its people, or left over by the batch cap — is one the journal
 *   does not hold yet, so a checkpoint past it would tell the sweep to skip
 *   exactly what a crash would lose. On an install whose queue runs deeper than
 *   the batch cap, that means the checkpoint waits for the backlog to clear.
 * - **It does not move into a timestamp it might still be receiving.** One
 *   `upsertDocuments` call stamps a whole page with a single `updated_at`, and
 *   the bus delivers that page in sub-batches with yields between them, so a
 *   drain can see half a tie group. Document ids are random, so "the last one I
 *   processed" is not "the last one there is". The checkpoint therefore stops
 *   *before* the newest timestamp it journaled — a restart re-emits that one
 *   group rather than skipping the half it never saw.
 *
 * Duplicates are the safe direction: a re-emitted `updated` event carries
 * `contentChanged: false`, which the runtime's re-nomination rule already
 * treats as nothing new.
 *
 * What the sweep does **not** rescue is a document event the bus delivered and
 * the queue then dropped for want of capacity. Analytics rows do not share
 * that failure mode: they are pages in DuckDB's transactional outbox until the
 * Watch cursor commits them. Once the document sweep has finished, its
 * checkpoint follows the live path, and a dropped document older than one the
 * live path journaled sits behind it. Overflow is therefore a real document
 * loss, and the queue says so and counts it rather than claiming otherwise.
 */

import { createLogger, type Logger } from "@omnesis/core";
import { sourceTypeOf } from "@omnesis/types";
import { toJournalInstant } from "@omnesis/watch";
import { ANALYTICS_STREAM_COLUMN } from "@omnesis/source-sdk";
import { decodeCheckpoint, encodeCheckpoint, isAfter, type Checkpoint } from "./checkpoint.js";
import { declaredMetadata, parseMetadata } from "./declared-metadata.js";
import { canonicalizeDeclaredTemporals } from "./canonical-row.js";
import { hashKey, primaryKeyOf, stableEventHash, stableRowHash, type RowKey } from "./row-hash.js";
import { seenKey } from "./store.js";
import type { AnalyticsTableSchema, DocumentEventProfile } from "@omnesis/source-sdk";
import type { Db } from "../data/types.js";
import type { MaterializerQueue, QueuedDocument, QueuedRow } from "./queue.js";
import type { NewJournalEvent, WatchJournalStore } from "./store.js";
import type { WatchOutboxBatch, WatchOutboxCursor } from "../analytics/watch-outbox-store.js";

const log: Logger = createLogger("gateway").child("watch-v2:materializer");

/** How long a document waits for its people before it ships degraded. */
const DEFAULT_SETTLEMENT_MS = 60_000;
/** Rows read per sweep page, for both the recovery and indexed sweeps. */
const SWEEP_PAGE = 200;
/** Where the indexed sweep and the recovery sweep last reached. */
const INDEXED_CURSOR = "doc.indexed.cursor";
const DOCUMENT_CHECKPOINT = "documents.checkpoint";
const ANALYTICS_OUTBOX_CURSOR = "analytics.outbox.cursor";

/**
 * A row's key as the analytics store holds it.
 *
 * A partitioned source's table is keyed by the declared primary key PLUS the
 * device stream that wrote the row, so two phones' identically-keyed rows are
 * two rows. Dedupe on the declared key alone and they are one journal identity:
 * the second phone's row is dropped as a redelivery when the two agree, and
 * when they disagree the stored hash flips between them on every page, so the
 * journal reports an endless run of updates to a row nobody changed.
 *
 * The column is absent — not empty — on a source with one stream, which is
 * exactly how the store leaves it, so a non-partitioned row's key is unchanged.
 */
function withStreamKey(pk: RowKey, row: Readonly<Record<string, unknown>>): RowKey {
  const stream = row[ANALYTICS_STREAM_COLUMN];
  if (typeof stream !== "string" || stream === "") return pk;
  return { ...pk, [ANALYTICS_STREAM_COLUMN]: stream };
}

/**
 * The parts of an analytics table's declaration the journal reads.
 *
 * Narrower than `AnalyticsTableSchema` on purpose: the catalog's stored schema
 * carries no `description` or `record` block, so asking for the full type here
 * would force a cast that fabricates fields — and a later reader of one of
 * those fields would be a runtime error the compiler had blessed.
 */
export type JournalTableSchema = Pick<
  AnalyticsTableSchema,
  "columns" | "primaryKey" | "semanticTimeColumn"
>;

export interface MaterializerDeps {
  /** Read handle on the documents/people store. */
  readonly db: Db;
  /**
   * Read handle on `index.db`, or null when the gateway runs without one.
   * Absent means no semantic clock: `doc.indexed` is simply not produced, and
   * a semantic watch is never nominated, which is honest rather than silent —
   * the alternative would be a watch that validates and can never fire.
   */
  readonly indexDb: Db | null;
  readonly store: WatchJournalStore;
  readonly queue: MaterializerQueue;
  /** Durable analytics pages; absent for standalone/unit hosts. */
  readonly analyticsOutbox?: {
    readWatchOutbox(cursor: WatchOutboxCursor, limit: number): Promise<WatchOutboxBatch>;
  };
  /** The analytics schema for a table, for the stable-column hash. */
  readonly tableSchema: (table: string) => Promise<JournalTableSchema | null>;
  /** What a source declared its documents can be asked about. */
  readonly documentProfile: (sourceType: string) => DocumentEventProfile | null;
  readonly now?: () => number;
  readonly settlementMs?: number;
  /**
   * Journal events written per drain, and queue entries examined per drain.
   *
   * Bounds one tick's time on the main thread in both directions: an entry
   * that produces no event still costs a read, so a queue full of unsettled
   * documents would otherwise be re-examined in full on every tick.
   */
  readonly batchSize?: number;
}

/** What one drain did, for the resource accounting shadow mode reports. */
export interface DrainResult {
  documents: number;
  rows: number;
  indexed: number;
  recovered: number;
  /** Documents held back: deferred for people, or beyond the batch cap. */
  deferred: number;
  /** Analytics rows the batch cap did not reach. */
  pending: number;
  degraded: number;
  droppedRedeliveries: number;
  /** True when nothing was pending and nothing swept — the idle signal. */
  idle: boolean;
}

interface DocumentRow {
  id: string;
  source_id: string;
  provider_id: string;
  title: string;
  content_hash: string;
  metadata: string;
  source_created_at: string;
  updated_at: string;
  people_resolved_at: string | null;
}

export class Materializer {
  private readonly now: () => number;
  private readonly settlementMs: number;
  private readonly batchSize: number;
  /** Set while the startup sweep still has pages to walk. */
  private recovering = true;

  constructor(private readonly deps: MaterializerDeps) {
    this.now = deps.now ?? Date.now;
    this.settlementMs = deps.settlementMs ?? DEFAULT_SETTLEMENT_MS;
    this.batchSize = deps.batchSize ?? 500;
  }

  /** Next durable analytics page/row this materializer owes the journal. */
  outboxCursor(): WatchOutboxCursor {
    return decodeOutboxCursor(this.deps.store.getState(ANALYTICS_OUTBOX_CURSOR));
  }

  /** Read and decode DuckDB input before taking the single Watch write turn. */
  loadAnalyticsBatch(): Promise<WatchOutboxBatch | null> {
    if (!this.deps.analyticsOutbox) return Promise.resolve(null);
    return this.deps.analyticsOutbox.readWatchOutbox(this.outboxCursor(), this.batchSize);
  }

  /**
   * One pass: recover what was lost, drain what is queued, sweep the semantic
   * clock, and commit all of it with its cursors in a single transaction.
   *
   * A batch that fails anywhere before the commit goes back to the queue whole.
   * The alternative is that one transient analytics-catalog error or one busy
   * database silently discards everything the drain had taken, which for
   * documents the recovery sweep would eventually undo and for rows nothing
   * would.
   */
  async drain(preloadedAnalytics?: WatchOutboxBatch | null): Promise<DrainResult> {
    const result: DrainResult = {
      documents: 0,
      rows: 0,
      indexed: 0,
      recovered: 0,
      deferred: 0,
      pending: 0,
      degraded: 0,
      droppedRedeliveries: 0,
      idle: false,
    };

    const events: NewJournalEvent[] = [];
    const state: Record<string, string> = {};
    const seenRows: { table: string; pkHash: string; rowHash: string }[] = [];
    const seenDocuments: { docId: string; eventHash: string }[] = [];

    // Whether this pass finished the sweep is only knowable once it is written.
    // Recording it before the commit would let one failed drain leave the
    // materializer believing a gap it never journaled had been closed, and the
    // next drain would move the checkpoint straight past it.
    const sweptToTheEnd = this.recovering ? this.recover(events, state, result) : true;

    const pending = this.deps.queue.take();
    let heldBack: QueuedDocument[];
    let unread: QueuedRow[];
    try {
      heldBack = this.materializeDocuments(pending.documents, events, state, result, seenDocuments);
      result.deferred = heldBack.length;

      let remaining = this.batchSize;
      if (this.deps.analyticsOutbox) {
        const cursor = decodeOutboxCursor(this.deps.store.getState(ANALYTICS_OUTBOX_CURSOR));
        const batch =
          preloadedAnalytics ??
          (await this.deps.analyticsOutbox.readWatchOutbox(cursor, remaining));
        const outboxRows: QueuedRow[] = batch.rows.map((entry) => ({
          at: entry.at,
          table: entry.table,
          sourceId: entry.sourceId,
          row: entry.row,
          schema: entry.schema,
          backfill: entry.backfill,
        }));
        await this.materializeRows(outboxRows, events, seenRows, result, outboxRows.length);
        if (batch.next.pageSeq !== cursor.pageSeq || batch.next.rowOffset !== cursor.rowOffset) {
          state[ANALYTICS_OUTBOX_CURSOR] = JSON.stringify(batch.next);
        }
        remaining -= outboxRows.length;
        if (batch.pending) result.pending += 1;
      }
      unread = await this.materializeRows(pending.rows, events, seenRows, result, remaining);
      result.pending += unread.length;
      this.sweepIndexed(events, state, result);

      if (
        events.length > 0 ||
        Object.keys(state).length > 0 ||
        seenRows.length > 0 ||
        seenDocuments.length > 0
      ) {
        this.deps.store.commit({ events, state, seenRows, seenDocuments });
      }
    } catch (err) {
      // Nothing was committed, so nothing was consumed. Put the whole snapshot
      // back rather than reporting a drain that lost its input.
      this.deps.queue.returnDocuments(pending.documents);
      this.deps.queue.returnRows(pending.rows);
      throw err;
    }
    this.recovering = !sweptToTheEnd;
    this.deps.queue.returnDocuments(heldBack);
    this.deps.queue.returnRows(unread);

    result.idle =
      result.documents === 0 &&
      result.rows === 0 &&
      result.indexed === 0 &&
      result.pending === 0 &&
      result.recovered === 0 &&
      result.deferred === 0;
    return result;
  }

  /**
   * Documents the journal is missing — because the gateway was down, because
   * the bus fired before this subscribed, or because the queue overflowed.
   *
   * The checkpoint is `(updated_at, id)` rather than `updated_at` alone: a
   * batch write stamps the same millisecond on many rows, and a cursor that
   * moved strictly past a timestamp would step over every row tied at the
   * boundary. Recovered events say `updated` and carry no `changedFields`,
   * because the before-image is gone — what changed is genuinely unknown, and
   * a guess would be worse than an empty list.
   *
   * One page per call, returning whether it is caught up, so a gateway down for
   * a week does not materialize the whole outage in one tick.
   */
  private recover(
    events: NewJournalEvent[],
    state: Record<string, string>,
    result: DrainResult,
  ): boolean {
    const checkpoint = decodeCheckpoint(this.deps.store.getState(DOCUMENT_CHECKPOINT));
    // A journal that has never run starts from now rather than from the whole
    // corpus: replaying every document ever indexed as an `updated` event is
    // not recovery, it is a synthetic storm on first boot.
    if (checkpoint === null) {
      const newest = this.deps.db
        .prepare<
          [],
          { updated_at: string; id: string }
        >("SELECT updated_at, id FROM documents ORDER BY updated_at DESC, id DESC LIMIT 1")
        .get();
      state[DOCUMENT_CHECKPOINT] = encodeCheckpoint({
        at: newest?.updated_at ?? "",
        id: newest?.id ?? "",
      });
      return true;
    }

    const rows = this.deps.db
      .prepare<[string, string, string, number], DocumentRow>(
        `SELECT id, source_id, provider_id, title, content_hash, metadata, source_created_at, updated_at,
                people_resolved_at
           FROM documents
          WHERE updated_at > ? OR (updated_at = ? AND id > ?)
          ORDER BY updated_at ASC, id ASC
          LIMIT ?`,
      )
      .all(checkpoint.at, checkpoint.at, checkpoint.id, SWEEP_PAGE);
    if (rows.length === 0) return true;

    let cursor = checkpoint;
    for (const row of rows) {
      const settled = row.people_resolved_at !== null;
      events.push(
        this.docEvent(
          row,
          "updated",
          [],
          false,
          settled ? this.peopleOf(row.id) : [],
          settled ? undefined : true,
        ),
      );
      if (!settled) result.degraded += 1;
      result.recovered += 1;
      cursor = { at: row.updated_at, id: row.id };
    }
    state[DOCUMENT_CHECKPOINT] = encodeCheckpoint(cursor);
    log.info(`recovered ${rows.length} document(s) the journal was missing`);
    return rows.length < SWEEP_PAGE;
  }

  /**
   * Turn queued upserts into journal events, holding back the ones whose people
   * have not settled and whose deadline has not run out.
   *
   * Returns what the caller should put back: everything deferred, plus whatever
   * the batch cap left unexamined.
   */
  private materializeDocuments(
    queued: readonly QueuedDocument[],
    events: NewJournalEvent[],
    state: Record<string, string>,
    result: DrainResult,
    seenDocuments: { docId: string; eventHash: string }[],
  ): QueuedDocument[] {
    const heldBack: QueuedDocument[] = [];
    // What the last journalled event about each queued document looked like.
    // Read once for the batch rather than per entry, like the analytics path.
    const examinedQueue = queued.slice(0, this.batchSize);
    const lastSeen = this.deps.store.seenDocuments([
      ...new Set(examinedQueue.map((q) => q.document.id)),
    ]);
    const deadline = this.now() - this.settlementMs;
    let newestJournaled: Checkpoint | null = null;
    let examined = 0;

    for (const entry of queued) {
      // Bounded on entries rather than on events: a deferred entry produces no
      // event but still costs a read, so a queue full of unsettled documents
      // would be walked in full on every tick.
      if (examined >= this.batchSize) {
        heldBack.push(entry);
        continue;
      }
      examined += 1;

      const projection = entry.document;
      const row = this.deps.db
        .prepare<
          [string],
          Pick<DocumentRow, "people_resolved_at" | "updated_at">
        >("SELECT people_resolved_at, updated_at FROM documents WHERE id = ?")
        .get(projection.id);
      // Gone between the commit and the drain: deleted, or a source removed.
      // Nothing to say about a document that no longer exists.
      if (!row) continue;

      const settled = row.people_resolved_at !== null;
      if (!settled && entry.at > deadline) {
        heldBack.push(entry);
        continue;
      }

      const people = settled
        ? this.peopleOf(projection.id)
        : projection.people.map((mention) => ({
            personId: null,
            role: mention.role,
            isSelf: false,
          }));
      if (!settled) result.degraded += 1;

      const event = this.docEvent(
        {
          id: projection.id,
          source_id: projection.sourceId,
          provider_id: projection.providerId,
          title: projection.title,
          content_hash: projection.contentHash,
          metadata: JSON.stringify(projection.metadata),
          source_created_at: projection.sourceCreatedAt,
        },
        entry.op,
        entry.changedFields,
        entry.contentChanged,
        people,
        settled ? undefined : true,
      );

      // The document mirror of the analytics dedup, and deliberately no more
      // than that: an event identical to the last one journalled about this
      // document — same op, same changed fields, same people, same semantic
      // time — is a redelivery, and the writer emits several per change often
      // enough to be worth dropping. Only exact repeats go; anything that
      // differs is a change this cannot judge the significance of, and
      // deciding an event is uninteresting is nomination's job, not the
      // journal's.
      const eventHash = stableEventHash(event.payload);
      const checkpointHere = { at: row.updated_at, id: projection.id };
      if (lastSeen.get(projection.id) === eventHash) {
        result.droppedRedeliveries += 1;
        // A dropped duplicate still counts toward the checkpoint: the document
        // is accounted for, it simply had nothing new to say. Leaving it out
        // would make a drain of only duplicates look like a drain that
        // journaled nothing, and hold the checkpoint back on a batch that was
        // in fact fully handled.
        if (newestJournaled === null || isAfter(checkpointHere, newestJournaled)) {
          newestJournaled = checkpointHere;
        }
        continue;
      }
      lastSeen.set(projection.id, eventHash);
      seenDocuments.push({ docId: projection.id, eventHash });

      events.push(event);
      result.documents += 1;
      if (newestJournaled === null || isAfter(checkpointHere, newestJournaled)) {
        newestJournaled = checkpointHere;
      }
    }

    this.advanceCheckpoint(newestJournaled, heldBack, state);
    return heldBack;
  }

  /**
   * Move the checkpoint to a point the recovery sweep can trust.
   *
   * Two things stop it. While the recovery sweep is mid-gap, its own cursor is
   * the only honest position and a live document must not overwrite it. And
   * even in the steady state it stops *before* the newest timestamp journaled,
   * because one write stamps a whole page and this drain may have seen only
   * part of it — the sweep re-emits that group after a crash rather than
   * stepping over the half that never arrived.
   */
  private advanceCheckpoint(
    newestJournaled: Checkpoint | null,
    heldBack: readonly QueuedDocument[],
    state: Record<string, string>,
  ): void {
    if (newestJournaled === null) return;
    if (this.recovering) return;
    // A deferred document is one the journal does not hold yet; a checkpoint
    // past it would tell the sweep to skip exactly what a crash would lose.
    if (heldBack.length > 0) return;

    const safe: Checkpoint = { at: newestJournaled.at, id: "" };
    const current =
      decodeCheckpoint(state[DOCUMENT_CHECKPOINT] ?? null) ??
      decodeCheckpoint(this.deps.store.getState(DOCUMENT_CHECKPOINT));
    if (current === null || isAfter(safe, current)) {
      state[DOCUMENT_CHECKPOINT] = encodeCheckpoint(safe);
    }
  }

  /**
   * Deduplicate the queued rows and journal what is left.
   *
   * A row nobody has seen is `inserted`. A row whose meaningful columns moved
   * is `updated`. A row that came round again unchanged produces nothing at
   * all, which is the whole point: the ingest signal fires per record per page,
   * so the third read of one activity is not a third activity.
   *
   * Returns whatever the batch cap left unread, for the caller to put back.
   */
  private async materializeRows(
    queued: readonly QueuedRow[],
    events: NewJournalEvent[],
    seenRows: { table: string; pkHash: string; rowHash: string }[],
    result: DrainResult,
    limit = this.batchSize,
  ): Promise<QueuedRow[]> {
    if (queued.length === 0) return [];

    // Capped like the document path, and for the same reason: each row costs
    // two hashes and a read, and the queue holds tens of thousands.
    const taking = queued.slice(0, limit);
    const unread = queued.slice(limit);

    const schemas = new Map<string, JournalTableSchema | null>();
    for (const table of new Set(taking.map((q) => q.table))) {
      const captured = taking.find((q) => q.table === table)?.schema;
      schemas.set(table, captured ?? (await this.deps.tableSchema(table)));
    }

    const keyed = taking.map((entry) => {
      const schema = schemas.get(entry.table) ?? null;
      // Before anything reads the row. The key, the dedup hash, the semantic
      // clock and the stored payload must all see the same spelling of a
      // timestamp, and the only way to guarantee that is to settle it once,
      // here, rather than at each of the four places that go on to use it.
      const row = canonicalizeDeclaredTemporals(entry.row, schema ?? undefined);
      const declared = schema ? primaryKeyOf(row, schema) : null;
      const pk = declared === null ? null : withStreamKey(declared, row);
      return { entry, row, schema, pk, pkHash: pk ? hashKey(pk) : null };
    });
    const seen = this.deps.store.seenRows(
      keyed
        .filter((k): k is typeof k & { pkHash: string } => k.pkHash !== null)
        .map((k) => ({ table: k.entry.table, pkHash: k.pkHash })),
    );

    // Counted per table and reported once, rather than one line per row: a
    // table whose catalog entry is missing produces every row of every page,
    // and a bootstrap would write thousands of identical lines.
    const unkeyed = new Map<string, number>();

    for (const { entry, row, schema, pk, pkHash } of keyed) {
      if (!schema || !pk || pkHash === null) {
        // A table with no catalog entry, or a row missing part of its key.
        // Journaling it would mean a row that can never be deduplicated, so
        // every later redelivery of it would read as news.
        unkeyed.set(entry.table, (unkeyed.get(entry.table) ?? 0) + 1);
        continue;
      }
      const rowHash = stableRowHash(row, schema);
      const lookup = seenKey(entry.table, pkHash);
      const previous = seen.get(lookup);
      if (previous === rowHash) {
        result.droppedRedeliveries += 1;
        continue;
      }
      seen.set(lookup, rowHash);
      seenRows.push({ table: entry.table, pkHash, rowHash });

      const declaredTime = semanticTimeOf(row, schema);
      const semanticTime =
        (declaredTime === null ? null : toJournalInstant(declaredTime)) ??
        new Date(entry.at).toISOString();
      events.push({
        kind: "analytics.row",
        occurredAt: semanticTime,
        observedAt: new Date(entry.at).toISOString(),
        payload: {
          op: previous === undefined ? "inserted" : "updated",
          table: entry.table,
          sourceId: entry.sourceId,
          pk,
          row,
          ...(entry.backfill ? { backfill: true } : {}),
        },
      });
      result.rows += 1;
    }

    for (const [table, count] of unkeyed) {
      log.warn(`${count} row(s) on ${table} have no usable primary key — not journaled`);
    }
    return unread;
  }

  /**
   * The semantic clock: a keyset sweep over `indexed_documents`, the pattern
   * the shipped semantic evaluator already proved.
   *
   * A sweep rather than an event because embeddings land after the document
   * does — there is no moment on the ingest path at which "this document is
   * searchable" is true, so nothing can emit it.
   *
   * Like the document checkpoint, a journal that has never run starts at the
   * newest indexed row rather than at the beginning. Replaying an existing
   * corpus's whole index would be hundreds of thousands of events describing
   * nothing that just happened.
   */
  private sweepIndexed(
    events: NewJournalEvent[],
    state: Record<string, string>,
    result: DrainResult,
  ): void {
    const indexDb = this.deps.indexDb;
    if (indexDb === null) return;

    const stored = decodeCheckpoint(this.deps.store.getState(INDEXED_CURSOR));
    if (stored === null) {
      const newest = indexDb
        .prepare<[], { indexed_at: string; document_id: string }>(
          `SELECT event_indexed_at AS indexed_at, document_id FROM indexed_documents
            ORDER BY event_indexed_at DESC, document_id DESC LIMIT 1`,
        )
        .get();
      state[INDEXED_CURSOR] = encodeCheckpoint({
        at: newest?.indexed_at ?? "",
        id: newest?.document_id ?? "",
      });
      return;
    }

    const rows = indexDb
      .prepare<[string, string, string, number], { document_id: string; indexed_at: string }>(
        `SELECT document_id, event_indexed_at AS indexed_at
           FROM indexed_documents
          WHERE event_indexed_at > ? OR (event_indexed_at = ? AND document_id > ?)
          ORDER BY event_indexed_at ASC, document_id ASC
          LIMIT ?`,
      )
      .all(stored.at, stored.at, stored.id, SWEEP_PAGE);
    if (rows.length === 0) return;

    let last = stored;
    for (const row of rows) {
      const indexedAt = toJournalInstant(row.indexed_at) ?? new Date(this.now()).toISOString();
      events.push({
        kind: "doc.indexed",
        occurredAt: indexedAt,
        observedAt: indexedAt,
        payload: { docId: row.document_id, eventIndexedAt: indexedAt },
      });
      result.indexed += 1;
      last = { at: row.indexed_at, id: row.document_id };
    }
    state[INDEXED_CURSOR] = encodeCheckpoint(last);
  }

  /** The canonical people on a document, following the merge chain in SQL. */
  private peopleOf(docId: string): {
    personId: string | null;
    role: string;
    isSelf: boolean;
  }[] {
    return this.deps.db
      .prepare<[string], { person_id: string; role: string; is_self: number }>(
        `SELECT COALESCE(p.merged_into, p.id) AS person_id, dp.role,
                COALESCE(canon.is_self, p.is_self) AS is_self
           FROM document_people dp
           JOIN people p ON p.id = dp.person_id
           LEFT JOIN people canon ON canon.id = p.merged_into
          WHERE dp.document_id = ?
          ORDER BY dp.role, person_id`,
      )
      .all(docId)
      .map((row) => ({
        personId: row.person_id,
        role: row.role,
        isSelf: row.is_self === 1,
      }));
  }

  /**
   * Build the journal's document event, projecting metadata down to what the
   * source declared.
   *
   * A journal that shipped whatever the source happened to write would let a
   * watch depend on a field nobody promised — and the drift discipline that
   * pauses a watch when its ontology moves would have nothing to check
   * against, because the field was never in the ontology.
   */
  private docEvent(
    row: Pick<
      DocumentRow,
      | "id"
      | "source_id"
      | "provider_id"
      | "title"
      | "content_hash"
      | "metadata"
      | "source_created_at"
    >,
    op: "created" | "updated",
    changedFields: readonly string[],
    contentChanged: boolean,
    people: { personId: string | null; role: string; isSelf: boolean }[],
    degraded?: true,
  ): NewJournalEvent {
    const metadata = parseMetadata(row.metadata);
    const profile = this.deps.documentProfile(sourceTypeOf(row.source_id));
    const documentType = metadata["documentType"];

    // The document's own timestamp, in the journal's canonical spelling. A
    // source is free to have stored a perfectly valid instant in some other
    // form, and one that reached here verbatim made every event that source
    // produced unreadable to the consumer. Falling back to arrival time when it
    // cannot be normalized matches what an analytics row does with a missing
    // one: an event with an approximate semantic time is worth incomparably
    // more than an event nothing can read.
    const observedAt = new Date(this.now()).toISOString();
    const semanticTime = toJournalInstant(row.source_created_at) ?? observedAt;

    return {
      kind: "doc.event",
      occurredAt: semanticTime,
      observedAt,
      payload: {
        op,
        docId: row.id,
        sourceId: row.source_id,
        providerId: row.provider_id,
        documentType: typeof documentType === "string" && documentType ? documentType : null,
        title: row.title,
        contentHash: row.content_hash,
        semanticTime,
        changedFields: [...changedFields],
        contentChanged,
        metadata: declaredMetadata(metadata, profile),
        people,
        ...(degraded ? { degraded: true } : {}),
      },
    };
  }
}

function decodeOutboxCursor(value: string | null): WatchOutboxCursor {
  if (value === null) return { pageSeq: 0, rowOffset: 0 };
  try {
    const parsed = JSON.parse(value) as Partial<WatchOutboxCursor>;
    if (
      typeof parsed.pageSeq === "number" &&
      Number.isSafeInteger(parsed.pageSeq) &&
      parsed.pageSeq >= 0 &&
      typeof parsed.rowOffset === "number" &&
      Number.isSafeInteger(parsed.rowOffset) &&
      parsed.rowOffset >= 0
    ) {
      return { pageSeq: parsed.pageSeq, rowOffset: parsed.rowOffset };
    }
  } catch {
    // A corrupt cursor replays retained pages; analytics_seen removes repeats.
  }
  return { pageSeq: 0, rowOffset: 0 };
}

/**
 * When the row says it happened, per its own declared semantic-time column.
 *
 * `null` whenever the row cannot supply one, and the caller treats every such
 * case the same — it falls back to arrival time, because that is the only
 * instant anyone knows. That covers a table the source declared **timeless**, a
 * declared column that is **empty on this row** (which some sources use to mean
 * the row is not timeline-eligible), and a value that is **not a readable
 * instant** at all.
 *
 * A journal consumer therefore cannot tell "this happened now" from "nobody
 * knows when this happened". Windowed operators are unaffected — they clamp
 * semantic time against the replay clock either way — but a watch keyed on a
 * timeless table's `occurredAt` is keying on arrival, and should be read that
 * way.
 */
function semanticTimeOf(
  row: Readonly<Record<string, unknown>>,
  schema: JournalTableSchema,
): string | null {
  const column = schema.semanticTimeColumn;
  if (!column) return null;
  const value = row[column];
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

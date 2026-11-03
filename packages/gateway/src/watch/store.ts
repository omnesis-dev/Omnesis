// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * the journal — the Watch runtime's own store, beside the other gateway
 * databases and owned by neither the documents store nor the analytics one.
 *
 * Separate on purpose. The journal is a derived projection of the corpus
 * rather than a part of it: nothing else reads it and nothing it holds is a
 * source of truth. Recent document history can be swept again, while analytics
 * history is recoverable only while DuckDB's consumed outbox grace copy remains.
 * Put
 * it in the main store and every gateway migration would have to carry it, and
 * the append-only migration discipline would apply to a table whose shape is
 * still moving.
 *
 * Three tables, and each one is here because the raw substrate cannot answer a
 * question the runtime has to ask:
 *
 * - `watch_events` is the durable ordered feed. The in-process bus is
 *   at-most-once and in-memory, so a consumer that starts late or crashes
 *   loses events with no way to know it did.
 * - `materializer_state` holds the cursors — where the indexed sweep reached,
 *   how far the document checkpoint got. Written in the same transaction as
 *   the events they account for, so a crash between the two is not a state a
 *   reader can observe.
 * - `documents_seen` remembers what the last event about each document looked
 *   like, so an identical repeat is recognised rather than journalled twice.
 * - `analytics_seen` remembers what each row looked like last time, because
 *   the ingest signal re-fires for every row on every sync page and the row
 *   itself carries no way to tell a redelivery from a change. It is never
 *   pruned, deliberately: a source removed and added back replays its history,
 *   and the rows it replays are only silent because their hashes outlived the
 *   source. The cost is one small row per analytics row the install has ever
 *   seen, which is the same order as the analytics store itself.
 *
 * The file is encrypted with its own storage key when the install has live
 * storage encryption armed. It holds document titles, person ids and analytics
 * rows — corpus material, whatever else it is — and a derived store that sits
 * plaintext beside encrypted ones is a hole in the same wall.
 */

import { createLogger } from "@omnesis/core";
import { openEncryptedSqlite, type EncryptedSqliteDatabase } from "../sqlite-encryption.js";
import {
  decodeEvent,
  journalDocumentAt,
  type EventRow,
  type JournalDocumentAt,
} from "./journal-document.js";
import type { JournalEvent } from "@omnesis/watch/journal";

const log = createLogger("gateway").child("watch-v2:store");

/** An event on its way into the journal. `seq` is assigned by the store. */
export type NewJournalEvent = Omit<JournalEvent, "seq">;

/**
 * One string for a `(table, primary key)` pair.
 *
 * Exported because two spellings of the same key is a bug that shows up as a
 * dedup that never matches — every row read as news, silently.
 */
export function seenKey(table: string, pkHash: string): string {
  return `${table}\u0000${pkHash}`;
}

export class WatchJournalStore {
  /**
   * Sequences already reported as unreadable, so each is said once.
   *
   * Bounded by how many unreadable rows an install has, which is a defect
   * count rather than a corpus size — an install with enough of these to
   * matter has a much louder problem than the memory.
   */
  private readonly warnedUnreadable = new Set<number>();

  private constructor(private readonly db: EncryptedSqliteDatabase) {}

  static open(path: string, key: Buffer | null): WatchJournalStore {
    const db = openEncryptedSqlite(path, { key });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS watch_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS materializer_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- Finding a document by id is how a semantic match reaches the document
      -- an index event is about. Expression-indexed because the id lives in
      -- the payload, and without this every nomination is a table scan.
      --
      -- The json_valid guard is what stops an index from being able to refuse a
      -- write: SQLite evaluates the indexed expression on INSERT, so without it
      -- a payload that is not JSON — which the read path already treats as one
      -- skippable row — would fail the insert instead, and one corrupt event
      -- would stop the journal accepting any more.
      CREATE INDEX IF NOT EXISTS watch_events_doc
        ON watch_events (json_extract(payload, '$.docId'), seq)
        WHERE kind = 'doc.event' AND json_valid(payload);
      CREATE TABLE IF NOT EXISTS analytics_seen (
        table_name TEXT NOT NULL,
        pk_hash TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        PRIMARY KEY (table_name, pk_hash)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS documents_seen (
        doc_id TEXT PRIMARY KEY,
        event_hash TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    return new WatchJournalStore(db);
  }

  /**
   * Write a drain's worth of events, its cursor movements and its row-hash
   * updates as one transaction.
   *
   * All three together, not separately, because each pair has a crash between
   * them that loses or repeats work: a cursor ahead of its events skips them
   * forever, a row hash ahead of its event turns a real change into a
   * redelivery, and events ahead of either produce them twice on the way back
   * up.
   */
  commit(batch: {
    events: readonly NewJournalEvent[];
    state?: Readonly<Record<string, string>>;
    seenRows?: readonly { table: string; pkHash: string; rowHash: string }[];
    seenDocuments?: readonly { docId: string; eventHash: string }[];
  }): void {
    const insertEvent = this.db.prepare<[string, string, string, string]>(
      `INSERT INTO watch_events (kind, occurred_at, observed_at, payload) VALUES (?, ?, ?, ?)`,
    );
    const putState = this.db.prepare<[string, string]>(
      `INSERT INTO materializer_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const putSeen = this.db.prepare<[string, string, string]>(
      `INSERT INTO analytics_seen (table_name, pk_hash, row_hash) VALUES (?, ?, ?)
         ON CONFLICT(table_name, pk_hash) DO UPDATE SET row_hash = excluded.row_hash`,
    );
    const putSeenDoc = this.db.prepare<[string, string]>(
      `INSERT INTO documents_seen (doc_id, event_hash) VALUES (?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET event_hash = excluded.event_hash`,
    );

    this.db.transaction(() => {
      for (const event of batch.events) {
        insertEvent.run(
          event.kind,
          event.occurredAt,
          event.observedAt,
          JSON.stringify(event.payload),
        );
      }
      for (const [key, value] of Object.entries(batch.state ?? {})) putState.run(key, value);
      for (const row of batch.seenRows ?? []) putSeen.run(row.table, row.pkHash, row.rowHash);
      for (const doc of batch.seenDocuments ?? []) putSeenDoc.run(doc.docId, doc.eventHash);
    })();
  }

  /**
   * The highest sequence number written, or 0 on an empty journal.
   *
   * Where a watch added now begins. "Tell me when someone emails about X" is a
   * claim about what happens next, so a new watch starts here rather than at
   * the beginning — a watch that woke on the whole corpus would be answering a
   * question nobody asked.
   */
  head(): number {
    const row = this.db
      .prepare<[], { seq: number | null }>("SELECT MAX(seq) AS seq FROM watch_events")
      .get();
    return row?.seq ?? 0;
  }

  /**
   * The newest event's sequence and when the journal observed it.
   *
   * `observed_at` rather than `occurred_at`: the question is when this install
   * last saw anything, and a backfilled document carries an occurrence from
   * years ago that says nothing about whether ingest is running.
   */
  headAt(): { seq: number; observedAtMs: number | null } {
    const row = this.db
      .prepare<[], { seq: number | null; observed_at: string | null }>(
        "SELECT seq, observed_at FROM watch_events ORDER BY seq DESC LIMIT 1",
      )
      .get();
    if (!row?.seq) return { seq: 0, observedAtMs: null };
    const at = row.observed_at ? Date.parse(row.observed_at) : Number.NaN;
    return { seq: row.seq, observedAtMs: Number.isFinite(at) ? at : null };
  }

  /**
   * The first sequence observed at or after an instant, or `head + 1` when
   * nothing has been.
   *
   * Read on `observed_at`, the clock that only moves forward, never
   * `occurred_at`. Semantic time is the event's own claim about when it
   * happened and a backfill can carry one years out in either direction — a
   * window cut on it would pull a save-the-date dated next spring into "the
   * last ninety days" and leave out a message that really arrived this
   * morning. "What would this watch have done over the last ninety days" is a
   * question about what the install *saw*.
   *
   * Returned as an exclusive `afterSeq`, matching {@link read}: one before the
   * first event in the window, so `read(afterSeq, n)` starts on it.
   */
  firstSeqAtOrAfter(observedAtIso: string): number {
    const row = this.db
      .prepare<[string], { seq: number | null }>(
        "SELECT MIN(seq) AS seq FROM watch_events WHERE observed_at >= ?",
      )
      .get(observedAtIso);
    return row?.seq ? row.seq - 1 : this.head();
  }

  /** How many events the journal holds. */
  count(): number {
    return (
      this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM watch_events").get()?.n ?? 0
    );
  }

  /**
   * Events after `afterSeq`, oldest first.
   *
   * A row the current build cannot parse is dropped with a warning rather than
   * thrown on: one unreadable event written by a build whose payload shape has
   * since moved must not stop the consumer reaching every event after it.
   */
  read(afterSeq: number, limit: number): JournalEvent[] {
    const rows = this.db
      .prepare<[number, number], EventRow>(
        `SELECT seq, kind, occurred_at, observed_at, payload FROM watch_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(afterSeq, limit);

    const events: JournalEvent[] = [];
    for (const row of rows) {
      const decoded = decodeEvent(row);
      if ("event" in decoded) {
        events.push(decoded.event);
        continue;
      }
      // Once per event per process. An unreadable row at the head of the
      // journal is re-read on every tick — nothing advances past it until a
      // readable event lands behind it — so warning per read turned one bad row
      // into hundreds of identical lines a night.
      if (!this.warnedUnreadable.has(row.seq)) {
        this.warnedUnreadable.add(row.seq);
        log.warn(
          `journal event seq=${row.seq} (${row.kind}) is unreadable and was skipped: ${decoded.why}`,
        );
      }
    }
    return events;
  }

  /**
   * The most recent `doc.event` for a document at or before `atSeq`, read on
   * this connection. See {@link journalDocumentAt}.
   */
  documentAt(docId: string, atSeq: number): JournalDocumentAt | null {
    return journalDocumentAt(this.db, docId, atSeq);
  }

  getState(key: string): string | null {
    return (
      this.db
        .prepare<[string], { value: string }>("SELECT value FROM materializer_state WHERE key = ?")
        .get(key)?.value ?? null
    );
  }

  /**
   * The stored event hash for each of these documents, keyed by document id.
   *
   * The document mirror of {@link seenRows}: what the last journalled event
   * about this document looked like, so a byte-identical repeat can be
   * recognised rather than journalled again.
   */
  seenDocuments(docIds: readonly string[]): Map<string, string> {
    const found = new Map<string, string>();
    for (let offset = 0; offset < docIds.length; offset += 5_000) {
      const chunk = docIds.slice(offset, offset + 5_000);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare<unknown[], { doc_id: string; event_hash: string }>(
          `SELECT doc_id, event_hash FROM documents_seen WHERE doc_id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of rows) found.set(row.doc_id, row.event_hash);
    }
    return found;
  }

  /** The stored stable-column hash for each of these rows, keyed by {@link seenKey}. */
  seenRows(keys: readonly { table: string; pkHash: string }[]): Map<string, string> {
    const found = new Map<string, string>();
    for (let offset = 0; offset < keys.length; offset += 5_000) {
      const chunk = keys.slice(offset, offset + 5_000);
      const values = chunk.map(() => "(?, ?)").join(", ");
      const params = chunk.flatMap((key) => [key.table, key.pkHash]);
      const rows = this.db
        .prepare<unknown[], { table_name: string; pk_hash: string; row_hash: string }>(
          `WITH wanted(table_name, pk_hash) AS (VALUES ${values})
           SELECT seen.table_name, seen.pk_hash, seen.row_hash
             FROM analytics_seen seen
             JOIN wanted USING (table_name, pk_hash)`,
        )
        .all(...params);
      for (const row of rows) found.set(seenKey(row.table_name, row.pk_hash), row.row_hash);
    }
    return found;
  }

  close(): void {
    this.db.close();
  }
}

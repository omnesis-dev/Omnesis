// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the bus handlers are allowed to do: append to an array.
 *
 * The gateway's event bus runs its handlers *synchronously on the main thread*
 * immediately after the writer commits. Anything a handler does is time the
 * gateway is not serving requests, so a handler that read a person, hashed a
 * row or opened a transaction would put the materializer's whole cost on the
 * ingest path — and during a bootstrap that path runs thousands of times a
 * minute.
 *
 * So the handler captures the fields the drain will need and the two things
 * that are only knowable at that instant — when the event arrived, and whether
 * the source was replaying history — and returns. Everything that needs a
 * read, a hash or a write happens later, in the drain task, where the batch is
 * capped in both directions.
 *
 * **Only document events use this live queue.** Analytics ingest is captured
 * transactionally in DuckDB and read from its durable outbox by the drain. A
 * `DocumentUpsertedEvent` carries the
 * document's full body, and the drain never reads it. Holding the event
 * whole would pin every queued document's text in memory for a drain interval
 * — or for the full people-settlement window, for a deferred one — where
 * ingest would otherwise drop it immediately. At a bootstrap's queue depth
 * that is hundreds of megabytes of strings nothing will ever look at.
 *
 * The queue is capacity-bounded, and that is a deliberate choice between two
 * bad outcomes rather than an oversight. Unbounded, a source pushing faster
 * than the drain empties grows the array until the process dies — and killing
 * the gateway is a far worse failure than missing a shadow-mode event.
 *
 * **Document overflow is a real loss.** The materializer's recovery
 * sweep runs at startup, against a gap the checkpoint describes; once it has
 * caught up the checkpoint follows the live path, so a document dropped here
 * ends up behind it and is never swept. So the drop is counted and the drain says so out loud — a silent loss
 * would read as a quiet corpus, which is the one thing an operator watching a
 * shadow deployment cannot tell apart from a working one.
 *
 * Overflow is also the loudest possible signal that the drain is behind, and it
 * cannot happen quietly: a queue at capacity is by definition deeper than one
 * drain's batch, so the materializer is holding work back and its checkpoint is
 * frozen. The config schema keeps `batchSize` at or below `queueCapacity` for
 * exactly that reason.
 */

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { DocumentProjection, DocumentUpsertedEvent } from "../events.js";

/** A document upsert, reduced to what the drain reads. */
export interface QueuedDocument {
  /** Wall clock at capture — what the people-settlement deadline counts from. */
  readonly at: number;
  /** The post-write projection. Carries no body. */
  readonly document: DocumentProjection;
  /** Insert or update, derived from whether the bus carried a `before`. */
  readonly op: "created" | "updated";
  readonly changedFields: readonly string[];
  readonly contentChanged: boolean;
}

/** An analytics row handed to the drain by its durable outbox (or a unit fixture). */
export interface QueuedRow {
  readonly at: number;
  readonly table: string;
  readonly sourceId: string;
  readonly row: Record<string, unknown>;
  /** Durable outbox pages carry the declaration used when the row committed. */
  readonly schema?: Pick<AnalyticsTableSchema, "columns" | "primaryKey" | "semanticTimeColumn">;
  /**
   * Whether the source was replaying history when this arrived.
   *
   * Captured here rather than at drain time because it is a fact about the
   * moment: by the time the queue drains, the bootstrap that produced the row
   * may have finished, and the row would then be read as live.
   */
  readonly backfill: boolean;
}

export interface QueueSnapshot {
  readonly documents: QueuedDocument[];
  readonly rows: QueuedRow[];
}

/** Default document-event ceiling. Roughly a minute of a fast bootstrap. */
export const DEFAULT_QUEUE_CAPACITY = 50_000;

/** Reduce a bus event to the fields the drain reads, dropping the bodies. */
export function capture(event: DocumentUpsertedEvent, at: number): QueuedDocument {
  return {
    at,
    document: event.after,
    op: event.before === null ? "created" : "updated",
    changedFields: event.changedFields,
    contentChanged: event.contentChanged,
  };
}

export class MaterializerQueue {
  private documents: QueuedDocument[] = [];
  private rows: QueuedRow[] = [];
  private droppedDocuments = 0;
  private droppedRows = 0;

  constructor(private readonly capacity: number = DEFAULT_QUEUE_CAPACITY) {}

  pushDocument(entry: QueuedDocument): void {
    if (this.documents.length >= this.capacity) {
      this.droppedDocuments += 1;
      return;
    }
    this.documents.push(entry);
  }

  pushRow(entry: QueuedRow): void {
    if (this.rows.length >= this.capacity) {
      this.droppedRows += 1;
      return;
    }
    this.rows.push(entry);
  }

  get depth(): number {
    return this.documents.length + this.rows.length;
  }

  /** How much was thrown away because the drain fell behind. Never resets. */
  get dropped(): { documents: number; rows: number } {
    return { documents: this.droppedDocuments, rows: this.droppedRows };
  }

  /**
   * Hand the drain everything queued and start fresh.
   *
   * Swapped rather than spliced so a handler firing during the drain lands in
   * the new array and is picked up next tick, instead of mutating the one
   * being walked.
   */
  take(): QueueSnapshot {
    const snapshot = { documents: this.documents, rows: this.rows };
    this.documents = [];
    this.rows = [];
    return snapshot;
  }

  /**
   * Put back what a drain did not finish with — documents still waiting for
   * their people to settle, whatever a batch cap left over, and everything in
   * a batch that failed before it committed.
   *
   * Returned entries go to the front, because they are older than anything
   * that arrived while the drain ran, and a deferred one has a deadline already
   * running. They are admitted past the ordinary capacity check, because these
   * are events the queue already accepted and refusing them would lose exactly
   * the work a transient failure was about to retry.
   *
   * "Past the check" is not "unbounded", though. A drain that keeps failing
   * returns its batch every tick while new events keep arriving, so the ceiling
   * has to be raised rather than removed: twice capacity, after which a return
   * is dropped and counted like any other overflow.
   */
  returnDocuments(entries: readonly QueuedDocument[]): void {
    this.documents = this.admitReturned(entries, this.documents, (n) => {
      this.droppedDocuments += n;
    });
  }

  returnRows(entries: readonly QueuedRow[]): void {
    this.rows = this.admitReturned(entries, this.rows, (n) => {
      this.droppedRows += n;
    });
  }

  private admitReturned<T>(entries: readonly T[], current: T[], drop: (n: number) => void): T[] {
    if (entries.length === 0) return current;
    const room = Math.max(0, this.capacity * 2 - current.length);
    if (entries.length <= room) return [...entries, ...current];
    // Keep the oldest, which are the ones with a deadline running.
    drop(entries.length - room);
    return [...entries.slice(0, room), ...current];
  }
}

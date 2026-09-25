// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed in-process event bus for the gateway main thread.
 *
 * Generalization of the legacy `indexerControl.wake()` callback. The watch
 * journal subscribes here, turning each committed write into the events its
 * runtime evaluates.
 *
 * Contract:
 *   - Emit happens on the main thread, AFTER the WriteGate call
 *     resolves (i.e. the writer-worker round-trip is complete and the
 *     SQLite commit landed). Subscribers therefore see "this row is
 *     persisted" semantics, not "this row is queued for write".
 *   - Handlers run synchronously inside `emit()`. They MUST be cheap:
 *     enqueue any heavier work onto the Scheduler / setImmediate.
 *   - Handlers can throw; the bus catches and logs, never letting one
 *     bad subscriber poison another.
 *
 * Why main-thread (not writer-thread): the writer worker doesn't have
 * access to the Scheduler or to the Hono app — those are main-thread
 * only. Emitting after the round-trip means we never block the writer
 * on subscriber work.
 */

import { createLogger, type Logger } from "@omnesis/core";

const log: Logger = createLogger("gateway:events");

// ── Event payload types ────────────────────────────────────────────────

// `DocumentProjection`, `extractPeopleFromMetadata`, and
// `computeChangedFields` live in `data/document-projection.ts` so the
// data layer can use them without an upward import into the event
// module. Re-exported here for callers (EventService, the projection
// tests) that already address them via this module.
export type { DocumentProjection } from "./data/document-projection.js";
export { extractPeopleFromMetadata, computeChangedFields } from "./data/document-projection.js";

import type { DocumentProjection } from "./data/document-projection.js";

/**
 * A document was just inserted or updated in `documents`. `before` is
 * null for inserts, populated from the pre-write projection for
 * updates. `changedFields` lists projection-level fields that differ
 * between before and after — empty for inserts (everything is "new"
 * by convention; subscribers that want a "first-seen" hook check
 * `before === null`).
 *
 * `contentChanged` is set when `before.contentHash !== after.contentHash`
 * (or when `before === null`). It's a separate flag because the body
 * itself isn't carried on the bus — subscribers that want to react to
 * body churn need this signal to decide whether to re-read.
 */
export interface DocumentUpsertedEvent {
  before: DocumentProjection | null;
  after: DocumentProjection;
  /**
   * Post-write content body. Carried alongside the projection rather
   * than inside it because: (a) we don't want to bloat `before` with
   * a full body snapshot fetched from disk just so transition
   * predicates can deep-compare; (b) the projection's own deep-equal
   * checks would be O(content length) on every upsert; (c) most
   * subscribers don't need the body at all and shouldn't pay for it.
   * A subscriber that has to read the body itself takes it from here;
   * one that only needs to know the body moved reads `contentChanged`
   * and the before/after hashes off the projections.
   */
  afterContent: string;
  /**
   * Pre-write content body. Present ONLY on content-changed updates,
   * and only while at least one prior-content subscriber is registered
   * (`registerPriorContentInterest`) — fetching the old body is an
   * extra pre-write read the hot path must not pay when nobody wants
   * it. The
   * consumer computes its previous-vs-new diff at event time and
   * discards this; prior versions are never persisted.
   */
  beforeContent?: string;
  /**
   * Names of projection fields that differ between `before` and `after`.
   * Possible values: "title", "contentHash", "metadata",
   * "sourceCreatedAt", "sourceUpdatedAt", "documentType", "people",
   * "metadata.tags". Empty on insert. The list isn't deeply structural
   * — `metadata` means "the metadata blob differs by JSON value", and
   * `metadata.tags` is broken out specifically because tag mutations
   * are the most common transition we want to act on.
   */
  changedFields: ReadonlyArray<string>;
  /** True on insert OR when the content body's hash differs. */
  contentChanged: boolean;
}

/** A document was deleted from `documents`. */
export interface DocumentDeletedEvent {
  id: string;
  providerId: string;
  sourceId: string;
  externalId: string;
}

/** An analytics row was just inserted into `<table>`. */
export interface AnalyticsRowInsertedEvent {
  table: string;
  /** Source attribution — usually `<sourceType>:<account>` or just `<sourceType>`. */
  sourceId: string;
  /** Raw row column → value, as returned by the analytics ingest. */
  row: Record<string, unknown>;
}

export type EventMap = {
  "document.upserted": DocumentUpsertedEvent;
  "document.deleted": DocumentDeletedEvent;
  "analytics_row.inserted": AnalyticsRowInsertedEvent;
};

export type EventName = keyof EventMap;

type Handler<E extends EventName> = (payload: EventMap[E]) => void;

export class EventBus {
  private handlers: { [E in EventName]?: Set<Handler<E>> } = {};

  on<E extends EventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers[event] as Set<Handler<E>> | undefined;
    if (!set) {
      set = new Set();
      // The cast keeps TS happy — same Handler<E> goes in and out.
      (this.handlers[event] as Set<Handler<E>>) = set;
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const set = this.handlers[event] as Set<Handler<E>> | undefined;
    if (!set || set.size === 0) return;
    // Snapshot the handler set before iterating so handlers added by
    // other handlers during this emit don't fire on the in-flight
    // event. This keeps emit() semantics predictable for callers that
    // mutate subscriptions inside their own handlers (re-entrant
    // subscribe/unsubscribe is a real pattern).
    const handlers = [...set];
    for (const h of handlers) {
      try {
        h(payload);
      } catch (err) {
        log.warn(
          `event bus handler for ${event} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Test/teardown helper — drops all handlers. */
  clear(): void {
    this.handlers = {};
  }
}

/**
 * Default singleton — the gateway only ever has one main thread, and
 * passing the bus around constructors gets noisy. Tests can `clear()`
 * between cases or instantiate their own EventBus and inject it.
 */
export const eventBus = new EventBus();

// ── Prior-content interest ─────────────────────────────────────────────
//
// `DocumentUpsertedEvent.beforeContent` requires an extra pre-write read
// of the old body, so the ingest path only pays for it while a consumer
// has declared interest (today: the Briefs waker's document-diff engine,
// registered only when that feature is active). The registry lives in
// `data/document-prior-content.ts` beside the fetch it gates (the data
// layer must not import upward into this module); re-exported here for
// subscribers, like the projection helpers above.
export {
  registerPriorContentInterest,
  priorContentRequested,
} from "./data/document-prior-content.js";

// Projection helpers (`extractPeopleFromMetadata`, `computeChangedFields`)
// live in `./data/document-projection.ts` — see the re-export at the
// top of this file.

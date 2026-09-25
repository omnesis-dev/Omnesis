// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Briefs waker's event-bus half — the near-dup inbox pattern
 * (`near-dupes/event-handler.ts` + its flush task): the
 * `document.upserted` subscriber only records the wake in an in-memory
 * buffer, synchronously and write-free; `briefsWakerDrainTask` drains
 * the buffer in the background and enqueues the `data` runs.
 *
 * Why buffered: the event fires synchronously inside the originating
 * request's realtime priority scope, so a writer op dispatched from the
 * handler would inherit realtime and compete with the actual document
 * writes. The handler therefore does no writer work at all.
 *
 * The buffer folds per document (one entry per doc id, matching the
 * queue's one-pending-row-per-doc invariant): a second event before the
 * drain keeps the EARLIEST pre-update body and the LATEST post-update
 * body, so the eventual diff spans every buffered edit. `document.
 * deleted` evicts the doc's entry — no run is enqueued for a document
 * that vanished before the drain.
 *
 * Bounded: entries are capped, and buffered bodies (kept only to
 * compute update diffs) are capped by total bytes — over budget the
 * entry stays but drops its bodies, so the wake still happens, just
 * without a diff. Buffering is best-effort (near-dup precedent): an
 * ungraceful crash loses at most one drain interval of wakes; the daily
 * runs and decay sweeps are the recovery net.
 */

import { mergeChangedAddressedEntryIds } from "../addressed-entry-context.js";
import { decideWake, type WakeDecision, type WakerHeuristicsConfig } from "./eligibility.js";
import type { Logger } from "@omnesis/core";
import type { DocumentDeletedEvent, DocumentUpsertedEvent, EventBus } from "../../events.js";

/** One buffered wake — the drain task's unit of work. */
export interface BufferedWake {
  docId: string;
  event: "created" | "updated";
  /** Latest source timestamp seen for the datum (unix ms). */
  datumAt: number;
  /** Debounce from the latest event's decision. */
  debounceMs: number;
  /** Max-defer ceiling from the latest event's decision (per doc type). */
  maxDeferMs: number;
  /**
   * Source-scoped thread key when the datum is a thread-membership document
   * (an email in a thread); the drain folds on the thread key instead of the
   * per-document key so same-thread arrivals batch into one run. Undefined for
   * standalone documents.
   */
  threadKey?: string;
  /**
   * The wake must not be delayed downstream (see `WakeDecision.immediate`).
   * Sticky across a fold: once a datum has been addressed to the assistant,
   * a later ordinary edit to it must not re-impose a wait.
   */
  immediate?: boolean;
  /** Pre-update body from the EARLIEST buffered update (diff base). */
  beforeContent?: string;
  /** Post-update body from the LATEST buffered event (diff target). */
  afterContent?: string;
  /** Structured addressed-entry ids attributed across every buffered event. */
  changedAddressedEntryIds?: string[];
  addressedEntriesTruncated?: boolean;
}

/** Default entry cap — wakes past it are dropped (rate-limited warn). */
const DEFAULT_MAX_ENTRIES = 50_000;
/** Default total-bytes budget for buffered bodies (diff material only). */
const DEFAULT_MAX_CONTENT_BYTES = 48 * 1024 * 1024;

export interface BriefsWakerBufferOpts {
  maxEntries?: number;
  maxContentBytes?: number;
  log?: Logger;
}

export interface BriefsWakerBuffer {
  /** Record a positive wake decision. In-memory only; folds per doc id. */
  add(event: DocumentUpsertedEvent, decision: WakeDecision): void;
  /** Drop the entry for a deleted document. */
  evict(docId: string): void;
  /** Re-buffer an entry whose enqueue failed (retried next tick). */
  restore(entry: BufferedWake): void;
  /** Drain all pending wakes. Clears the buffer. */
  drain(): BufferedWake[];
  /** Pending entry count (tracker + tests). */
  size(): number;
}

export function createBriefsWakerBuffer(opts: BriefsWakerBufferOpts = {}): BriefsWakerBuffer {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxContentBytes = opts.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const log = opts.log;
  const pending = new Map<string, BufferedWake>();
  let contentBytes = 0;
  let droppedSinceWarn = 0;
  let lastDropWarnAt = Number.NEGATIVE_INFINITY;

  function entryBytes(e: BufferedWake): number {
    return (
      (e.beforeContent === undefined ? 0 : Buffer.byteLength(e.beforeContent, "utf8")) +
      (e.afterContent === undefined ? 0 : Buffer.byteLength(e.afterContent, "utf8"))
    );
  }

  /** Drop an entry's bodies when the byte budget is exhausted. */
  function shedContents(e: BufferedWake): void {
    contentBytes -= entryBytes(e);
    delete e.beforeContent;
    delete e.afterContent;
  }

  function trySetContents(e: BufferedWake, before: string | undefined, after: string | undefined) {
    const old = entryBytes(e);
    const next =
      (before === undefined ? 0 : Buffer.byteLength(before, "utf8")) +
      (after === undefined ? 0 : Buffer.byteLength(after, "utf8"));
    if (contentBytes - old + next > maxContentBytes) {
      // Over budget: keep the wake, lose the diff material.
      shedContents(e);
      return;
    }
    contentBytes = contentBytes - old + next;
    if (before === undefined) delete e.beforeContent;
    else e.beforeContent = before;
    if (after === undefined) delete e.afterContent;
    else e.afterContent = after;
  }

  function warnDropped(): void {
    droppedSinceWarn++;
    const now = Date.now();
    if (now - lastDropWarnAt > 10_000) {
      log?.warn(
        `briefs waker buffer at cap (${maxEntries} entries); dropped ${droppedSinceWarn} wake(s) since last warn — daily runs are the recovery net`,
      );
      lastDropWarnAt = now;
      droppedSinceWarn = 0;
    }
  }

  return {
    add(event, decision) {
      const existing = pending.get(decision.docId);
      if (!existing) {
        if (pending.size >= maxEntries) {
          warnDropped();
          return;
        }
        const entry: BufferedWake = {
          docId: decision.docId,
          event: decision.event,
          datumAt: decision.datumAt,
          debounceMs: decision.debounceMs,
          maxDeferMs: decision.maxDeferMs,
          ...(decision.threadKey !== undefined ? { threadKey: decision.threadKey } : {}),
          ...(decision.immediate === true ? { immediate: true } : {}),
          ...(decision.changedAddressedEntryIds !== undefined
            ? { changedAddressedEntryIds: decision.changedAddressedEntryIds }
            : {}),
          ...(decision.addressedEntriesTruncated === true
            ? { addressedEntriesTruncated: true }
            : {}),
        };
        pending.set(decision.docId, entry);
        if (decision.captureDiff) {
          trySetContents(entry, event.beforeContent, event.afterContent);
        }
        return;
      }
      // Fold. A doc that entered as `created` stays `created` — it is
      // still new to the agent and needs no diff; otherwise keep the
      // earliest diff base and adopt the latest body.
      existing.datumAt = decision.datumAt;
      existing.debounceMs = decision.debounceMs;
      existing.maxDeferMs = decision.maxDeferMs;
      if (decision.immediate === true) existing.immediate = true;
      const changed = mergeChangedAddressedEntryIds(
        existing.changedAddressedEntryIds,
        decision.changedAddressedEntryIds,
      );
      if (changed.ids.length > 0) existing.changedAddressedEntryIds = changed.ids;
      if (
        existing.addressedEntriesTruncated === true ||
        decision.addressedEntriesTruncated === true ||
        changed.truncated
      ) {
        existing.addressedEntriesTruncated = true;
      }
      if (existing.event === "created") return;
      const base = existing.beforeContent ?? event.beforeContent;
      trySetContents(existing, base, event.afterContent);
    },
    evict(docId) {
      const entry = pending.get(docId);
      if (!entry) return;
      contentBytes -= entryBytes(entry);
      pending.delete(docId);
    },
    restore(entry) {
      if (pending.has(entry.docId) || pending.size >= maxEntries) return;
      const bytes = entryBytes(entry);
      if (contentBytes + bytes > maxContentBytes) {
        delete entry.beforeContent;
        delete entry.afterContent;
      } else {
        contentBytes += bytes;
      }
      pending.set(entry.docId, entry);
    },
    drain() {
      const out = Array.from(pending.values());
      pending.clear();
      contentBytes = 0;
      return out;
    },
    size() {
      return pending.size;
    },
  };
}

/** Injectable clock (unix ms) — mirrors `storage/types.ts`. */
type Clock = () => number;

export interface BriefsWakerSubscriberOpts {
  eventBus: Pick<EventBus, "on">;
  buffer: Pick<BriefsWakerBuffer, "add" | "evict">;
  /** Re-read per event so config reloads pick up new debounce/recency. */
  getConfig: () => WakerHeuristicsConfig;
  clock: Clock;
}

/**
 * Wire the waker to the event bus. The handlers are hot-path-safe by
 * construction: a pure decision plus an in-memory buffer mutation — no
 * writer ops, no awaits. Returns the combined unsubscribe.
 */
export function subscribeBriefsWaker(opts: BriefsWakerSubscriberOpts): () => void {
  const offUpsert = opts.eventBus.on("document.upserted", (ev: DocumentUpsertedEvent) => {
    const decision = decideWake(ev, opts.getConfig(), opts.clock());
    if (decision === null) return;
    opts.buffer.add(ev, decision);
  });
  const offDelete = opts.eventBus.on("document.deleted", (ev: DocumentDeletedEvent) => {
    opts.buffer.evict(ev.id);
  });
  return () => {
    offUpsert();
    offDelete();
  };
}

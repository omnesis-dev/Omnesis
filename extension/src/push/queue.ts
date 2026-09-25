// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DurableStore, QueueItem } from "./types.js";

/** Storage key the queue persists its entire serialized state under. */
export const QUEUE_STORAGE_KEY = "omnesis.push.queue.v1";

/** Diagnostic written when a damaged queue snapshot has to be sanitized. */
export const QUEUE_CORRUPTION_KEY = "omnesis.push.queueCorruption.v1";
export const QUEUE_OVERFLOW_KEY = "omnesis.push.queueOverflow.v1";

const DEFAULT_MAX_ITEMS = 1_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface QueueLimits {
  maxItems: number;
  /** Conservative UTF-16 serialized-size ceiling. */
  maxBytes: number;
}

export interface QueueCorruption {
  at: number;
  /** Number of invalid entries removed, or null when the JSON itself was unreadable. */
  discarded: number | null;
}

export interface QueueOverflow {
  at: number;
  discardedDocuments: number;
  discardedVisits: number;
}

/**
 * A FIFO outbound queue whose entire state lives in a {@link DurableStore}.
 *
 * MV3 service workers are ephemeral — they are evicted within seconds of going
 * idle and the browser may restart at any time — so the queue can hold NO
 * authoritative state in memory. Every mutation is written straight back to
 * the store, and a fresh `PersistentQueue` constructed against the same store
 * after a restart sees the identical contents. That is the property the
 * "survives service-worker eviction / browser restart, no data loss" success
 * criterion turns on.
 *
 * The in-process `items` array is a cache of the last-loaded snapshot; callers
 * must `load()` after construction (and the client does so before each drain)
 * so a queue revived in a new SW generation re-reads from storage rather than
 * trusting stale memory.
 */
export class PersistentQueue {
  private items: QueueItem[] = [];
  private loaded = false;

  constructor(
    private readonly store: DurableStore,
    private readonly key: string = QUEUE_STORAGE_KEY,
    private readonly limits: QueueLimits = {
      maxItems: DEFAULT_MAX_ITEMS,
      maxBytes: DEFAULT_MAX_BYTES,
    },
  ) {}

  /** Re-read the durable snapshot into memory. Idempotent; cheap to repeat. */
  async load(): Promise<void> {
    const raw = await this.store.get(this.key);
    if (!raw) {
      this.items = [];
      this.loaded = true;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      await this.recoverCorruptSnapshot([], null);
      return;
    }

    if (!Array.isArray(parsed)) {
      await this.recoverCorruptSnapshot([], null);
      return;
    }

    const valid = parsed.filter(isQueueItem);
    if (valid.length !== parsed.length) {
      await this.recoverCorruptSnapshot(valid, parsed.length - valid.length);
      return;
    }
    this.items = valid;
    this.loaded = true;
    if (this.exceedsLimits()) await this.persist();
  }

  private async recoverCorruptSnapshot(
    items: QueueItem[],
    discarded: number | null,
  ): Promise<void> {
    this.items = items;
    this.loaded = true;
    await this.persist();
    await this.store.set(
      QUEUE_CORRUPTION_KEY,
      JSON.stringify({ at: Date.now(), discarded } satisfies QueueCorruption),
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async persist(): Promise<void> {
    let discardedDocuments = 0;
    let discardedVisits = 0;
    const sizes = this.items.map((item) => (JSON.stringify(item).length + 1) * 2);
    let totalBytes = 2 + sizes.reduce((sum, size) => sum + size, 0);
    let remainingItems = this.items.length;
    const discard = new Set<number>();
    // Preserve corpus documents as long as possible; visit analytics are the
    // first eviction tier when a prolonged outage reaches the local budget.
    for (const kind of ["visit", "document"] as const) {
      for (let index = 0; index < this.items.length; index += 1) {
        if (
          (remainingItems <= this.limits.maxItems && totalBytes <= this.limits.maxBytes) ||
          this.items[index].kind !== kind
        ) {
          continue;
        }
        discard.add(index);
        remainingItems -= 1;
        totalBytes -= sizes[index];
        if (kind === "document") discardedDocuments += 1;
        else discardedVisits += 1;
      }
    }
    if (discard.size > 0) this.items = this.items.filter((_, index) => !discard.has(index));
    await this.store.set(this.key, JSON.stringify(this.items));
    if (discardedDocuments > 0 || discardedVisits > 0) {
      let previous: QueueOverflow | null;
      try {
        const raw = await this.store.get(QUEUE_OVERFLOW_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        previous = isQueueOverflow(parsed) ? parsed : null;
      } catch {
        previous = null;
      }
      await this.store.set(
        QUEUE_OVERFLOW_KEY,
        JSON.stringify({
          at: Date.now(),
          discardedDocuments: (previous?.discardedDocuments ?? 0) + discardedDocuments,
          discardedVisits: (previous?.discardedVisits ?? 0) + discardedVisits,
        } satisfies QueueOverflow),
      );
    }
  }

  private exceedsLimits(): boolean {
    return (
      this.items.length > this.limits.maxItems ||
      JSON.stringify(this.items).length * 2 > this.limits.maxBytes
    );
  }

  /** Current queue depth (reads the durable snapshot). */
  async size(): Promise<number> {
    const raw = await this.store.get(this.key);
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isQueueItem).length : 0;
    } catch {
      return 0;
    }
  }

  /** Snapshot copy of the queued items, FIFO order. */
  async list(): Promise<QueueItem[]> {
    await this.ensureLoaded();
    return [...this.items];
  }

  /**
   * Append an item and flush to storage. De-duplicates on `item.id` so a
   * crash-during-drain that re-enqueues an in-flight item can't double it.
   */
  async enqueue(item: QueueItem): Promise<void> {
    await this.ensureLoaded();
    if (this.items.some((q) => q.id === item.id)) return;
    this.items.push(item);
    await this.persist();
  }

  /**
   * Append `item` while removing older queued snapshots it supersedes. This is
   * used for page documents: only the newest body for one external page needs
   * to survive a long outage, while visits remain distinct analytics events.
   */
  async enqueueReplacing(
    item: QueueItem,
    supersedes: (queued: QueueItem) => boolean,
  ): Promise<void> {
    await this.ensureLoaded();
    if (this.items.some((queued) => queued.id === item.id)) return;
    this.items = [...this.items.filter((queued) => !supersedes(queued)), item];
    await this.persist();
  }

  /**
   * Replace the queue with exactly `items` and flush. Used by the drain loop
   * to commit progress after each bounded delivery attempt.
   */
  async replaceAll(items: QueueItem[]): Promise<void> {
    this.items = [...items];
    this.loaded = true;
    await this.persist();
  }

  /** Drop every item (test helper / "clear queue" affordance). */
  async clear(): Promise<void> {
    this.items = [];
    this.loaded = true;
    await this.persist();
  }
}

function isQueueItem(value: unknown): value is QueueItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<QueueItem>;
  if (
    typeof item.id !== "string" ||
    typeof item.attempts !== "number" ||
    !Number.isFinite(item.attempts) ||
    typeof item.notBefore !== "number" ||
    !Number.isFinite(item.notBefore) ||
    typeof item.enqueuedAt !== "number" ||
    !Number.isFinite(item.enqueuedAt)
  ) {
    return false;
  }
  return (
    (item.kind === "document" && typeof item.doc === "object" && item.doc !== null) ||
    (item.kind === "visit" && typeof item.visit === "object" && item.visit !== null)
  );
}

function isQueueOverflow(value: unknown): value is QueueOverflow {
  if (typeof value !== "object" || value === null) return false;
  const overflow = value as Partial<QueueOverflow>;
  return (
    isFiniteNonNegativeInteger(overflow.at) &&
    isFiniteNonNegativeInteger(overflow.discardedDocuments) &&
    isFiniteNonNegativeInteger(overflow.discardedVisits)
  );
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

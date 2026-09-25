// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentInput } from "@omnesis/types";

/**
 * Environment-agnostic seams for the push pipeline.
 *
 * The push module is deliberately free of any `chrome.*` dependency: it takes
 * its HTTP transport and its durable storage as injected adapters. That is
 * what lets the spawned-gateway E2E (`browser-capture.e2e.test.ts`) import
 * and exercise the exact same push code under Node —
 * injecting Node's `fetch` and an in-memory store — while the extension's
 * service worker injects `fetch` + a `chrome.storage.local`-backed store.
 */

/** The subset of the Fetch API the push client relies on. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    redirect?: "error";
  },
) => Promise<FetchLikeResponse>;

/** The subset of a Fetch `Response` the push client reads. */
export interface FetchLikeResponse {
  readonly status: number;
  /** Case-insensitive header lookup, mirroring `Headers.get`. */
  readonly headers: { get(name: string): string | null };
  /** Native fetch bodies allow production adapters to enforce a streaming cap. */
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/**
 * A durable key→string store. The extension backs this with
 * `chrome.storage.local`; tests back it with an in-memory map. The queue
 * persists its entire serialized state under a single key, so the contract is
 * intentionally minimal (get/set of one JSON blob).
 */
export interface DurableStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/**
 * One pending outbound item. Two planes share one queue so ordering and
 * persistence are uniform:
 *   - `document` → `POST /documents` (content plane, `web-page` docs).
 *   - `visit`    → `POST /analytics/ingest` (analytics plane, `page_visits`).
 *
 * Each carries a client-minted `id` for de-dup within the queue (so a retry
 * loop never enqueues the same item twice) and an `attempts` counter the
 * backoff schedule reads.
 */
export type QueueItem = DocumentQueueItem | VisitQueueItem;

interface QueueItemBase {
  /** Stable per-item id for in-queue de-dup (NOT the document externalId). */
  id: string;
  /** Number of delivery attempts so far (drives exponential backoff). */
  attempts: number;
  /** Epoch-ms before which this item must not be retried (backoff gate). */
  notBefore: number;
  /** Epoch-ms the item was first enqueued (FIFO ordering + observability). */
  enqueuedAt: number;
}

export interface DocumentQueueItem extends QueueItemBase {
  kind: "document";
  doc: DocumentInput;
}

/**
 * A `page_visits` analytics row. Shape mirrors the `page_visits` schema in
 * `@omnesis/provider-web` (`primaryKey: [url, visited_at]`); the push
 * client posts it as a single-record `POST /analytics/ingest` batch.
 */
export interface PageVisit {
  url: string;
  domain: string;
  title: string | null;
  /** ISO-8601 — the semantic time of the visit (`semanticTimeColumn`). */
  visited_at: string;
  dwell_ms: number;
  /** Paired browser-device provenance hint; bearer auth remains authoritative. */
  browser_device_id?: string;
  /** User-entered Chrome profile name at capture time. */
  browser_profile_label?: string | null;
}

export interface VisitQueueItem extends QueueItemBase {
  kind: "visit";
  visit: PageVisit;
}

/** Tuning for the retry/backoff schedule. All durations in milliseconds. */
export interface BackoffConfig {
  /** Base delay for the first retry; doubles each attempt. */
  baseMs: number;
  /** Hard ceiling on a single backoff interval. */
  maxMs: number;
  /** Multiplicative growth factor per attempt (default 2 → exponential). */
  factor: number;
  /**
   * Cap on the retry exponent. Items remain durable after reaching the cap and
   * continue retrying at `maxMs`; a long outage must not discard captured data.
   */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 1000,
  maxMs: 5 * 60 * 1000,
  factor: 2,
  maxAttempts: 12,
};

/** Result of a single `drain()` pass. */
export interface DrainResult {
  /** Items delivered (and removed from the queue) this pass. */
  delivered: number;
  /** Items that failed and remain queued for a later pass. */
  retained: number;
  /** Permanently invalid items dropped after a non-retryable client error. */
  dropped: number;
  /**
   * Pages the gateway refused because the user deleted them for good. They
   * leave the queue without counting as synced; the capture policy names them,
   * so the worker refreshes its copy.
   */
  suppressed: number;
  /**
   * Epoch-ms the soonest backed-off item becomes eligible, or `null` if the
   * queue is empty / every remaining item is already eligible. The service
   * worker uses this to schedule the next `chrome.alarms` wake-up.
   */
  nextEligibleAt: number | null;
}

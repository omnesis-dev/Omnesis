// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-client tunables — the magic numbers that govern how the HTTP
 * client batches upserts and rides out gateway backpressure.
 *
 * Treat these as *defaults*, not hard limits. They're kept beside the
 * client that consumes them so the package stays self-contained (no
 * dependency on collector-only knobs).
 */

/**
 * Max number of consecutive 503-backpressure retries the HTTP gateway
 * client tolerates before giving up on a single upsert. With the
 * default backoff schedule the total wait is bounded at ~30s.
 */
export const DEFAULT_MAX_BACKPRESSURE_WAITS = 10;

/**
 * Maximum time without a gateway frame before a collector WebSocket is
 * considered stale. The gateway's default heartbeat is 30 seconds, so this
 * allows two missed heartbeats before forcing the normal reconnect loop.
 */
export const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * Maximum wall time for one optional OCR request. OCR enrichment must not hold
 * a source cursor behind a pathological attachment until an upstream proxy's
 * much longer request deadline expires.
 */
export const DEFAULT_OCR_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Pause new OCR requests after one reaches the client deadline. The gateway
 * does not yet propagate client disconnects to already-started OCR work, so
 * this rate-limits orphaned work from a page containing many bad attachments
 * while letting primary source documents continue to drain.
 */
export const DEFAULT_OCR_TIMEOUT_COOLDOWN_MS = 5 * 60_000;

/**
 * Document upsert chunk size. The gateway accepts arbitrarily large
 * batches but each batch holds a single SQLite transaction; chunking at
 * 50 keeps individual transaction wall-time under ~1s on typical
 * hardware so a Ctrl-C between chunks loses at most one chunk's worth
 * of progress.
 */
export const DEFAULT_UPSERT_CHUNK = 50;

/**
 * Serialized-size ceiling for one document upsert request. The gateway refuses
 * bodies above its own ceiling (64 MiB on `POST /documents`) with a 413 that is
 * not retryable, so a chunk must stay well below it even when every document
 * is a maximum-size text export (10 MiB). A single document always travels
 * alone rather than being refused here.
 */
export const DEFAULT_UPSERT_CHUNK_BYTES = 16 * 1024 * 1024;

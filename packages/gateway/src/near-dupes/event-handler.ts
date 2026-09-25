// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentDeletedEvent, DocumentUpsertedEvent, EventBus } from "../events.js";
import type { NearDupInboxBuffer } from "../scheduler/tasks/near-dup-inbox.js";
import type { ResolvedNearDupConfig } from "./config.js";

/**
 * Pure decision function: given a `document.upserted` event and the
 * current near-dup config, decide which inbox reason (if any) to
 * enqueue. Separated from the bus subscriber so it's testable without
 * spinning up an EventBus.
 *
 *   - returns "insert" for fresh documents (before === null)
 *   - returns "update" for content-body churn (contentChanged true)
 *   - returns null for metadata-only updates and ineligible doc types
 *
 * **Known blind spot — PDF re-extraction.** The event carries
 * `contentChanged` derived from `contentHash` (raw body). A re-OCR
 * or re-extraction of an existing PDF can shift its
 * `extracted_content_hash` (which is what `shouldSuppress` consults
 * to detect "exact dupe" pairs) without touching the raw content
 * hash. Such an update arrives here with `contentChanged === false`
 * and we return null → no re-enqueue. The downstream consequence:
 * a pair that becomes an exact dupe post-extraction may keep its
 * stale near-dup edge until the next `bumpNearDupAlgo` re-processes
 * the whole corpus. Acceptable for now since re-extraction is rare
 * and the bump-on-algo-version path recovers; fix when needed by
 * carrying `extractedContentHash` on the projection.
 */
export function decideUpsertReason(
  event: DocumentUpsertedEvent,
  config: ResolvedNearDupConfig,
): "insert" | "update" | null {
  if (!config.enabled) return null;
  const docType = event.after.documentType ?? null;
  if (!docType || !config.eligibleDocTypes.has(docType)) return null;
  if (event.before === null) return "insert";
  if (event.contentChanged) return "update";
  return null;
}

export interface NearDupEventHandlerOpts {
  eventBus: Pick<EventBus, "on">;
  /**
   * In-memory accumulator. The subscriber only buffers doc ids here —
   * the actual `near_dup_inbox` writes are dispatched in coalesced,
   * background-priority batches by `nearDupInboxFlushTask`. Keeping the
   * hot path write-free is what stops bulk ingest from parking the
   * writer (see `scheduler/tasks/near-dup-inbox.ts`).
   */
  buffer: Pick<NearDupInboxBuffer, "add">;
  /** Re-read on every event so config-reload picks up new eligibility. */
  getConfig: () => ResolvedNearDupConfig;
}

/**
 * Wire the near-dup inbox subscriber to the event bus. Returns the
 * unsubscribe function so callers can detach in tests / teardown.
 *
 * The subscriber does **no writer work** — it only records the doc id in
 * an in-memory buffer (`opts.buffer.add`). `nearDupInboxFlushTask` drains
 * that buffer in coalesced, background-priority batches. This is what
 * keeps bulk ingest from parking the writer: the `document.upserted`
 * event fires synchronously inside the originating request's realtime
 * priority scope, so any writer op dispatched from here would inherit
 * realtime and compete with the actual document writes.
 *
 * Buffering is best-effort; the durability contract (cap drops, failed-flush
 * retry, graceful-shutdown drain, and the ungraceful-crash gap tracked in
 * #26) lives on `nearDupInboxFlushTask`.
 */
export function subscribeNearDupInbox(opts: NearDupEventHandlerOpts): () => void {
  const offUpsert = opts.eventBus.on("document.upserted", (ev: DocumentUpsertedEvent) => {
    const reason = decideUpsertReason(ev, opts.getConfig());
    if (reason === null) return;
    // In-memory only — synchronous, no writer op, no priority inheritance.
    opts.buffer.add(ev.after.id, reason);
  });
  // `document.deleted` is reserved for a future iteration. Today the
  // FK cascade on near_dup_signatures / near_dup_lsh_buckets /
  // near_dup_edges handles cleanup automatically when a documents row
  // is deleted — no inbox row required. We keep the import as a
  // typing anchor so future-us re-adding a handler doesn't need to
  // dig out the event payload type from the bus.
  void ({} as DocumentDeletedEvent);
  return offUpsert;
}

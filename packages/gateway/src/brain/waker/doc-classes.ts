// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Generic document-class predicates — the metadata/type conventions that mark
 * a document as one the cognition engine will not react to per-item: web
 * ephemera, bulk mail, automated notifications, rolling-aggregate summaries,
 * low-signal items. Every signal is generic (a document type or a
 * `defineSource`-contract metadata marker), never a source name.
 *
 * Shared by the waker's eligibility decision (`eligibility.ts`) and the
 * temporal-annotation invalidator's never-reprocessed fallback (which runs on
 * the writer worker), so this module is a dependency-free leaf — it must
 * import nothing, and in particular nothing from `enrichment/`.
 */

/** The generic classification signals a document-class predicate reads. */
export interface DocClassSignals {
  documentType?: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
}

/** Document types the waker never reacts to (web ephemera). */
export const WAKER_SKIP_DOC_TYPES: ReadonlySet<string> = new Set([
  "webpage",
  "web-page",
  "bookmark",
  "browsing-history",
]);

/** Generic bulk-distribution marker (List-Unsubscribe etc.). */
export function isBulkMailDocument(doc: DocClassSignals): boolean {
  return doc.metadata?.["bulkMail"] === true;
}

/**
 * Generic automated-notification marker (no-reply sender / Auto-Submitted) —
 * machine mail that expects no reply and slips the bulk-mail gate.
 */
export function isAutomatedSenderDocument(doc: DocClassSignals): boolean {
  return doc.metadata?.["automatedSender"] === true;
}

/**
 * Generic rolling-aggregate marker — a continuously-rewritten local summary
 * digested by the daily batch, not woken per edit (see the daily enqueuer).
 */
export function isRollingAggregateDocument(doc: DocClassSignals): boolean {
  return doc.metadata?.["rollingAggregate"] === true;
}

/**
 * Generic low-signal marker — a casual, text-less, caption-less document
 * (e.g. an un-analyzable photo) with little for the agent to reason about.
 */
export function isLowSignalDocument(doc: DocClassSignals): boolean {
  return doc.metadata?.["lowSignal"] === true;
}

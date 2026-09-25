// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The real-time waker's V1 heuristics — the pure decision of whether a
 * `document.upserted` event should wake the Cognition Steward, and with what
 * debounce. Separated from the bus subscriber so it's testable without
 * an EventBus (the near-dup `decideUpsertReason` shape).
 *
 * Every signal read here is generic — document type, projection fields,
 * the `bulkMail` metadata convention — never a source name. When a
 * needed signal isn't derivable this way, the `defineSource` contract
 * gets extended instead of branching on a source downstream.
 *
 * The V1 policy:
 *   - **Explicitly-addressed documents wake immediately** — any document
 *     carrying the generic `metadata.addressedToAgent` marker (content
 *     the user deliberately handed to the assistant, e.g. captured
 *     notes). Maximally high-signal by definition, so it bypasses every
 *     volume gate below (skip sets, metadata markers, daily batching,
 *     recency) with zero debounce. Metadata-only churn still never wakes.
 *   - **Skip web ephemera** (web pages, bookmarks, browsing history) —
 *     high-volume, low-commitment-density; the agent can still reach
 *     them via search when other data makes them relevant.
 *   - **Skip bulk mail** — any document carrying the generic
 *     `metadata.bulkMail` marker (e.g. an email with a List-Unsubscribe
 *     header).
 *   - **Skip automated notifications** — any document carrying the generic
 *     `metadata.automatedSender` marker (a `noreply@`/`notifications@`
 *     transactional notification, or an `Auto-Submitted: auto-generated`
 *     email). These slip the bulk-mail gate — they carry no unsubscribe
 *     signal — but each machine notification would otherwise cost a full
 *     reconcile run that concludes "nothing to do".
 *   - **Skip high-throughput structured samples** (bank transactions,
 *     workout activities) **and rolling-aggregate summaries** (documents
 *     carrying the generic `metadata.rollingAggregate` marker — a local
 *     source's continuously-rewritten per-day digest) — those are digested
 *     by the recurring daily runs, not one wake per edit. Health samples
 *     never reach this subscriber at all (they are analytics rows, not
 *     documents).
 *   - **Skip low-signal documents** — any document carrying the generic
 *     `metadata.lowSignal` marker (e.g. a photo with no extracted text,
 *     caption, or labels) — little for the agent to reason about on its own.
 *   - **Recency gate** — a datum is live iff its *source* timestamp is
 *     within `recencyWindow` of now, so a history backfill (old source
 *     timestamps, fresh ingest) never floods the engine. Unparsable
 *     timestamps fail closed for the same reason.
 *   - **Only substantive changes**: inserts, and updates whose content
 *     body changed. Metadata-only churn (tags, re-labels) doesn't wake.
 *   - **Self-trigger guard**: a cognition-authored document — one whose
 *     content is this gateway's own cognition (`brain/cognition-authored.ts`),
 *     whether an open-loop mirror or an agent transcript — never wakes it. No
 *     create→wake→create runaway, and no deriving cognitive state from
 *     cognitive state. The same registry gates trigger and watch evaluation,
 *     so no reactive path treats this engine's writing as an event.
 *   - Everything else — files, notes, events, tasks, emails, and
 *     notably **attachments** — is eligible.
 *
 * Debounce: conversation documents use the (long) conversation
 * debounce on every event — a busy thread coalesces into one run once
 * it quiets. **Thread-membership documents** (a non-conversation datum
 * carrying `metadata.extra.threadId` — chiefly emails, where each message
 * is a distinct document sharing a thread id) are conversation-like too:
 * they use the same conversation debounce + ceiling and fold on a
 * source-scoped THREAD key, so a burst of same-thread arrivals batches into
 * one run over the settled thread rather than one run per message. Other
 * updates use the per-document update debounce; fresh inserts run ASAP.
 */

import { isCognitionAuthoredDocument } from "../cognition-authored.js";
import { changedAddressedEntryIds } from "../addressed-entry-context.js";
import {
  WAKER_SKIP_DOC_TYPES,
  isAutomatedSenderDocument,
  isBulkMailDocument,
  isLowSignalDocument,
  isRollingAggregateDocument,
} from "./doc-classes.js";
import type { DocumentUpsertedEvent } from "../../events.js";

export { WAKER_SKIP_DOC_TYPES } from "./doc-classes.js";

/**
 * Document types that are high-throughput structured samples — digested
 * by the recurring daily runs instead of waking the agent per item.
 */
export const WAKER_DAILY_BATCH_DOC_TYPES: ReadonlySet<string> = new Set([
  "transaction",
  "activity",
]);

/** Doc type that selects the conversation debounce. */
const CONVERSATION_DOC_TYPE = "conversation";

/** The waker slice of the resolved briefs settings. */
export interface WakerHeuristicsConfig {
  recencyWindowMs: number;
  conversationDebounceMs: number;
  documentUpdateDebounceMs: number;
  /** Max-defer ceiling for a conversation's continuously-folded run. */
  conversationMaxDeferMs: number;
  /** Max-defer ceiling for a document's continuously-folded run. */
  documentMaxDeferMs: number;
}

/** A positive wake decision for one upsert event. */
export interface WakeDecision {
  /** Gateway document id (`event.after.id`). */
  docId: string;
  event: "created" | "updated";
  /** The datum's source timestamp (unix ms). */
  datumAt: number;
  /** Quiet period before the enqueued run may be claimed. */
  debounceMs: number;
  /**
   * Ceiling (ms) on how long folding may defer this datum's run — applied when
   * the enqueue folds into an existing pending row so a continuously-active
   * doc still becomes claimable within a bounded time. Per doc-type.
   */
  maxDeferMs: number;
  /**
   * Source-scoped THREAD identity (`<sourceId>:<threadId>`) when the datum is
   * a thread-membership document (an email in a thread), else undefined. When
   * set, the drain folds the run on the thread key instead of the per-document
   * key, so same-thread arrivals batch into one run. Undefined for standalone
   * documents (including single conversation documents, which already collapse
   * per-document).
   */
  threadKey?: string;
  /** Buffer before/after bodies so the drain can compute the update diff. */
  captureDiff: boolean;
  /**
   * The wake must not be delayed by anything downstream. Set for content the
   * user handed to the assistant deliberately, which already bypasses every
   * volume gate here; the readiness barrier honours it too, so "immediately"
   * keeps meaning immediately.
   */
  immediate?: boolean;
  /** Stable ids of structured addressed entries added/edited by this upsert. */
  changedAddressedEntryIds?: string[];
  /** More addressed entries changed than the bounded id list can carry. */
  addressedEntriesTruncated?: boolean;
}

/**
 * Parse the datum's source timestamp: `sourceUpdatedAt` when valid,
 * else `sourceCreatedAt`, else null (fail closed — see module doc).
 */
function parseSourceTimestamp(after: DocumentUpsertedEvent["after"]): number | null {
  const updated = Date.parse(after.sourceUpdatedAt);
  if (!Number.isNaN(updated)) return updated;
  const created = Date.parse(after.sourceCreatedAt);
  return Number.isNaN(created) ? null : created;
}

/**
 * The source-scoped thread identity of a thread-membership document, or
 * undefined when the datum is not part of a multi-document thread. Reads the
 * generic `metadata.extra.threadId` / `.conversationId` convention (the same
 * signal the link graph and near-dup planes key threads on) — never a source
 * name. Thread ids are only unique within a source, so the returned key bakes
 * in the source id.
 */
function threadKeyOf(after: DocumentUpsertedEvent["after"]): string | undefined {
  const extra = after.metadata["extra"];
  if (extra === null || typeof extra !== "object") return undefined;
  const rec = extra as Record<string, unknown>;
  const threadId = rec["threadId"] ?? rec["conversationId"];
  if (typeof threadId !== "string" || threadId.length === 0) return undefined;
  return `${after.sourceId}:${threadId}`;
}

/**
 * Pure V1 wake decision. Returns null when the event must not wake the
 * agent; otherwise the decision the buffer records for the drain task.
 */
export function decideWake(
  event: DocumentUpsertedEvent,
  cfg: WakerHeuristicsConfig,
  now: number,
): WakeDecision | null {
  const after = event.after;

  // Self-trigger guard: a cognition-authored document carries this engine's own
  // output, never something that happened to the user.
  if (isCognitionAuthoredDocument(after.sourceId, after.documentType)) return null;

  // Explicitly-addressed documents (generic `metadata.addressedToAgent`
  // marker): the user deliberately handed this content to the assistant,
  // so it is maximally high-signal — wake immediately, bypassing the
  // skip sets, the metadata volume gates, and the recency window (all of
  // which exist to suppress content the user never meant for the agent).
  // Metadata-only churn still never wakes.
  if (after.metadata["addressedToAgent"] === true) {
    const isMarkedUpdate = event.before !== null;
    if (isMarkedUpdate && !event.contentChanged) return null;
    const changed = changedAddressedEntryIds(event.before?.metadata, after.metadata);
    return {
      docId: after.id,
      event: isMarkedUpdate ? "updated" : "created",
      // Recency is bypassed, so an unparsable source timestamp falls
      // back to "now" instead of failing closed.
      datumAt: parseSourceTimestamp(after) ?? now,
      debounceMs: 0,
      maxDeferMs: 0,
      captureDiff: isMarkedUpdate,
      immediate: true,
      ...(changed.ids.length > 0 ? { changedAddressedEntryIds: changed.ids } : {}),
      ...(changed.truncated ? { addressedEntriesTruncated: true } : {}),
    };
  }

  const docType = after.documentType;
  if (docType !== null && WAKER_SKIP_DOC_TYPES.has(docType)) return null;
  if (docType !== null && WAKER_DAILY_BATCH_DOC_TYPES.has(docType)) return null;

  // Actionable-transactional override: a document carrying a promoted typed
  // scheduled/due date (`metadata.scheduledAt` / `dueAt`, #1168) is a real
  // dated obligation — a booking, an invoice, an appointment. Let it through
  // the bulk-mail and automated-sender gates that otherwise drop the very
  // transactional confirmations (flights, hotels, renewals) that make the best
  // cross-source cards. ONLY those two gates are bypassed; recency,
  // self-trigger, churn, rolling-aggregate and low-signal all still apply.
  const hasPromotedDate =
    typeof after.metadata["dueAt"] === "string" ||
    typeof after.metadata["scheduledAt"] === "string";

  // The generic document-class gates (bulk mail, automated notifications,
  // rolling aggregates, low-signal items) — see doc-classes.ts.
  if (!hasPromotedDate && isBulkMailDocument(after)) return null;
  if (!hasPromotedDate && isAutomatedSenderDocument(after)) return null;
  if (isRollingAggregateDocument(after)) return null;
  if (isLowSignalDocument(after)) return null;

  const isUpdate = event.before !== null;
  // Metadata-only churn never wakes; only inserts and body changes do.
  if (isUpdate && !event.contentChanged) return null;

  const datumAt = parseSourceTimestamp(after);
  if (datumAt === null) return null;
  // Recency gate — source timestamp, never ingest time. Future-dated
  // items (clock skew, upcoming calendar events) count as live.
  if (now - datumAt > cfg.recencyWindowMs) return null;

  const isConversation = docType === CONVERSATION_DOC_TYPE;
  // A non-conversation thread-membership document (an email in a thread) is
  // conversation-like: batch same-thread arrivals on the thread key. Single
  // conversation documents already collapse per-document, so they keep the
  // per-document key (thread routing would be a no-op for them).
  const threadKey = isConversation ? undefined : threadKeyOf(after);
  const isThreadLike = isConversation || threadKey !== undefined;
  const debounceMs = isThreadLike
    ? cfg.conversationDebounceMs
    : isUpdate
      ? cfg.documentUpdateDebounceMs
      : 0;
  // The ceiling follows the same conversation-vs-document split (a fresh insert
  // doesn't fold, so its ceiling is inert — but a thread's very first message is
  // still an insert that later folds, so pick by thread-likeness).
  const maxDeferMs = isThreadLike ? cfg.conversationMaxDeferMs : cfg.documentMaxDeferMs;

  return {
    docId: after.id,
    event: isUpdate ? "updated" : "created",
    datumAt,
    debounceMs,
    maxDeferMs,
    ...(threadKey !== undefined ? { threadKey } : {}),
    captureDiff: isUpdate,
  };
}

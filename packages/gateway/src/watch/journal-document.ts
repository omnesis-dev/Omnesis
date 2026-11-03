// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading journal rows back as events, and the one read the evaluation engine
 * makes per indexed document: the newest revision of a document at or before
 * a sequence.
 *
 * The engine asks that question for every `doc.indexed` event it walks, and
 * again for each older revision it looks back through, so on a real install it
 * is many statements and payload decodes per evaluation pass. The engine asks
 * synchronously, from inside the write transaction it holds for an event, so
 * the gateway does not answer from an io worker there: before a run it reads
 * the recent revision history of every document the run's index events name,
 * on an io worker (`io.watchDocumentHistories`, a read-only connection to the
 * journal of its own), and the run's lookups are answered from that
 * ({@link PrefetchedJournalDocuments}). This module is shared by that worker
 * and by the journal store's direct read.
 *
 * Kept free of the rest of the Watch runtime so that the io worker, which
 * imports it, loads only the event contract to run one query.
 */

import {
  journalEventSchema,
  toJournalInstant,
  type DocEvent,
  type JournalEvent,
} from "@omnesis/watch/journal";

/** One row of `watch_events` as SQLite returns it. */
export interface EventRow {
  seq: number;
  kind: string;
  occurred_at: string;
  observed_at: string;
  payload: string;
}

/** A document event the journal holds, and where it sits in the sequence. */
export interface JournalDocumentAt {
  readonly event: DocEvent;
  readonly seq: number;
}

/** A document whose revisions at or before `atSeq` are wanted. */
export interface JournalHistoryRequest {
  readonly docId: string;
  readonly atSeq: number;
}

/**
 * A document's newest journalled revisions at or before `atSeq`, newest
 * first. A revision this build cannot read is held as `document: null`, as
 * {@link journalDocumentAt} answers for it. `complete` says the list reaches
 * the document's first revision.
 */
export interface JournalDocumentHistory {
  readonly docId: string;
  readonly atSeq: number;
  readonly revisions: ReadonlyArray<{ seq: number; document: JournalDocumentAt | null }>;
  readonly complete: boolean;
}

/** Reads {@link journalDocumentHistories} somewhere other than the calling thread. */
export type JournalHistoryReader = (
  requests: readonly JournalHistoryRequest[],
) => Promise<JournalDocumentHistory[]>;

/**
 * Revisions read per document: the newest at the index event, plus every
 * older one the engine's look back through a document's history can reach
 * (eight), with room for the same document indexed again within one run.
 */
export const JOURNAL_HISTORY_DEPTH = 12;

/** The statement surface the read needs, whichever driver opened the file. */
export interface JournalReadHandle {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * One stored row as a journal event, or `null` when this build cannot read it.
 *
 * The JSON parse belongs inside the guard rather than beside it: a payload that
 * is not JSON at all is exactly the corruption the skip exists for, and a parse
 * that threw from outside would take down the whole read — turning "skip one
 * row" into "reach no row after it", which is the failure the caller was trying
 * to avoid.
 */
export function decodeEvent(row: EventRow): { event: JournalEvent } | { why: string } {
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    // Normalized on the way out as well as on the way in, so an event written
    // before the writer canonicalized its instants is readable now rather than
    // invisible forever. The schema is unchanged and still refuses anything
    // outside the canonical form; this only maps known spellings onto it.
    const candidate = {
      seq: row.seq,
      kind: row.kind,
      occurredAt: toJournalInstant(row.occurred_at) ?? row.occurred_at,
      observedAt: toJournalInstant(row.observed_at) ?? row.observed_at,
      payload: normalizePayloadInstants(payload),
    };
    const parsed = journalEventSchema.safeParse(candidate);
    if (parsed.success) return { event: parsed.data };
    // Paths and codes only. The values are corpus content — titles, names,
    // message text — and a log line is the one place they must never reach.
    const why = parsed.error.issues
      .map((issue) => `${issue.path.join("/") || "(root)"}:${issue.code}`)
      .join(" ");
    return { why };
  } catch {
    return { why: "payload is not JSON" };
  }
}

/** The instants a payload carries, in the journal's canonical spelling. */
function normalizePayloadInstants(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const field of ["semanticTime", "eventIndexedAt"]) {
    const held = out[field];
    if (typeof held === "string") out[field] = toJournalInstant(held) ?? held;
  }
  return out;
}

const DOCUMENT_ROWS = `SELECT seq, kind, occurred_at, observed_at, payload FROM watch_events
  WHERE kind = 'doc.event' AND json_valid(payload)
    AND json_extract(payload, '$.docId') = ? AND seq <= ?
  ORDER BY seq DESC LIMIT ?`;

function asDocument(row: EventRow): JournalDocumentAt | null {
  const decoded = decodeEvent(row);
  if (!("event" in decoded)) return null;
  const event = decoded.event;
  return event.kind === "doc.event" ? { event: event.payload, seq: event.seq } : null;
}

/**
 * The most recent `doc.event` for a document at or before `atSeq`.
 *
 * The bound is the whole point: a consumer catching up after a restart is
 * walking a backlog, so an unbounded "most recent" would hand it a revision
 * that had not happened yet at the event it is evaluating — and a watch would
 * then decide differently depending on how far behind it was.
 *
 * `json_extract` rather than a column, because the docId lives in the payload
 * and adding a column would be a second copy that can disagree with the
 * event.
 *
 * The `json_valid` term is not redundant: SQLite uses a partial index only
 * when the query repeats the index's own WHERE terms, and without it this
 * degrades to a backwards scan of the whole journal — measured at 416ms
 * against 1ms over twenty thousand events, once per indexed document.
 */
export function journalDocumentAt(
  db: JournalReadHandle,
  docId: string,
  atSeq: number,
): JournalDocumentAt | null {
  const row = db.prepare(DOCUMENT_ROWS).get(docId, atSeq, 1) as EventRow | undefined;
  return row ? asDocument(row) : null;
}

/** The newest `depth` revisions of each requested document, one index seek each. */
export function journalDocumentHistories(
  db: JournalReadHandle,
  requests: readonly JournalHistoryRequest[],
  depth: number = JOURNAL_HISTORY_DEPTH,
): JournalDocumentHistory[] {
  const statement = db.prepare(DOCUMENT_ROWS);
  return requests.map(({ docId, atSeq }) => {
    const rows = statement.all(docId, atSeq, depth) as EventRow[];
    return {
      docId,
      atSeq,
      revisions: rows.map((row) => ({ seq: row.seq, document: asDocument(row) })),
      complete: rows.length < depth,
    };
  });
}

/** Requests per io call, so one reply stays small. */
const HISTORY_REQUESTS_PER_CALL = 256;

/**
 * Document lookups for one engine run, answered from histories read ahead of
 * it, and from `direct` — a read on the calling thread — for anything they do
 * not cover: a document the prefetch did not name, a look back past the
 * revisions read, or a prefetch that failed.
 *
 * Answers equal {@link journalDocumentAt}'s, because the journal is append-only:
 * a document's revisions at or before a sequence never change once that
 * sequence has been read.
 */
export class PrefetchedJournalDocuments {
  private readonly held = new Map<string, JournalDocumentHistory>();

  constructor(
    private readonly direct: (docId: string, atSeq: number) => JournalDocumentAt | null,
  ) {}

  /**
   * Read ahead the histories `wanted` will be asked about, one request per
   * document at its newest sequence. A failure leaves those documents to
   * `direct`: it costs the main thread the reads, never a wrong answer.
   */
  async prefetch(
    reader: JournalHistoryReader,
    wanted: Iterable<JournalHistoryRequest>,
    onError?: (err: unknown) => void,
  ): Promise<void> {
    const newest = new Map<string, number>();
    for (const { docId, atSeq } of wanted) {
      if ((this.held.get(docId)?.atSeq ?? -1) >= atSeq) continue;
      newest.set(docId, Math.max(newest.get(docId) ?? -1, atSeq));
    }
    const requests = [...newest].map(([docId, atSeq]) => ({ docId, atSeq }));
    for (let offset = 0; offset < requests.length; offset += HISTORY_REQUESTS_PER_CALL) {
      try {
        const histories = await reader(requests.slice(offset, offset + HISTORY_REQUESTS_PER_CALL));
        for (const history of histories) this.held.set(history.docId, history);
      } catch (err) {
        onError?.(err);
        return;
      }
    }
  }

  lookup(docId: string, atSeq: number): JournalDocumentAt | null {
    const history = this.held.get(docId);
    if (history && atSeq <= history.atSeq) {
      for (const revision of history.revisions) {
        if (revision.seq <= atSeq) return revision.document;
      }
      if (history.complete) return null;
    }
    return this.direct(docId, atSeq);
  }
}

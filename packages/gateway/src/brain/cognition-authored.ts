// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The registry of **cognition-authored sources** — sources whose documents
 * contain this gateway's own cognition. Reacting to one feeds the engine its
 * own output back as though it were something that happened to the user.
 *
 * Two kinds are registered, and they differ in every way except that:
 *
 *  - A **mirror** of internal cognitive state. Open loops are the canonical
 *    case: the `open_loops` tables are the record, and the document exists
 *    only so the loop inherits the search INDEX (chunking, embeddings, FTS).
 *    Nothing about it is corpus data.
 *  - An **agent transcript**: the operator's own conversation with the Omnesis
 *    agent. A real artifact worth keeping and searching — but every second turn
 *    in it is the agent's own prose, itself derived from the corpus. A datum
 *    run over one is the engine reading its own answers back and deriving
 *    fresh cognitive state from them.
 *
 * The two policies that read this registry are therefore per-entry, not
 * uniform:
 *
 *  - **The reactive plane** ({@link isCognitionAuthoredDocument}) drops EVERY
 *    entry, unconditionally, with no bypass. This is the whole point of the
 *    registry.
 *  - **Retrieval** (`search/hidden-sources.ts`) hides only entries that opt in
 *    via {@link CognitionAuthoredSource.hiddenFromSearch} — and even then lets
 *    a caller that explicitly names the source or one of its document types
 *    through, which is the bypass `open_loop_search` rides on. A mirror opts
 *    in, because the tables are the truth and the document is an index
 *    artifact. A transcript does not: the operator should find their own
 *    conversations.
 *
 * So "findable" and "reactable" are independent axes. Everything here is
 * unreactable; only some of it is unfindable.
 *
 * Deny-list scans consult this module. An ALLOW-list scan admits an entry only
 * when the entry's document type is one it enumerates, so whether it needs a
 * gate depends on the entry, and must be re-derived per entry rather than
 * assumed:
 *
 *  - The daily enqueuer (`documentType IN ('transaction','activity') OR
 *    metadata.rollingAggregate`) admits neither registered source.
 *  - Near-dup eligibility DOES enumerate `conversation`, so an agent
 *    transcript flows into near-dup detection. That plane costs no cognition
 *    run and produces graph edges rather than derived state, so it is
 *    deliberately left ungated — but it is not "safe by construction", and a
 *    future entry must check rather than inherit this reasoning.
 *
 * A deny-list keyed on document type alone is likewise incomplete: it cannot
 * see an entry with no exclusive type. Such a scan needs
 * {@link cognitionAuthoredSqlExclusion} on the source column as well —
 * `brain/storage/bootstrap.ts` is the pattern to copy.
 */

import { OMNESIS_CHAT_SOURCE_ID } from "../sources/omnesis-chat/ids.js";
import { OPEN_LOOP_DOCUMENT_TYPE, OPEN_LOOP_SOURCE_ID } from "./open-loop-source/source-meta.js";

/** One cognition-authored source and the policies that apply to it. */
export interface CognitionAuthoredSource {
  readonly sourceId: string;
  /**
   * Document types emitted by THIS SOURCE AND NO OTHER — a second, independent
   * identification key for a consumer holding a projection whose source id it
   * does not recognise, and the retrieval policy's type-filter bypass key.
   *
   * Empty when the source's types are shared with ordinary corpus sources. An
   * agent transcript is a `conversation`, exactly like a WhatsApp thread or an
   * iMessage thread; registering that type here would make the reactive plane
   * silently drop every real conversation the operator has. Exclusivity is what
   * makes matching on a type sound, so a type that is not exclusive is simply
   * not listed, and the source is identified by its id alone.
   */
  readonly exclusiveDocumentTypes: readonly string[];
  /**
   * Whether unscoped search and document listings hide this source. True for a
   * mirror of internal state, false for an artifact the operator authored half
   * of and should be able to find.
   */
  readonly hiddenFromSearch: boolean;
}

// Frozen rather than merely `readonly`: two policies read this array, and a
// mutation would silently retune both.
export const COGNITION_AUTHORED_SOURCES: readonly CognitionAuthoredSource[] = Object.freeze([
  Object.freeze({
    sourceId: OPEN_LOOP_SOURCE_ID,
    exclusiveDocumentTypes: Object.freeze([OPEN_LOOP_DOCUMENT_TYPE]),
    hiddenFromSearch: true,
  }),
  Object.freeze({
    sourceId: OMNESIS_CHAT_SOURCE_ID,
    // `conversation` is shared with every messaging source — see the field doc.
    exclusiveDocumentTypes: Object.freeze([]),
    hiddenFromSearch: false,
  }),
]);

const AUTHORED_SOURCE_IDS: ReadonlySet<string> = new Set(
  COGNITION_AUTHORED_SOURCES.map((s) => s.sourceId),
);
const EXCLUSIVE_DOCUMENT_TYPES: ReadonlySet<string> = new Set(
  COGNITION_AUTHORED_SOURCES.flatMap((s) => s.exclusiveDocumentTypes),
);

/**
 * True when a document carries this gateway's own cognition — the gate every
 * reactive intake point applies before treating a corpus event as something
 * that happened *to the user*.
 *
 * Matches on source id, or on a document type that only a cognition-authored
 * source emits. The second arm exists so a consumer that has lost the source id
 * still recognises a mirror; it is sound precisely because non-exclusive types
 * are never registered.
 */
export function isCognitionAuthoredDocument(
  sourceId: string | null | undefined,
  documentType?: string | null,
): boolean {
  if (sourceId != null && AUTHORED_SOURCE_IDS.has(sourceId)) return true;
  return documentType != null && EXCLUSIVE_DOCUMENT_TYPES.has(documentType);
}

/**
 * The exclusively-cognition-authored document types — for deny-list scans that
 * filter on `metadata.documentType`. A scan relying on this ALONE does not
 * cover sources with no exclusive type (an agent transcript); such a scan needs
 * {@link cognitionAuthoredSqlExclusion} on the source column as well.
 */
export function cognitionAuthoredDocumentTypes(): string[] {
  return [...EXCLUSIVE_DOCUMENT_TYPES];
}

/**
 * A `NOT IN (…)` fragment plus its bound parameters, for SQL scans that read
 * `documents` directly instead of receiving events. Empty `sql` when the
 * registry is empty, so a caller can concatenate unconditionally.
 *
 * Filtering on the source column covers every entry, including those with no
 * exclusive document type — which is why it, and not the type list, is the
 * complete deny-list for a corpus scan.
 */
export function cognitionAuthoredSqlExclusion(column = "source_id"): {
  sql: string;
  params: string[];
} {
  const ids = [...AUTHORED_SOURCE_IDS];
  if (ids.length === 0) return { sql: "", params: [] };
  return { sql: `${column} NOT IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

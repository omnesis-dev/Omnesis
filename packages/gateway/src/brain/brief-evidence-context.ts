// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { containsNormalized } from "./quote-match.js";
import { isKnowledgeEvidenceReadable } from "./knowledge/storage-source-fence.js";
import { OPEN_LOOP_DOCUMENT_TYPE, OPEN_LOOP_SOURCE_ID } from "./open-loop-source/source-meta.js";
import { KNOWLEDGE_DOCUMENT_TYPE, KNOWLEDGE_SOURCE_ID } from "./knowledge/source-meta.js";
import { KnowledgeStorageError } from "./knowledge/types.js";
import type Database from "better-sqlite3";

export interface RenderedBrief {
  title: string;
  description?: string | null;
  body?: string | null;
  eventAt?: number | null;
  relevantUntil?: number | null;
}

/** Original sources and displayed meaning captured before asynchronous verification. */
export function briefEvidenceContext(
  db: Database.Database,
  brief: RenderedBrief,
  sourceIds: readonly string[],
  now: number,
  quotes: readonly { evidenceDocId: string; evidenceQuote: string }[] = [],
  additionalEvidence: readonly { ref: string; text: string }[] = [],
): { claim: string; evidence: string; context: string } | null {
  const ids = [...new Set(sourceIds)];
  // Source-free operational cards retain their existing contract. This check
  // covers factual source-derived briefs, including updates to existing cards.
  if (!ids.length && !additionalEvidence.length) return null;
  if (
    ids.length > 32 ||
    quotes.length > 98 ||
    additionalEvidence.length > 16 ||
    additionalEvidence.reduce((n, item) => n + item.ref.length + item.text.length, 0) > 24_000 ||
    JSON.stringify(brief).length > 24_000 ||
    quotes.reduce((n, q) => n + q.evidenceQuote.length, 0) > 24_000
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Brief verification exceeds the bounded context; narrow the brief and its support",
    );
  const columns = new Set(
    db
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .map((row) => row.name),
  );
  const metadata = ["title", "source_created_at", "source_updated_at", "source_id"]
    .map((name) => (columns.has(name) ? name : `NULL AS ${name}`))
    .join(",");
  const documentType = columns.has("metadata")
    ? "json_extract(metadata, '$.documentType')"
    : "NULL";
  const sources = ids.map((id) => {
    if (!isKnowledgeEvidenceReadable(db, id))
      throw new KnowledgeStorageError("reference_invalid", "Brief evidence is unavailable");
    const row = db
      .prepare<
        [string],
        {
          content: string;
          title: string | null;
          source_created_at: string | null;
          source_updated_at: string | null;
          source_id: string | null;
          document_type: string | null;
        }
      >(`SELECT content,${metadata},${documentType} AS document_type FROM documents WHERE id=?`)
      .get(id);
    if (
      !row ||
      [KNOWLEDGE_SOURCE_ID, OPEN_LOOP_SOURCE_ID].includes(row.source_id ?? "") ||
      [KNOWLEDGE_DOCUMENT_TYPE, OPEN_LOOP_DOCUMENT_TYPE].includes(row?.document_type ?? "")
    )
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Brief verification requires original source documents",
      );
    const text = row.content ?? "";
    const limit = Math.floor(48_000 / ids.length);
    const truncated = text.length > limit;
    const passages = truncated
      ? [text.slice(0, Math.floor(limit / 2)), text.slice(-Math.floor(limit / 2))]
      : [];
    const selectedQuotes = quotes
      .filter(
        (quote) => quote.evidenceDocId === id && containsNormalized(text, quote.evidenceQuote),
      )
      .map((quote) => quote.evidenceQuote);
    return {
      id,
      authority: truncated ? "selected_quote" : "whole_source",
      title: row.title?.slice(0, 500) ?? null,
      titleTruncated: (row.title?.length ?? 0) > 500,
      sourceCreatedAt: row.source_created_at,
      sourceUpdatedAt: row.source_updated_at,
      selectedQuotes: [...passages, ...selectedQuotes],
      text: truncated
        ? "The first two selectedQuotes are the source head and tail, in that order; any following quotes were separately selected from the source. These excerpts are not contiguous. Omitted passages cannot establish absence."
        : text,
      truncated,
    };
  });
  return {
    claim: JSON.stringify({
      title: brief.title,
      description: brief.description ?? null,
      body: brief.body ?? null,
    }),
    context: JSON.stringify({
      task: "Verify the factual meaning of this complete displayed brief, including title, implied subject/event associations, current status, and temporal anchors. Recommendations need supported factual premises, not evidence that a proposed future action has already happened. Source-relative dates must remain tied to their source date in the displayed prose, rather than becoming a new countdown at display time. eventAt is an event anchor; relevantUntil is display expiry, not proof of a deadline. These metadata are proposed context, not evidence. Historical attributed statements remain valid; do not require every statement to describe the present.",
      asOf: new Date(now).toISOString(),
      title: brief.title,
      eventAt: brief.eventAt ?? null,
      relevantUntil: brief.relevantUntil ?? null,
    }),
    evidence: JSON.stringify({
      sources,
      verifiedReferences: additionalEvidence,
      limitation:
        "Source timestamps describe records, not automatically event times. Omitted passages cannot establish absence. For truncated sources, only selectedQuotes authorize factual witnesses; surrounding metadata and omission markers do not. Distinct events require evidence of the relationship asserted between them.",
    }),
  };
}

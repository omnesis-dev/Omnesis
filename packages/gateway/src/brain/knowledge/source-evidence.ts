// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  readSourceEvidenceAuthority,
  attributedSourceStatements,
} from "../../sources/evidence-authority.js";
import { contextualEvidence } from "../verification-evidence.js";
import type Database from "better-sqlite3";

export interface KnowledgeSourceMetadata {
  title: string | null;
  titleTruncated: boolean;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

/** Caller has already established reference readability in the same read snapshot. */
export function readKnowledgeSourceEvidence(db: Database.Database, id: string, quote?: string) {
  const columns = new Set(
    db
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .map((row) => row.name),
  );
  const optional = ["title", "source_created_at", "source_updated_at"].map((name) =>
    columns.has(name) ? name : `NULL AS ${name}`,
  );
  const row = db
    .prepare<
      [string],
      {
        content: string;
        content_hash: string;
        title: string | null;
        source_created_at: string | null;
        source_updated_at: string | null;
      }
    >(`SELECT content,content_hash,${optional.join(",")} FROM documents WHERE id=?`)
    .get(id);
  if (!row) return null;
  const sourceMetadata: KnowledgeSourceMetadata = {
    title: row.title?.slice(0, 500) ?? null,
    titleTruncated: (row.title?.length ?? 0) > 500,
    sourceCreatedAt: row.source_created_at,
    sourceUpdatedAt: row.source_updated_at,
  };
  const authority = readSourceEvidenceAuthority(db, id, row.content);
  if (authority) {
    const observed: Array<{ offset: number; length: number }> = [];
    if (quote === undefined) observed.push({ offset: 0, length: row.content.length });
    else if (quote.length) {
      let offset = row.content.indexOf(quote);
      while (offset >= 0 && observed.length < 128) {
        observed.push({ offset, length: quote.length });
        offset = row.content.indexOf(quote, offset + 1);
      }
    }
    const statements = attributedSourceStatements(authority, row.content, observed);
    return {
      content: row.content,
      contentHash: row.content_hash,
      sourceMetadata,
      authorityAvailable: statements.length > 0,
      authorityScope: "attributed_utterances" as const,
      verifierEvidence: JSON.stringify({
        sources: [],
        verifiedReferences: statements,
        limitation:
          "This source supplies only authenticated attributed utterances, not independent world-fact confirmation. Assistant statements are historical speech; user questions are not affirmative user testimony. Missing or partial utterances provide no authority. Read current original evidence for independent factual support.",
      }),
    };
  }
  let text = row.content;
  let truncated = false;
  let retainedPassages: string[] = [];
  if (quote !== undefined) {
    const framed = contextualEvidence(quote, row.content);
    if (framed !== quote) {
      const parsed = JSON.parse(framed) as { source_context: string; truncated: boolean };
      text = parsed.source_context;
      truncated = parsed.truncated;
    }
  } else if (text.length > 48_000) {
    retainedPassages = [text.slice(0, 24_000), text.slice(-24_000)];
    text =
      "The first two selectedQuotes are the source head and tail, in that order; any following quotes were separately selected from the source. These excerpts are not contiguous. Omitted passages cannot establish absence.";
    truncated = true;
  }
  return {
    authorityAvailable: true,
    authorityScope: undefined,
    content: row.content,
    contentHash: row.content_hash,
    sourceMetadata,
    verifierEvidence: JSON.stringify({
      sources: [
        {
          id,
          authority: quote === undefined && !truncated ? "whole_source" : "selected_quote",
          ...sourceMetadata,
          text,
          selectedQuotes: quote === undefined ? retainedPassages : [quote],
          truncated,
        },
      ],
      verifiedReferences: [],
      limitation:
        "Source timestamps describe records, not automatically event times. Omitted passages cannot establish absence." +
        (quote === undefined
          ? truncated
            ? " This source was truncated: only exact retained selectedQuotes authorize factual witnesses. The omission marker and metadata only guide interpretation; metadata alone cannot establish an independent claim."
            : ""
          : " This is a selected-quote reference: the selected quote supplies the asserted facts; surrounding text and metadata only qualify its interpretation. Cite the whole source separately to establish independent surrounding facts."),
    }),
  };
}

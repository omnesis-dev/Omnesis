// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isKnowledgeEvidenceReadable } from "./knowledge/storage-source-fence.js";
import type Database from "better-sqlite3";

/** Legacy audit content is hidden before the physical source deletion sweep. */
export function areDecisionSourcesReadable(
  db: Database.Database,
  decision: { documentId: string; subjectDocumentId: string },
): boolean {
  return [decision.documentId, decision.subjectDocumentId].every(
    (id) =>
      isKnowledgeEvidenceReadable(db, id) &&
      !db
        .prepare(
          "SELECT 1 FROM knowledge_cascade_jobs WHERE kind='purge' AND target_kind='source' AND target_id=?",
        )
        .get(id),
  );
}

/** Retained ledger JSON is not an exact capture and is never reconstructed. */
export function readRetainedDecisionInput(db: Database.Database, id: string) {
  const row = db
    .prepare<[string], { request: string | null; response: string | null }>(
      `SELECT CASE WHEN length(CAST(request_json AS BLOB))<=131072 THEN request_json END AS request,
      CASE WHEN length(CAST(response_json AS BLOB))<=131072 THEN response_json END AS response
      FROM cognition_decisions WHERE id=?`,
    )
    .get(id);
  const parse = (value: string | null | undefined): unknown => {
    if (!value) return null;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  };
  const request = parse(row?.request);
  const response = parse(row?.response);
  if (request === null && response === null) return undefined;
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const redacted = object(object(object(request)?.state)?.document_context)?.redacted === true;
  return {
    request,
    response,
    requestFidelity: redacted ? ("redacted" as const) : ("stored" as const),
    responseFidelity: redacted ? ("score-only" as const) : ("stored" as const),
  };
}

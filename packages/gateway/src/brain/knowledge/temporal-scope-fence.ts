// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  annotationMatchesScope,
  type AnnotationScope,
  type ScopedAnnotation,
} from "../../enrichment/temporal/annotation-scope.js";
import {
  expandCanonical,
  getTemporalAnnotationById,
} from "../../enrichment/temporal-annotations/storage.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

function refuse(): never {
  throw new KnowledgeStorageError(
    "revision_conflict",
    "The proposed annotation is outside the complete temporal_query scope. Read an annotation-inclusive query covering its whole time interval and intended subject, then reconcile before retrying. Only the latest query supplies the active scope, and it must be complete; separate queries are not combined. Read then mutate within that scope, or query one complete window covering the whole batch. Annotation until is inclusive but query to is exclusive: extend the query beyond the final included instant or day. force does not bypass this requirement.",
  );
}

export function assertTemporalScope(
  db: Database.Database,
  scope: AnnotationScope,
  row: Omit<ScopedAnnotation, "sourceIds">,
): void {
  const lookup = db.prepare<[string], { source_id: string }>(
    "SELECT source_id FROM documents WHERE id=?",
  );
  const sourceIds = row.documentIds.flatMap((id) => {
    const doc = lookup.get(id);
    return doc ? [doc.source_id] : [];
  });
  if (!annotationMatchesScope({ ...row, sourceIds }, scope, true)) refuse();
}

/** Cheap proposed-shape check; the writer checks the actual resolved stored shape too. */
export function assertTemporalToolScope(
  db: Database.Database,
  scope: AnnotationScope,
  name: string,
  raw: unknown,
): void {
  if (name === "temporal_annotation_delete" || !raw || typeof raw !== "object") return;
  const input = raw as Record<string, unknown>;
  const standing =
    typeof input.annotationId === "string"
      ? getTemporalAnnotationById(db, input.annotationId)
      : null;
  const start = typeof input.when === "string" ? expandCanonical(input.when) : null;
  const end = typeof input.until === "string" ? expandCanonical(input.until) : null;
  if (!start && !standing) return; // The ordinary tool schema/not-found path owns invalid input.
  if (input.until !== undefined && !end) return;
  const list = (key: string, fallback: readonly string[]) =>
    Array.isArray(input[key])
      ? (input[key] as unknown[]).filter((id): id is string => typeof id === "string")
      : fallback;
  const evidence =
    input.evidence && typeof input.evidence === "object"
      ? (input.evidence as Record<string, unknown>)
      : undefined;
  assertTemporalScope(db, scope, {
    id: standing?.id ?? "",
    intervalStartMs: start
      ? Math.min(start.startMs, end?.startMs ?? start.startMs)
      : standing!.intervalStartMs,
    intervalEndMs: start
      ? Math.max(start.endMs, end?.endMs ?? start.endMs)
      : standing!.intervalEndMs,
    precision: start ? (end ? "range" : start.precision) : standing!.precision,
    canonical: start
      ? end
        ? `${String(input.when)} .. ${String(input.until)}`
        : String(input.when)
      : standing!.canonical,
    kind: typeof input.kind === "string" ? input.kind : standing?.kind,
    documentIds: [
      ...list("documentIds", standing?.documentIds ?? []),
      ...(typeof evidence?.docId === "string" ? [evidence.docId] : []),
    ],
    personIds: list("personIds", standing?.personIds ?? []),
    loopIds: list("loopIds", standing?.loopIds ?? []),
    projectionIds: list("projectionIds", standing?.projectionIds ?? []),
  });
}

/** Runs after the synchronous canonical handler, inside its rollback transaction. */
export function assertStoredTemporalMutationScope(
  db: Database.Database,
  scope: AnnotationScope | undefined,
  operation: string,
  args: unknown[],
): void {
  if (!scope || !["temporalAnnotations.create", "temporalAnnotations.update"].includes(operation))
    return;
  const id =
    operation === "temporalAnnotations.create" ? (args[0] as { id: string }).id : String(args[0]);
  const row = getTemporalAnnotationById(db, id);
  if (!row) refuse();
  assertTemporalScope(db, scope, row);
}

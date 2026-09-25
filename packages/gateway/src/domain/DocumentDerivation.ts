// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The deterministic derivation pipeline that runs over every ingested
 * document, and the single registry naming its stages.
 *
 * Ingest writes a document row; several background drips then derive facts
 * *about* it — the reference-graph edges, the resolved people, the extracted
 * dates. Each stage follows the same convention: a nullable completion column
 * on `documents` (NULL = not yet derived) backed by a partial index, stamped
 * once the stage is done with that document.
 *
 * Two consumers need to know whether that pipeline has finished with a given
 * document:
 *
 *   - the cognition readiness barrier (`brain/waker/drain-task.ts`), which
 *     holds a `data` run until its datum is fully derived so the agent reasons
 *     about a document that already has its edges, people and dates — the
 *     deterministic layer settles before the stochastic one reads it;
 *   - the datum-neighbourhood prompt block (`brain/steward/prompts.ts`), which
 *     states which stages were still pending when a run went ahead anyway.
 *
 * Registering a stage here therefore enrolls it in the barrier and in the
 * operator-visible "what was missing" reporting at once. A stage added to the
 * schema but not to {@link DERIVATION_STAGES} would silently fall outside both
 * — which is the drift this registry exists to prevent.
 *
 * Scope: stages that stamp a per-document completion column. Near-duplicate
 * scoring is deliberately NOT a stage — it carries no such column (its work
 * queue is `near_dup_inbox`) and its compute drip parks at idle, so gating a
 * reactive run on it would trade the barrier's bounded wait for an unbounded
 * one.
 */

import { DATE_EXTRACTION_TASK_NAME } from "../enrichment/dates/task.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** Stable identifier for one derivation stage. */
export type DerivationStageId = "links" | "people" | "dates";

export interface DerivationStage {
  readonly id: DerivationStageId;
  /**
   * The `documents` completion column. NULL means the stage has not yet
   * processed this document.
   *
   * Interpolated into SQL rather than bound, because a column name cannot be a
   * parameter. The literal union is what makes that safe: no value outside this
   * set can reach a query, including through an exported function that accepts
   * a caller-constructed stage.
   */
  readonly column: "links_extracted_at" | "people_resolved_at" | "dates_extracted_at";
  /** Operator-facing label, used in logs and in the run prompt. */
  readonly label: string;
  /**
   * The scheduler task that fills this stage's column.
   *
   * Each drip backs off to a long idle poll when it finds no work, so a
   * document arriving into an empty queue would otherwise wait out that
   * backoff before the stage even looked at it. Naming the task here lets one
   * subscriber nudge every stage on ingest, and keeps that nudge in step with
   * the registry: a stage added later is woken for free.
   */
  readonly taskName: string;
}

/**
 * Every per-document derivation stage. Order is presentation order only —
 * the stages run independently and in no guaranteed sequence.
 */
export const DERIVATION_STAGES: readonly DerivationStage[] = [
  {
    id: "links",
    column: "links_extracted_at",
    label: "reference-graph edges",
    taskName: "backfill.linkBatch",
  },
  {
    id: "people",
    column: "people_resolved_at",
    label: "people resolution",
    taskName: "backfill.peopleBatch",
  },
  {
    id: "dates",
    column: "dates_extracted_at",
    label: "date extraction",
    taskName: DATE_EXTRACTION_TASK_NAME,
  },
];

/** Resolve worker-message ids through the closed registry before using columns in SQL. */
export function resolveDerivationStages(ids: readonly DerivationStageId[]): DerivationStage[] {
  return ids.map((id) => {
    const stage = DERIVATION_STAGES.find((candidate) => candidate.id === id);
    if (stage === undefined) throw new Error(`Unknown derivation stage: ${String(id)}`);
    return stage;
  });
}

/** Whether a document's deterministic derivation has finished, and what hasn't. */
export interface DocumentDerivationState {
  /** False when the document row is gone (deleted between enqueue and read). */
  readonly exists: boolean;
  /** Stages still to run. Empty when the pipeline is done with this document. */
  readonly pending: readonly DerivationStageId[];
  /** Convenience: `exists && pending.length === 0`. */
  readonly complete: boolean;
}

const STATE_SQL = `SELECT ${DERIVATION_STAGES.map((s) => `${s.column} AS ${s.id}`).join(", ")}
     FROM documents WHERE id = ?`;

/**
 * Read one document's derivation state.
 *
 * `stages` narrows the question to the stages whose producers are actually
 * running. A stage that is switched off never stamps its column, so counting
 * it would make every document permanently incomplete — callers that gate on
 * completeness must pass the active subset rather than assume all of them.
 *
 * A missing document reports `exists: false` with no pending stages — a
 * deleted datum is not something to wait for, and the data-run prompt already
 * handles the deleted case on its own.
 */
export function documentDerivationState(
  db: Db,
  docId: string,
  stages: readonly DerivationStage[] = DERIVATION_STAGES,
): DocumentDerivationState {
  const row = db.prepare<[string], Record<DerivationStageId, string | null>>(STATE_SQL).get(docId);
  if (row === undefined) return { exists: false, pending: [], complete: false };
  const pending = stages.filter((s) => row[s.id] === null).map((s) => s.id);
  return { exists: true, pending, complete: pending.length === 0 };
}

/**
 * The subset of `docIds` whose readiness wait is over: fully derived documents
 * plus documents that no longer exist. A deleted datum cannot finish deriving,
 * and the data-run prompt handles its disappearance explicitly, so keeping its
 * run at the barrier would only delay that degradation until the ceiling.
 *
 * The query selects existing INCOMPLETE rows and subtracts them from the input.
 * That keeps missing ids in the result without issuing a query per document.
 */
export function derivationReadyDocIds(
  db: Db,
  docIds: readonly string[],
  stages: readonly DerivationStage[] = DERIVATION_STAGES,
): Set<string> {
  const ready = new Set(docIds);
  if (ready.size === 0 || stages.length === 0) return ready;
  const ids = [...ready];
  const placeholders = ids.map(() => "?").join(",");
  const incomplete = stages.map((s) => `${s.column} IS NULL`).join(" OR ");
  const rows = db
    .prepare<
      string[],
      { id: string }
    >(`SELECT id FROM documents WHERE id IN (${placeholders}) AND (${incomplete})`)
    .all(...ids);
  for (const row of rows) ready.delete(row.id);
  return ready;
}

/** Human-readable stage labels, for logs and the run prompt. */
export function derivationStageLabels(ids: readonly DerivationStageId[]): string[] {
  return ids.map((id) => DERIVATION_STAGES.find((s) => s.id === id)?.label ?? id);
}

/**
 * Age of the oldest document a stage has not yet processed, in ms — the
 * stage's queueing latency at its head, which is what an operator watches
 * against a derivation SLA. Null when the stage has no backlog.
 *
 * Measured from `ingested_at` (when the row landed) rather than the source
 * timestamp, so a history backfill of old mail doesn't read as a stalled
 * pipeline.
 */
export function oldestPendingDerivationMs(
  db: Db,
  stage: DerivationStage,
  now: number,
): number | null {
  const row = db
    .prepare<
      [],
      { oldest: string | null }
    >(`SELECT MIN(ingested_at) AS oldest FROM documents WHERE ${stage.column} IS NULL`)
    .get();
  if (!row?.oldest) return null;
  const parsed = Date.parse(row.oldest);
  return Number.isNaN(parsed) ? null : Math.max(0, now - parsed);
}

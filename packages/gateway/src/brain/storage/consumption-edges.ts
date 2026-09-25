// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Consumption provenance — which briefs/loops were built on which annotation
 * PRIORS. One `cognition_consumption_edges` row per (prior annotation →
 * dependent brief/loop) pair, recorded mechanically by the steward tool
 * layer: "consumed" means the model explicitly declared that the annotation
 * materially informed that particular brief/loop mutation. The declaration
 * is accepted only when the prior was actually surfaced earlier in the run
 * (through `annotation_search`, a prompt-inlined prior, or self-memory).
 *
 * The edges are the teeth's lookup table: when a prior is invalidated or
 * superseded, the provenance-recheck sweep walks its LIVE dependents and
 * enqueues a re-examination instead of leaving them silently resting on a
 * dead belief. Edges reference their endpoints by id only (no FKs — briefs
 * and loops hard-delete on their own lifecycles, and a dangling edge is
 * simply never returned by the live-dependent reads).
 *
 * House style matches the sibling stores: plain functions over a
 * better-sqlite3 handle, explicit `now`, single-writer in production.
 */

import { randomUUID } from "node:crypto";
import { provenanceRecheckDedupeKey } from "../run-payloads.js";
import { getDocAnnotation } from "./annotations.js";
import { getPersonAnnotation } from "./person-annotations.js";
import { enqueueCognitionRun } from "./run-queue.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * DDL — idempotent, so it is called both from `runSchemaSetup` (fresh
 * installs) and from the numbered migration that introduced it (upgrades),
 * exactly like `createAnnotationStorageTables`.
 */
export function createConsumptionEdgesTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_consumption_edges (
      prior_store TEXT NOT NULL,
      prior_annotation_id TEXT NOT NULL,
      dependent_kind TEXT NOT NULL,
      dependent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (prior_store, prior_annotation_id, dependent_kind, dependent_id)
    )
  `);
  // "What was this brief/loop built on" — the recheck prompt's claim-time read.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cognition_consumption_dependent ON cognition_consumption_edges(dependent_kind, dependent_id)",
  );
}

/** Which annotation store a prior lives in. */
export type ConsumptionPriorStore = "doc" | "person";

/** What kind of cognition output depends on a prior. */
export type ConsumptionDependentKind = "brief" | "loop";

/** One prior→dependent edge as the tool layer records it. */
export interface ConsumptionEdgeInput {
  priorStore: ConsumptionPriorStore;
  priorAnnotationId: string;
  dependentKind: ConsumptionDependentKind;
  dependentId: string;
  /** The first run known to have made this dependent rely on the prior. */
  runId: string;
}

/** Priors selected by one output mutation, before its dependent id is known. */
export interface ConsumptionDependencyContext {
  priors: readonly {
    priorStore: ConsumptionPriorStore;
    priorAnnotationId: string;
  }[];
  runId: string;
}

export type ConsumptionMutationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      dead: Array<{ priorStore: ConsumptionPriorStore; priorAnnotationId: string }>;
    };

/**
 * Record a batch of edges in one transaction. `INSERT OR IGNORE` on the
 * (prior, dependent) tuple: re-recording the same dependency — a later
 * update of the same brief in the same run, or a retried run — is a no-op,
 * and the FIRST run to record the pair keeps the attribution. Returns how
 * many edges were newly inserted.
 */
export function recordConsumptionEdges(
  db: Db,
  edges: readonly ConsumptionEdgeInput[],
  now: number,
): number {
  if (edges.length === 0) return 0;
  const insert = db.prepare<[string, string, string, string, string, number]>(
    `INSERT OR IGNORE INTO cognition_consumption_edges
       (prior_store, prior_annotation_id, dependent_kind, dependent_id, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction((): number => {
    let inserted = 0;
    for (const e of edges) {
      inserted += insert.run(
        e.priorStore,
        e.priorAnnotationId,
        e.dependentKind,
        e.dependentId,
        e.runId,
        now,
      ).changes;
    }
    return inserted;
  });
  return txn();
}

/**
 * Validate selected priors, mutate one output, and insert its edges in one
 * writer transaction. This closes the invalidation race between a dependent
 * write and its provenance becoming visible to the recheck sweep.
 */
export function mutateWithConsumptionDependencies<T>(
  db: Db,
  context: ConsumptionDependencyContext,
  dependentKind: ConsumptionDependentKind,
  dependentId: string,
  now: number,
  mutate: () => T,
): ConsumptionMutationResult<T> {
  const txn = db.transaction((): ConsumptionMutationResult<T> => {
    const dead = context.priors.filter(({ priorStore, priorAnnotationId }) => {
      const annotation =
        priorStore === "doc"
          ? getDocAnnotation(db, priorAnnotationId)
          : getPersonAnnotation(db, priorAnnotationId);
      return annotation === null || annotation.invalidatedAt !== null;
    });
    if (dead.length > 0) return { ok: false, dead: [...dead] };

    const value = mutate();
    if (value !== null) {
      recordConsumptionEdges(
        db,
        context.priors.map((prior) => ({
          ...prior,
          dependentKind,
          dependentId,
          runId: context.runId,
        })),
        now,
      );
    }
    return { ok: true, value };
  });
  return txn();
}

/**
 * Hard-retract one annotation and durably enqueue rechecks for every live
 * output that consumed it, in the same writer transaction. The historical
 * edges deliberately remain: once the annotation row is gone they are the
 * claim-time signal that the prior was hard-retracted, and the recheck prompt
 * renders them without retaining the deleted claim text.
 *
 * Serializing the dependent read, delete, and outbox inserts with output
 * mutations closes both races: an output committed first is captured here;
 * an output attempted after this transaction observes a missing prior and is
 * refused by `mutateWithConsumptionDependencies`.
 */
export function retractAnnotationWithDependentRechecks(
  db: Db,
  store: ConsumptionPriorStore,
  annotationId: string,
  now: number,
  retract: () => boolean,
): boolean {
  const txn = db.transaction((): boolean => {
    const dependents = listLiveDependentsForAnnotation(db, store, annotationId);
    if (!retract()) return false;
    for (const dependent of dependents) {
      enqueueCognitionRun(
        db,
        {
          id: `run_${randomUUID()}`,
          kind: "feedback",
          payload: {
            recheckDependentKind: dependent.kind,
            recheckDependentId: dependent.id,
            recheckGeneration: randomUUID(),
          },
          dedupeKey: provenanceRecheckDedupeKey(dependent.kind, dependent.id),
        },
        now,
      );
    }
    return true;
  });
  return txn();
}

/**
 * One-time upgrade repair for hard retracts performed before they had a
 * transactional recheck outbox. Missing priors retain only their edge ids;
 * enqueueing by live dependent is enough because the prompt re-reads every
 * consumed prior and renders missing rows as hard-retracted.
 */
export function enqueueRechecksForMissingConsumptionPriors(db: Db, now: number): number {
  const dependents = db
    .prepare<[], { dependent_kind: string; dependent_id: string }>(
      `SELECT DISTINCT e.dependent_kind, e.dependent_id
         FROM cognition_consumption_edges e
         LEFT JOIN doc_annotations d
           ON e.prior_store = 'doc' AND d.id = e.prior_annotation_id
         LEFT JOIN person_annotations p
           ON e.prior_store = 'person' AND p.id = e.prior_annotation_id
         LEFT JOIN briefs b
           ON e.dependent_kind = 'brief' AND b.id = e.dependent_id
         LEFT JOIN open_loops l
           ON e.dependent_kind = 'loop' AND l.id = e.dependent_id
        WHERE ((e.prior_store = 'doc' AND d.id IS NULL)
            OR (e.prior_store = 'person' AND p.id IS NULL))
          AND (b.id IS NOT NULL OR l.id IS NOT NULL)`,
    )
    .all();
  for (const dependent of dependents) {
    const kind = dependent.dependent_kind as ConsumptionDependentKind;
    enqueueCognitionRun(
      db,
      {
        id: `run_${randomUUID()}`,
        kind: "feedback",
        payload: {
          recheckDependentKind: kind,
          recheckDependentId: dependent.dependent_id,
          recheckGeneration: randomUUID(),
        },
        dedupeKey: provenanceRecheckDedupeKey(kind, dependent.dependent_id),
      },
      now,
    );
  }
  return dependents.length;
}

/** One live dependent of a prior, title-enriched for the operator surface. */
export interface ConsumptionDependentRow {
  kind: ConsumptionDependentKind;
  id: string;
  runId: string;
  createdAt: number;
  /** The dependent brief/loop's current title. */
  title: string;
}

/**
 * The LIVE dependents of one annotation — edges whose brief/loop row still
 * exists (a hard-deleted dependent simply drops out; its edge is inert).
 * Newest-recorded first.
 */
export function listLiveDependentsForAnnotation(
  db: Db,
  store: ConsumptionPriorStore,
  annotationId: string,
  options: {
    limit?: number;
    before?: { createdAt: number; kind: ConsumptionDependentKind; id: string };
  } = {},
): ConsumptionDependentRow[] {
  const cursor = options.before
    ? `AND (
         e.created_at < ?
         OR (e.created_at = ? AND e.dependent_kind > ?)
         OR (e.created_at = ? AND e.dependent_kind = ? AND e.dependent_id > ?)
       )`
    : "";
  const params: Array<string | number> = [store, annotationId];
  if (options.before) {
    params.push(
      options.before.createdAt,
      options.before.createdAt,
      options.before.kind,
      options.before.createdAt,
      options.before.kind,
      options.before.id,
    );
  }
  const limit = options.limit === undefined ? "" : "LIMIT ?";
  if (options.limit !== undefined) params.push(options.limit);
  return db
    .prepare<
      (string | number)[],
      {
        dependent_kind: string;
        dependent_id: string;
        run_id: string;
        created_at: number;
        title: string;
      }
    >(
      `SELECT e.dependent_kind, e.dependent_id, e.run_id, e.created_at,
              COALESCE(b.title, l.title) AS title
         FROM cognition_consumption_edges e
         LEFT JOIN briefs b ON e.dependent_kind = 'brief' AND b.id = e.dependent_id
         LEFT JOIN open_loops l ON e.dependent_kind = 'loop' AND l.id = e.dependent_id
        WHERE e.prior_store = ? AND e.prior_annotation_id = ?
          AND (b.id IS NOT NULL OR l.id IS NOT NULL)
          ${cursor}
        ORDER BY e.created_at DESC, e.dependent_kind ASC, e.dependent_id ASC
        ${limit}`,
    )
    .all(...params)
    .map((r) => ({
      kind: r.dependent_kind as ConsumptionDependentKind,
      id: r.dependent_id,
      runId: r.run_id,
      createdAt: r.created_at,
      title: r.title,
    }));
}

/** Count live dependents without materialising their titles/payloads. */
export function countLiveDependentsForAnnotation(
  db: Db,
  store: ConsumptionPriorStore,
  annotationId: string,
): number {
  return (
    db
      .prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n
           FROM cognition_consumption_edges e
           LEFT JOIN briefs b ON e.dependent_kind = 'brief' AND b.id = e.dependent_id
           LEFT JOIN open_loops l ON e.dependent_kind = 'loop' AND l.id = e.dependent_id
          WHERE e.prior_store = ? AND e.prior_annotation_id = ?
            AND (b.id IS NOT NULL OR l.id IS NOT NULL)`,
      )
      .get(store, annotationId)?.n ?? 0
  );
}

/** One consumed prior of a dependent, with its current lifecycle state. */
export interface ConsumedPriorRow {
  store: ConsumptionPriorStore;
  annotationId: string;
  /** False when the prior was invalidated/superseded (or hard-retracted). */
  live: boolean;
  /** Claim fields, still readable on soft-dead rows; null after a retract. */
  claimType: string | null;
  claimText: string | null;
  /** The successor annotation when the prior was superseded; else null. */
  supersededBy: string | null;
}

/**
 * Every prior a dependent consumed, joined to the prior's CURRENT lifecycle
 * state — the provenance-recheck prompt's claim-time read, so the run judges
 * present reality (which priors are dead NOW), not a snapshot from enqueue
 * time. A hard-retracted prior surfaces as dead with null claim fields.
 */
export function listConsumedPriorsForDependent(
  db: Db,
  kind: ConsumptionDependentKind,
  dependentId: string,
): ConsumedPriorRow[] {
  return db
    .prepare<
      [string, string],
      {
        prior_store: string;
        prior_annotation_id: string;
        invalidated_at: number | null;
        known: number;
        claim_type: string | null;
        claim_text: string | null;
        superseded_by: string | null;
      }
    >(
      `SELECT e.prior_store, e.prior_annotation_id,
              COALESCE(d.invalidated_at, p.invalidated_at) AS invalidated_at,
              (d.id IS NOT NULL OR p.id IS NOT NULL) AS known,
              COALESCE(d.claim_type, p.claim_type) AS claim_type,
              COALESCE(d.claim_text, p.claim_text) AS claim_text,
              COALESCE(d.superseded_by, p.superseded_by) AS superseded_by
         FROM cognition_consumption_edges e
         LEFT JOIN doc_annotations d ON e.prior_store = 'doc' AND d.id = e.prior_annotation_id
         LEFT JOIN person_annotations p ON e.prior_store = 'person' AND p.id = e.prior_annotation_id
        WHERE e.dependent_kind = ? AND e.dependent_id = ?
        ORDER BY e.created_at ASC`,
    )
    .all(kind, dependentId)
    .map((r) => ({
      store: r.prior_store as ConsumptionPriorStore,
      annotationId: r.prior_annotation_id,
      live: r.known !== 0 && r.invalidated_at === null,
      claimType: r.claim_type,
      claimText: r.claim_text,
      supersededBy: r.superseded_by,
    }));
}

/** One newly-dead prior with a live dependent — the recheck sweep's unit. */
export interface DeadPriorDependentRow {
  priorStore: ConsumptionPriorStore;
  priorAnnotationId: string;
  /** When the prior died (its `invalidated_at`). */
  invalidatedAt: number;
  dependentKind: ConsumptionDependentKind;
  dependentId: string;
}

/**
 * Priors that died (invalidated OR superseded — both stamp `invalidated_at`)
 * inside the (`sinceExclusive`, `until`] window and still have LIVE
 * dependents, ordered oldest death first — the provenance-recheck sweep's
 * watermark scan. Hard retracts leave no row to join and are handled
 * synchronously by `retractAnnotationWithDependentRechecks` instead.
 */
export function listDeadPriorDependents(
  db: Db,
  opts: { sinceExclusive: number; until: number },
): DeadPriorDependentRow[] {
  const one = (store: ConsumptionPriorStore, table: string): DeadPriorDependentRow[] =>
    db
      .prepare<
        [number, number],
        {
          prior_annotation_id: string;
          invalidated_at: number;
          dependent_kind: string;
          dependent_id: string;
        }
      >(
        `SELECT e.prior_annotation_id, a.invalidated_at, e.dependent_kind, e.dependent_id
           FROM cognition_consumption_edges e
           JOIN ${table} a ON a.id = e.prior_annotation_id
           LEFT JOIN briefs b ON e.dependent_kind = 'brief' AND b.id = e.dependent_id
           LEFT JOIN open_loops l ON e.dependent_kind = 'loop' AND l.id = e.dependent_id
          WHERE e.prior_store = '${store}'
            AND a.invalidated_at IS NOT NULL AND a.invalidated_at > ? AND a.invalidated_at <= ?
            AND (b.id IS NOT NULL OR l.id IS NOT NULL)`,
      )
      .all(opts.sinceExclusive, opts.until)
      .map((r) => ({
        priorStore: store,
        priorAnnotationId: r.prior_annotation_id,
        invalidatedAt: r.invalidated_at,
        dependentKind: r.dependent_kind as ConsumptionDependentKind,
        dependentId: r.dependent_id,
      }));
  return [...one("doc", "doc_annotations"), ...one("person", "person_annotations")].sort(
    (a, b) => a.invalidatedAt - b.invalidatedAt,
  );
}

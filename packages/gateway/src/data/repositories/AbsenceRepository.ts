// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pending absences — what the gateway does when a source's snapshot stops
 * naming a document it holds.
 *
 * A source that sends `presentExternalIds` is asserting completeness: "here is
 * everything that exists". The assertion is honest about the source's *read*,
 * not about the world. An Apple Notes database opened while Spotlight holds it,
 * a Things store mid-migration, a permission that lapsed between syncs — each
 * yields a page that is small and, on its own terms, complete. That page is
 * indistinguishable from a genuine mass deletion, and the two outcomes are not
 * symmetric: declining to delete costs a delay, deleting costs the corpus.
 *
 * So an omission is recorded here rather than applied. The record carries a
 * deadline in two currencies at once, and both must be spent:
 *
 *   - **Corroboration** — `minObservations` separate snapshots must all omit
 *     the document. A source that stops before enough corroborating snapshots
 *     cannot delete anything, however long it sits.
 *   - **Elapsed time** — `minAge` must have passed since the first omission.
 *     A source syncing every 30 seconds cannot spend three observations in
 *     ninety seconds and call it corroboration.
 *
 * A snapshot that names the document again drops its row, and the clock starts
 * over if it goes missing later. Once both currencies are spent the document is
 * deleted through the ordinary path with the ordinary cascade — the delay is
 * the whole of the difference, not a softer consequence.
 *
 * Two deletion channels bypass this entirely and still apply at once: a user
 * asking for a deletion, and a source sending `deletedExternalIds` — a
 * tombstone, which is the source asserting that a deletion happened rather
 * than leaving the gateway to infer one.
 */

import { createLogger } from "@omnesis/core";
import { getWipeEpoch, resetAllMemberCursors } from "./SyncStateRepository.js";
import { listDisputedExternalIds, recordDeletionClaims } from "./ReplicaDeletionClaimRepository.js";
import type { Db } from "../types.js";

const log = createLogger("gateway").child("absence");

/**
 * How many absence-deletion batches the audit trail keeps. Enough to
 * reconstruct what a source removed over weeks of syncing without letting the
 * table grow without bound; the sweep prunes past it as it appends.
 */
export const SNAPSHOT_ABSENCE_AUDIT_KEEP = 500;

/**
 * Ids per `IN (...)` statement. Well below SQLite's per-statement variable
 * limit, and the same size the document delete path uses, so an absence
 * statement is never the longest thing in a writer transaction.
 */
const ABSENCE_IN_LIST_CHUNK = 500;

/** Maximum row mutations one snapshot may add to its cursor transaction. */
export const ABSENCE_WRITER_CHUNK = 200;

/** Keep completed-attempt receipts long enough to cover delayed transport retries. */
const OBSERVATION_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** The thresholds an absence must clear before it deletes. */
export interface SnapshotAbsencePolicy {
  /** Snapshots that must all omit a document. `gateway.snapshotAbsence.minObservations`. */
  minObservations: number;
  /** Elapsed ms since the first omission. `gateway.snapshotAbsence.minAge`. */
  minAgeMs: number;
  /** Ceiling on absences one snapshot may record. `gateway.snapshotAbsence.maxMarksPerSnapshot`. */
  maxMarksPerSnapshot: number;
}

/**
 * The minimum gap between two counted observations of the same absence.
 *
 * `observations` is meant to count *snapshots*, and a source is free to sync as
 * often as it likes — a 30-second cadence would otherwise reach any
 * corroboration count within minutes and reduce the rule to its wall-clock half.
 * Deriving the spacing from the two configured bounds rather than adding a
 * third knob keeps them consistent by construction: reaching `minObservations`
 * counted observations necessarily spans about `minAge`.
 */
export function observationSpacingMs(policy: SnapshotAbsencePolicy): number {
  return Math.floor(policy.minAgeMs / Math.max(1, policy.minObservations));
}

/** Where a snapshot applies, and what the page carrying it is about to store. */
export interface SnapshotAbsenceScope {
  /** The stream the snapshot describes; `""` for a source with one stream. */
  streamId?: string;
  /** The instant to judge the snapshot against. Defaults to now. */
  now?: number;
  /**
   * External ids the page carrying this snapshot is about to upsert. The diff
   * runs before the write, so these are held-but-not-yet-stored and must not be
   * counted as missing from the corpus.
   */
  arrivingExternalIds?: readonly string[];
  /** Stable identity of this completed sync attempt; retries add no evidence. */
  observationId?: string;
  /**
   * The device whose snapshot this is. Remembered on each absence it marks or
   * corroborates, so a deletion the sweep later makes on a replicated source
   * is recorded as that member's verdict.
   */
  observedBy?: string;
  /**
   * The partitions the snapshot vouches for, when it is a per-partition claim
   * rather than a whole-source enumeration.
   *
   * `undefined` means the enumeration covers the source: every document in the
   * stream is judged against it, which is the shape every source used before
   * partitions existed and still the shape of one with a single backing store.
   *
   * A list means the source read exactly these partitions in full, so only
   * documents whose `partition_key` is one of them may be marked absent.
   * Everything else — including documents in a partition the source could not
   * read this cycle — is untouched. Withholding the whole snapshot buys the
   * same protection, and pays for it with the partitions that were readable.
   */
  claimedPartitions?: readonly string[];
}

/** One document whose absence this snapshot records or corroborates. */
export interface AbsenceMark {
  documentId: string;
  externalId: string;
}

/**
 * What a snapshot changes about a source's pending absences, plus what the
 * snapshot said about the corpus. Computed off the writer from a read-only
 * handle; `applySnapshotAbsencePlan` is the writer half.
 */
export interface SnapshotAbsencePlan {
  providerId: string;
  sourceId: string;
  streamId: string;
  /** Scope generation read with this plan; stale plans are rejected by the writer. */
  generation: number;
  /** Scope reconcile revision read with this plan; every applied snapshot advances it. */
  revision: number;
  /** Stable completed-attempt identity, when the caller supplied one. */
  observationId?: string;
  /** Documents to record or corroborate as absent. Bounded by `maxMarksPerSnapshot`. */
  mark: AbsenceMark[];
  /** Bounded pending absences the writer can clear directly. */
  clearDocumentIds: string[];
  /** Every active pending absence the snapshot revoked. */
  clearCount: number;
  /**
   * True when revocation uses an O(1) generation advance instead of the id
   * list.
   *
   * The generation lives on the `(provider, source, stream)` scope, so the
   * advance also invalidates pending absences in partitions this plan never
   * read. That is deliberate: it resets their clocks, which delays a deletion
   * and never causes one, and the alternative — leaving a revoked deadline
   * standing because the id list was full — deletes a document the source
   * just said it still holds.
   */
  invalidateGeneration: boolean;
  /** Stored documents the snapshot omitted. */
  absentCount: number;
  /** Omissions left unrecorded because the snapshot hit the mark ceiling. */
  deferredCount: number;
  /**
   * Ids the snapshot named that the corpus does not hold — a source claiming
   * documents the gateway does not have. The one reading a healthy no-op
   * cannot produce, and the only signal that says the corpus, rather than the
   * source, is what lost something.
   */
  missingCount: number;
  /** Documents stored for this `(provider, source, stream)`. */
  storedCount: number;
  /** Distinct ids the snapshot named. */
  snapshotCount: number;
  /** The instant the plan judged the snapshot against. */
  observedAt: number;
  /** The device whose snapshot this plan describes; `''` when not a member's own row. */
  observedBy: string;
}

interface AbsenceRow {
  document_id: string;
  last_absent_at: number;
}

function absenceScope(
  db: Db,
  providerId: string,
  sourceId: string,
  streamId: string,
): { generation: number; revision: number } {
  const row = db
    .prepare<
      [string, string, string],
      { generation: number; revision: number }
    >("SELECT generation, revision FROM document_absence_scopes WHERE provider_id = ? AND source_id = ? AND stream_id = ?")
    .get(providerId, sourceId, streamId);
  return row === undefined
    ? { generation: 0, revision: 0 }
    : { generation: row.generation, revision: row.revision };
}

/**
 * Diff a snapshot against the stored corpus and decide what changes about the
 * source's pending absences. Pure SELECTs, no transaction, no writes — shaped
 * for the IO worker's read-only handle so the scan never parks the writer.
 *
 * Reappearance is deliberately cheap: only rows that already exist in
 * `document_absences` for this `(provider, source, stream)` are read, and only
 * those the snapshot names again are cleared. The incoming snapshot's ids are
 * never written or looked up one by one, so a healthy source enumerating
 * 200,000 unchanged ids costs one scan and no writes at all.
 */
export function computeSnapshotAbsencePlan(
  db: Db,
  providerId: string,
  sourceId: string,
  presentExternalIds: readonly string[],
  policy: SnapshotAbsencePolicy,
  opts: SnapshotAbsenceScope = {},
): SnapshotAbsencePlan {
  const streamId = opts.streamId ?? "";
  const now = opts.now ?? Date.now();
  const arriving = opts.arrivingExternalIds;
  const { generation, revision } = absenceScope(db, providerId, sourceId, streamId);
  const presentSet = new Set(presentExternalIds);
  // Scoped to the claimed partitions when the snapshot is a claim, and to the
  // whole stream when it is not. The two use different indexes because they
  // ask different questions, and a source with one backing store must not pay
  // for a column it never names.
  const claimed = opts.claimedPartitions;
  const rows =
    claimed === undefined
      ? db
          .prepare<
            [string, string, string],
            { id: string; external_id: string }
          >("SELECT id, external_id FROM documents INDEXED BY idx_documents_provider_source_stream WHERE provider_id = ? AND source_id = ? AND stream_id = ? ORDER BY id")
          .all(providerId, sourceId, streamId)
      : claimed.length === 0
        ? []
        : db
            .prepare<unknown[], { id: string; external_id: string }>(
              `SELECT id, external_id FROM documents INDEXED BY idx_documents_provider_source_stream_partition
                WHERE provider_id = ? AND source_id = ? AND stream_id = ?
                  AND partition_key IN (${claimed.map(() => "?").join(", ")})
                ORDER BY id`,
            )
            .all(providerId, sourceId, streamId, ...claimed);

  const pending = new Map<string, number>();
  for (const row of db
    .prepare<
      [string, string, string, number],
      AbsenceRow
    >("SELECT document_id, last_absent_at FROM document_absences INDEXED BY idx_document_absences_scope WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND generation = ?")
    .all(providerId, sourceId, streamId, generation)) {
    pending.set(row.document_id, row.last_absent_at);
  }

  const spacingMs = observationSpacingMs(policy);
  const freshMarks: AbsenceMark[] = [];
  const corroborations: AbsenceMark[] = [];
  const clearDocumentIds: string[] = [];
  let clearCount = 0;
  const stored = new Set<string>();
  let absentCount = 0;

  for (const row of rows) {
    stored.add(row.external_id);
    if (presentSet.has(row.external_id)) {
      // Reappearance revokes the deadline outright: the source now says the
      // document exists, which is the same class of assertion that took it
      // away. A later omission starts a fresh clock rather than resuming.
      if (pending.has(row.id)) {
        clearCount += 1;
        if (clearDocumentIds.length < ABSENCE_WRITER_CHUNK) clearDocumentIds.push(row.id);
      }
      continue;
    }
    absentCount += 1;
    const lastAbsentAt = pending.get(row.id);
    // Already corroborated within the spacing window — this snapshot adds no
    // independent evidence, so it writes nothing.
    if (lastAbsentAt === undefined) {
      freshMarks.push({ documentId: row.id, externalId: row.external_id });
    } else if (now - lastAbsentAt >= spacingMs) {
      corroborations.push({ documentId: row.id, externalId: row.external_id });
    }
  }

  // A ceiling must not let the same early rows consume every snapshot forever.
  // First observations advance across the source before already-known rows are
  // corroborated; stable document order makes that progression deterministic.
  const eligibleMarks = [...freshMarks, ...corroborations];
  const markLimit = Math.min(policy.maxMarksPerSnapshot, ABSENCE_WRITER_CHUNK);
  const mark = eligibleMarks.slice(0, markLimit);
  const deferredCount = Math.max(0, eligibleMarks.length - mark.length);

  // The page's own documents are counted as held: the plan is computed before
  // they are written, so without this every bootstrap page would read as the
  // corpus having lost exactly what the source just delivered — and the number
  // that is supposed to detect a lost corpus would be noise on every source's
  // first sync.
  if (arriving) for (const externalId of arriving) stored.add(externalId);
  let missingCount = 0;
  for (const externalId of presentSet) {
    if (!stored.has(externalId)) missingCount += 1;
  }

  return {
    providerId,
    sourceId,
    streamId,
    generation,
    revision,
    ...(opts.observationId === undefined ? {} : { observationId: opts.observationId }),
    mark,
    clearDocumentIds,
    clearCount,
    invalidateGeneration: clearCount > ABSENCE_WRITER_CHUNK,
    absentCount,
    deferredCount,
    missingCount,
    storedCount: rows.length,
    snapshotCount: presentSet.size,
    observedAt: now,
    observedBy: opts.observedBy ?? "",
  };
}

/**
 * Revoke pending deadlines for documents that just arrived from their source.
 *
 * A complete snapshot is not the only positive evidence that an item exists:
 * an incremental or recovery page carrying the item itself is stronger still.
 * This runs after the documents are upserted, in the same transaction, and
 * advances the scope revision for every non-empty arrival group — even when
 * there was no mark to clear — so an older off-writer snapshot plan cannot
 * subsequently apply against the newer positive evidence.
 */
export function clearDocumentAbsencesForArrivals(
  db: Db,
  documents: ReadonlyArray<{ providerId: string; sourceId: string; externalId: string }>,
  streams: Readonly<Record<string, string>> = {},
  expectedScope?: {
    providerId: string;
    sourceId: string;
    streamId: string;
    generation: number;
    revision: number;
  },
): {
  cleared: number;
  expectedScope?: typeof expectedScope;
  expectedScopeInvalidated: boolean;
} {
  const groups = new Map<
    string,
    { providerId: string; sourceId: string; streamId: string; externalIds: string[] }
  >();
  for (const document of documents) {
    const streamId = streams[document.sourceId] ?? "";
    const groupKey = `${document.providerId}\0${document.sourceId}\0${streamId}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        providerId: document.providerId,
        sourceId: document.sourceId,
        streamId,
        externalIds: [],
      };
      groups.set(groupKey, group);
    }
    group.externalIds.push(document.externalId);
  }

  let cleared = 0;
  let nextExpectedScope = expectedScope;
  let expectedScopeInvalidated = false;
  for (const group of groups.values()) {
    const currentScope = absenceScope(db, group.providerId, group.sourceId, group.streamId);
    const isExpectedScope =
      nextExpectedScope !== undefined &&
      nextExpectedScope.providerId === group.providerId &&
      nextExpectedScope.sourceId === group.sourceId &&
      nextExpectedScope.streamId === group.streamId;
    if (
      isExpectedScope &&
      (nextExpectedScope!.generation !== currentScope.generation ||
        nextExpectedScope!.revision !== currentScope.revision)
    ) {
      nextExpectedScope = undefined;
      expectedScopeInvalidated = true;
    }
    let groupCleared = 0;
    const externalIds = [...new Set(group.externalIds)];
    for (let i = 0; i < externalIds.length; i += ABSENCE_WRITER_CHUNK) {
      const chunk = externalIds.slice(i, i + ABSENCE_WRITER_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      groupCleared += db
        .prepare(
          `DELETE FROM document_absences
            WHERE document_id IN (
              SELECT id FROM documents
               WHERE provider_id = ? AND source_id = ? AND stream_id = ?
                 AND external_id IN (${placeholders})
            )
              AND generation = COALESCE((
                SELECT generation FROM document_absence_scopes
                 WHERE provider_id = ? AND source_id = ? AND stream_id = ?
              ), -1)`,
        )
        .run(
          group.providerId,
          group.sourceId,
          group.streamId,
          ...chunk,
          group.providerId,
          group.sourceId,
          group.streamId,
        ).changes;
    }
    const nextRevision = currentScope.revision + 1;
    db.prepare(
      `INSERT INTO document_absence_scopes
         (provider_id, source_id, stream_id, generation, revision)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, source_id, stream_id) DO UPDATE SET
         generation = excluded.generation,
         revision = excluded.revision`,
    ).run(group.providerId, group.sourceId, group.streamId, currentScope.generation, nextRevision);
    if (isExpectedScope && !expectedScopeInvalidated) {
      nextExpectedScope = { ...nextExpectedScope!, revision: nextRevision };
    }
    cleared += groupCleared;
  }
  return {
    cleared,
    ...(nextExpectedScope === undefined ? {} : { expectedScope: nextExpectedScope }),
    expectedScopeInvalidated,
  };
}

/** What `applySnapshotAbsencePlan` changed. */
export interface SnapshotAbsenceApplied {
  marked: number;
  cleared: number;
}

/**
 * Writer half of the snapshot reconcile: clear the absences the snapshot
 * revoked, record or corroborate the ones it asserts.
 *
 * Marks and ordinary clears are hard-capped to one writer chunk. A recovery
 * that names more pending rows cannot leave the excess deadlines ageing, so it
 * advances the scope generation in one row instead: every old mark becomes
 * ineligible immediately, then fixed-size cleanup drips reclaim the stale rows
 * on later snapshots. The transaction's work is therefore fixed even for a
 * whole-source recovery.
 *
 * Runs inside whatever transaction the caller holds — the sync page's write is
 * atomic, so a page's documents and the absences its snapshot implies commit
 * together or not at all.
 */
export function applySnapshotAbsencePlan(
  db: Db,
  plan: SnapshotAbsencePlan,
  expectedWipeEpoch?: number,
  cursorRow = "",
): SnapshotAbsenceApplied {
  // #551: a wipe between the diff and here replaced the source's corpus, so the
  // plan describes documents that no longer stand for anything. A re-bootstrap
  // re-derives the same document ids, so the foreign-key guard below would not
  // catch it — the epoch is the only thing that can.
  if (
    expectedWipeEpoch !== undefined &&
    getWipeEpoch(db, plan.sourceId, cursorRow) !== expectedWipeEpoch
  ) {
    return { marked: 0, cleared: 0 };
  }
  const currentScope = absenceScope(db, plan.providerId, plan.sourceId, plan.streamId);
  if (plan.observationId !== undefined) {
    const received = db
      .prepare<
        [string, string, string, string],
        { found: number }
      >("SELECT 1 AS found FROM document_absence_observations WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND observation_id = ?")
      .get(plan.providerId, plan.sourceId, plan.streamId, plan.observationId);
    if (received !== undefined) return { marked: 0, cleared: 0 };
  }
  if (plan.observationId !== undefined) {
    // Claim the source observation before validating the plan revision. The
    // identity belongs to the snapshot, not this writer attempt: if newer
    // positive evidence superseded its plan, retrying the same old omission
    // must not replan it against that newer row.
    db.prepare(
      `INSERT INTO document_absence_observations
         (provider_id, source_id, stream_id, observation_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(plan.providerId, plan.sourceId, plan.streamId, plan.observationId, plan.observedAt);
    // Receipt retention is time-bounded, and each reconcile reclaims only a
    // fixed tranche so an idle backlog cannot turn one cursor write unbounded.
    db.prepare(
      `DELETE FROM document_absence_observations
        WHERE rowid IN (
          SELECT rowid FROM document_absence_observations
           WHERE created_at < ? ORDER BY created_at LIMIT ?
        )`,
    ).run(plan.observedAt - OBSERVATION_RECEIPT_RETENTION_MS, ABSENCE_WRITER_CHUNK);
  }
  if (currentScope.generation !== plan.generation || currentScope.revision !== plan.revision) {
    return { marked: 0, cleared: 0 };
  }

  const writeGeneration = currentScope.generation + (plan.invalidateGeneration ? 1 : 0);
  const claimed = db
    .prepare<[string, string, string, number, number, number, number], { generation: number }>(
      `INSERT INTO document_absence_scopes
         (provider_id, source_id, stream_id, generation, revision)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, source_id, stream_id) DO UPDATE SET
         generation = excluded.generation,
         revision = excluded.revision
       WHERE document_absence_scopes.generation = ?
         AND document_absence_scopes.revision = ?
       RETURNING generation`,
    )
    .get(
      plan.providerId,
      plan.sourceId,
      plan.streamId,
      writeGeneration,
      plan.revision + 1,
      plan.generation,
      plan.revision,
    );
  if (claimed === undefined) return { marked: 0, cleared: 0 };

  let cleared = 0;
  if (plan.invalidateGeneration) {
    // A mass recovery must revoke every old deadline immediately, but deleting
    // every mark would make the cursor transaction proportional to the source.
    // Advancing the scope generation invalidates the whole old set in one row;
    // stale rows are ignored by both planning and sweeping and are overwritten
    // if that document is absent again later. A partition-scoped plan advances
    // the same stream-wide counter — see `invalidateGeneration`.
    cleared = plan.clearCount;
  } else {
    if (plan.clearDocumentIds.length > 0) {
      const placeholders = plan.clearDocumentIds.map(() => "?").join(", ");
      cleared = db
        .prepare(
          `DELETE FROM document_absences
            WHERE generation = ? AND document_id IN (${placeholders})`,
        )
        .run(currentScope.generation, ...plan.clearDocumentIds).changes;
    }
  }

  // One statement covers both a first sighting and a corroboration: the insert
  // starts the clock, the conflict arm advances the count and the last-seen
  // stamp while leaving `first_absent_at` — the deadline's origin — alone.
  //
  // The `EXISTS` guard is what makes the plan safe to apply out of band. The
  // diff runs on a read handle, so between it and this write the same page's
  // tombstones may have removed a document the snapshot also omitted, or a user
  // may have deleted one outright. Marking a row that is already gone would
  // fail the foreign key and take the whole page's write down with it; skipping
  // it is the right answer anyway, since the deletion the mark was heading
  // towards has already happened.
  const upsert = db.prepare(
    `INSERT INTO document_absences
       (document_id, provider_id, source_id, stream_id, external_id, generation,
        first_absent_at, last_absent_at, observations, observed_by)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
      WHERE EXISTS (SELECT 1 FROM documents WHERE id = ?)
     ON CONFLICT(document_id) DO UPDATE SET
       observations = CASE
         WHEN generation = excluded.generation THEN observations + 1 ELSE 1 END,
       first_absent_at = CASE
         WHEN generation = excluded.generation THEN first_absent_at ELSE excluded.first_absent_at END,
       last_absent_at = excluded.last_absent_at,
       observed_by = CASE
         WHEN excluded.observed_by = '' THEN observed_by ELSE excluded.observed_by END,
       generation = excluded.generation,
       provider_id = excluded.provider_id,
       source_id = excluded.source_id,
       stream_id = excluded.stream_id,
       external_id = excluded.external_id`,
  );
  let marked = 0;
  for (const entry of plan.mark) {
    const { changes } = upsert.run(
      entry.documentId,
      plan.providerId,
      plan.sourceId,
      plan.streamId,
      entry.externalId,
      writeGeneration,
      plan.observedAt,
      plan.observedAt,
      plan.observedBy,
      entry.documentId,
    );
    marked += changes;
  }

  return { marked, cleared };
}

/** A pending absence that has spent both of its deadlines. */
export interface DueAbsence {
  documentId: string;
  providerId: string;
  sourceId: string;
  streamId: string;
  externalId: string;
}

/**
 * The absences whose deadline has passed, oldest first, capped at `limit`.
 *
 * The scope table drives exact live-generation seeks through the composite
 * index, so invalidated rows are never walked while bounded cleanup catches up.
 * Pure SELECT — the sweep runs this on the IO worker.
 */
export function listDueAbsences(
  db: Db,
  opts: { dueBefore: number; minObservations: number; limit: number },
): DueAbsence[] {
  return db
    .prepare<
      [number, number, number],
      {
        document_id: string;
        provider_id: string;
        source_id: string;
        stream_id: string;
        external_id: string;
      }
    >(
      `SELECT a.document_id, a.provider_id, a.source_id, a.stream_id, a.external_id
         FROM document_absence_scopes AS s
         CROSS JOIN document_absences AS a INDEXED BY idx_document_absences_scope
        WHERE a.provider_id = s.provider_id AND a.source_id = s.source_id
          AND a.stream_id = s.stream_id AND a.generation = s.generation
          AND a.observations >= ? AND a.first_absent_at <= ?
        ORDER BY first_absent_at
        LIMIT ?`,
    )
    .all(opts.minObservations, opts.dueBefore, opts.limit)
    .map((row) => ({
      documentId: row.document_id,
      providerId: row.provider_id,
      sourceId: row.source_id,
      streamId: row.stream_id,
      externalId: row.external_id,
    }));
}

/** Pending absences across every source — the sweep's backlog reading. */
export function countPendingAbsences(db: Db): number {
  return (
    db
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n
           FROM document_absence_scopes AS s
           CROSS JOIN document_absences AS a INDEXED BY idx_document_absences_scope
          WHERE a.provider_id = s.provider_id AND a.source_id = s.source_id
            AND a.stream_id = s.stream_id AND a.generation = s.generation`,
      )
      .get()?.n ?? 0
  );
}

export interface StaleAbsenceCandidate {
  documentId: string;
  generation: number;
}

/** Select a bounded stale tail on a read handle. */
export function listStaleAbsences(db: Db, limit: number): StaleAbsenceCandidate[] {
  if (limit <= 0) return [];
  return db
    .prepare<[number], { document_id: string; generation: number }>(
      `SELECT a.document_id, a.generation
         FROM document_absence_scopes AS s
         CROSS JOIN document_absences AS a INDEXED BY idx_document_absences_scope
        WHERE a.provider_id = s.provider_id AND a.source_id = s.source_id
          AND a.stream_id = s.stream_id AND a.generation < s.generation
        LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({ documentId: row.document_id, generation: row.generation }));
}

/** Revalidate and reclaim exact stale candidates on the writer. */
export function reclaimStaleAbsences(db: Db, candidates: readonly StaleAbsenceCandidate[]): number {
  let reclaimed = 0;
  for (let i = 0; i < candidates.length; i += ABSENCE_IN_LIST_CHUNK) {
    const chunk = candidates.slice(i, i + ABSENCE_IN_LIST_CHUNK);
    const pairs = chunk.map(() => "(?, ?)").join(", ");
    reclaimed += db
      .prepare(
        `DELETE FROM document_absences AS a
          WHERE (a.document_id, a.generation) IN (${pairs})
            AND EXISTS (
              SELECT 1 FROM document_absence_scopes AS s
               WHERE s.provider_id = a.provider_id AND s.source_id = a.source_id
                 AND s.stream_id = a.stream_id AND a.generation < s.generation
            )`,
      )
      .run(...chunk.flatMap((row) => [row.documentId, row.generation])).changes;
  }
  return reclaimed;
}

/** What one batch of the absence sweep actually removed. */
export interface AbsenceSweepBatch {
  /** Document ids removed, for the index and cognitive-state cascades. */
  deletedDocumentIds: string[];
  /** Absences the writer found had been revoked since the read. */
  revoked: number;
  /** Replicated items left standing because another member disputes their deletion. */
  disputed: number;
  /** Durable work that must finish in the index and cognition stores. */
  cascade?: AbsenceCascade;
}

export interface AbsenceCascade {
  id: number;
  documentIds: string[];
  indexDone: boolean;
  cognitionDone: boolean;
}

/**
 * Record cross-store cleanup in the deleting transaction. The historical
 * outbox table also carries sync tombstones; the absence sweep drains both.
 */
export function enqueueDocumentCascade(
  db: Db,
  documentIds: readonly string[],
): AbsenceCascade | undefined {
  if (documentIds.length === 0) return undefined;
  const id = Number(
    db
      .prepare(
        `INSERT INTO snapshot_absence_cascade_outbox (created_at, document_ids)
       VALUES (?, ?)`,
      )
      .run(Date.now(), JSON.stringify(documentIds)).lastInsertRowid,
  );
  return { id, documentIds: [...documentIds], indexDone: false, cognitionDone: false };
}

export function listPendingAbsenceCascades(db: Db, limit: number): AbsenceCascade[] {
  return db
    .prepare<
      [number],
      { id: number; document_ids: string; index_done: number; cognition_done: number }
    >(
      `SELECT id, document_ids, index_done, cognition_done
         FROM snapshot_absence_cascade_outbox ORDER BY id LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      id: row.id,
      documentIds: JSON.parse(row.document_ids) as string[],
      indexDone: row.index_done !== 0,
      cognitionDone: row.cognition_done !== 0,
    }));
}

export function acknowledgeAbsenceCascade(db: Db, id: number, part: "index" | "cognition"): void {
  const column = part === "index" ? "index_done" : "cognition_done";
  db.transaction(() => {
    db.prepare(`UPDATE snapshot_absence_cascade_outbox SET ${column} = 1 WHERE id = ?`).run(id);
    db.prepare(
      "DELETE FROM snapshot_absence_cascade_outbox WHERE id = ? AND index_done = 1 AND cognition_done = 1",
    ).run(id);
  })();
}

/**
 * Spend the deadline on a batch of absences, atomically.
 *
 * The sweep reads its candidates on the IO worker, so by the time this runs a
 * snapshot may have named a document again (dropping its row) or a wipe may
 * have replaced the source's corpus wholesale. Deciding the question again here
 * — inside the transaction that does the deleting, against the absence rows as
 * they stand now — is what keeps a stale read from removing a document whose
 * deadline was revoked in the gap. Candidates are addressed by `document_id`
 * rather than by `(source, stream, external_id)`, so the delete can never match
 * a row other than the one the absence was recorded against.
 *
 * The audit rows are written in the same transaction as the deletion they
 * describe: an audit written separately is one a crash can lose exactly when it
 * is needed, and one that can be left behind describing a deletion that never
 * happened.
 */
/**
 * A device that no longer hosts the source is nobody's observer: the absences
 * its snapshots marked keep their deadline, but a deletion they lead to is not
 * recorded as its verdict — there would be no member left to withdraw it.
 * `deviceId` omitted forgets every observer of the source.
 */
export function forgetAbsenceObserver(db: Db, sourceId: string, deviceId?: string): void {
  if (deviceId === undefined) {
    db.prepare(
      "UPDATE document_absences SET observed_by = '' WHERE source_id = ? AND observed_by != ''",
    ).run(sourceId);
    return;
  }
  db.prepare(
    "UPDATE document_absences SET observed_by = '' WHERE source_id = ? AND observed_by = ?",
  ).run(sourceId, deviceId);
}

export function sweepDueAbsences(
  db: Db,
  documentIds: readonly string[],
  opts: {
    minObservations: number;
    dueBefore: number;
    now: number;
    /**
     * The document delete, injected rather than imported: this module is the
     * lower of the two and importing the document repository back would close a
     * cycle. Runs inside this function's transaction, so the deletion and the
     * audit row that describes it commit together.
     */
    deleteDocumentsByIds: (db: Db, documentIds: readonly string[]) => string[];
  },
): AbsenceSweepBatch {
  if (documentIds.length === 0) return { deletedDocumentIds: [], revoked: 0, disputed: 0 };
  const apply = db.transaction((): AbsenceSweepBatch => {
    let due: Array<{
      document_id: string;
      provider_id: string;
      source_id: string;
      stream_id: string;
      external_id: string;
      observed_by: string;
      multi_device_mode: string | null;
    }> = [];
    for (let i = 0; i < documentIds.length; i += ABSENCE_IN_LIST_CHUNK) {
      const chunk = documentIds.slice(i, i + ABSENCE_IN_LIST_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      due.push(
        ...db
          .prepare<
            unknown[],
            {
              document_id: string;
              provider_id: string;
              source_id: string;
              stream_id: string;
              external_id: string;
              observed_by: string;
              multi_device_mode: string | null;
            }
          >(
            `SELECT a.document_id, a.provider_id, a.source_id, a.stream_id, a.external_id,
                    a.observed_by, src.multi_device_mode
               FROM document_absences AS a
               JOIN document_absence_scopes AS s
                 ON s.provider_id = a.provider_id AND s.source_id = a.source_id
                AND s.stream_id = a.stream_id AND s.generation = a.generation
               LEFT JOIN sources AS src ON src.id = a.source_id
              WHERE a.document_id IN (${placeholders})
                AND a.first_absent_at <= ?
                AND a.observations >= ?`,
          )
          .all(...chunk, opts.dueBefore, opts.minObservations),
      );
    }
    // A replicated item another member restored after a deletion is in
    // dispute, and a dispute is settled by the members' verdicts, not by this
    // sweep: deleting it here would only reset every replica and start the
    // restore over. Its absence row is dropped instead; the next snapshot that
    // omits it records a fresh absence, so the deadline starts over rather
    // than staying due forever.
    const replicatedByScope = new Map<string, typeof due>();
    for (const row of due) {
      if (row.multi_device_mode !== "replicated") continue;
      const key = `${row.provider_id} ${row.source_id}`;
      const list = replicatedByScope.get(key);
      if (list) list.push(row);
      else replicatedByScope.set(key, [row]);
    }
    const disputedDocumentIds = new Set<string>();
    for (const rows of replicatedByScope.values()) {
      const first = rows[0]!;
      const disputedIds = new Set(
        listDisputedExternalIds(
          db,
          first.provider_id,
          first.source_id,
          rows.map((row) => row.external_id),
        ),
      );
      for (const row of rows) {
        if (disputedIds.has(row.external_id)) disputedDocumentIds.add(row.document_id);
      }
    }
    if (disputedDocumentIds.size > 0) {
      const drop = db.prepare("DELETE FROM document_absences WHERE document_id = ?");
      for (const documentId of disputedDocumentIds) drop.run(documentId);
      due = due.filter((row) => !disputedDocumentIds.has(row.document_id));
    }
    const disputed = disputedDocumentIds.size;
    const revoked = documentIds.length - due.length - disputed;
    if (due.length === 0) return { deletedDocumentIds: [], revoked, disputed };

    // On record before the rows go away, in the same transaction, grouped by
    // the source and stream the absence belonged to.
    const byScope = new Map<string, typeof due>();
    for (const row of due) {
      const key = `${row.provider_id}\u0000${row.source_id}\u0000${row.stream_id}`;
      const existing = byScope.get(key);
      if (existing) existing.push(row);
      else byScope.set(key, [row]);
    }
    const insertAudit = db.prepare(
      `INSERT INTO snapshot_absence_deletions
         (deleted_at, provider_id, source_id, stream_id, external_ids, document_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const rows of byScope.values()) {
      const first = rows[0]!;
      insertAudit.run(
        opts.now,
        first.provider_id,
        first.source_id,
        first.stream_id,
        JSON.stringify(rows.map((r) => r.external_id)),
        rows.length,
      );
    }
    // `id` is AUTOINCREMENT and therefore monotone, so the trail is trimmed by
    // an indexed range on the primary key rather than by re-ranking the table.
    const highest = db
      .prepare<
        [],
        { max_id: number | null }
      >("SELECT MAX(id) AS max_id FROM snapshot_absence_deletions")
      .get()?.max_id;
    if (highest !== null && highest !== undefined) {
      db.prepare("DELETE FROM snapshot_absence_deletions WHERE id <= ?").run(
        highest - SNAPSHOT_ABSENCE_AUDIT_KEEP,
      );
    }

    // The absence rows go with their documents through the foreign key.
    const deletedDocumentIds = opts.deleteDocumentsByIds(
      db,
      due.map((r) => r.document_id),
    );
    const deletedSet = new Set(deletedDocumentIds);
    const replicatedSources = new Set(
      due
        .filter((row) => row.multi_device_mode === "replicated" && deletedSet.has(row.document_id))
        .map((row) => row.source_id),
    );
    // On a replicated source the deletion is the verdict of the member whose
    // snapshot last corroborated the absence — the holder at that moment, since
    // only a holder's snapshot is applied. Recording it makes a sibling's
    // restore after the reset below a dispute, settled only by that sibling's
    // own corroborated omission or tombstone, rather than the start of another
    // delete-and-reset cycle. An absence with no observer on record
    // (`observed_by = ''`) carries no verdict.
    for (const row of due) {
      if (
        row.multi_device_mode !== "replicated" ||
        row.observed_by === "" ||
        !deletedSet.has(row.document_id)
      ) {
        continue;
      }
      recordDeletionClaims(
        db,
        row.provider_id,
        row.source_id,
        row.observed_by,
        [row.external_id],
        opts.now,
      );
    }
    for (const sourceId of replicatedSources) resetAllMemberCursors(db, sourceId);
    const cascadeId =
      deletedDocumentIds.length > 0
        ? Number(
            db
              .prepare(
                `INSERT INTO snapshot_absence_cascade_outbox (created_at, document_ids)
                 VALUES (?, ?)`,
              )
              .run(opts.now, JSON.stringify(deletedDocumentIds)).lastInsertRowid,
          )
        : undefined;
    log.info(
      `Absence sweep deleted ${deletedDocumentIds.length} document(s) across ${byScope.size} source stream(s); ids recorded in snapshot_absence_deletions`,
    );
    return {
      deletedDocumentIds,
      revoked,
      disputed,
      ...(cascadeId === undefined
        ? {}
        : {
            cascade: {
              id: cascadeId,
              documentIds: deletedDocumentIds,
              indexDone: false,
              cognitionDone: false,
            },
          }),
    };
  });
  return apply();
}

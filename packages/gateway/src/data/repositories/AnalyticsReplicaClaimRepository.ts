// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The replica deletion ledger, applied to structured rows.
 *
 * A replicated source's analytics rows live in DuckDB while the ledger that
 * judges their deletions lives in SQLite, so the rules of
 * `ReplicaDeletionClaimRepository` cannot run inside the row write the way
 * they do for documents. They run here instead, as small writer operations
 * the DuckDB page calls from inside its own transaction (see the `replica`
 * hooks of `AnalyticsTableManager.ingestPage` and the judge of the absence
 * sweep): a verdict is durable before the rows it concerns leave, and a
 * failure here rolls the page back.
 *
 * A row is identified by the value that names it on the wire — the
 * `deleteKeyColumn`, or the table's single primary-key column — under the
 * namespace `analytics:<table>`, so its history never mixes with a
 * document's. Everything keyed by source or member (detach, wipe, reset,
 * the status counts) covers both planes through the shared table.
 */

import { pendingPageOmissionsCodec } from "../json-columns.js";
import {
  judgeTombstones,
  listDisputedExternalIds,
  listRestoredExternalIdsByDevice,
  pruneUncontestedClaims,
  recordDeletionClaims,
  recordPresenceClaims,
  recordRestorerOmissions,
  type RestorerSnapshot,
} from "./ReplicaDeletionClaimRepository.js";
import { resetAllMemberCursors, resetSiblingMemberCursors } from "./SyncStateRepository.js";
import { observationSpacingMs, type SnapshotAbsencePolicy } from "./AbsenceRepository.js";
import type { Db } from "../types.js";

/** The ledger namespace of one analytics table's rows. */
export function analyticsClaimNamespace(tableName: string): string {
  return `analytics:${tableName}`;
}

export interface AnalyticsTombstoneArgs {
  sourceId: string;
  tableName: string;
  /** The member whose tombstones these are. */
  deviceId: string;
  /** The tombstoned key values that name a row the table actually holds. */
  existingIds: readonly string[];
  /** Whether this member may lead a deletion nobody has reported before. */
  deletionAuthority: boolean;
  now: number;
}

export interface AnalyticsTombstoneVerdict {
  /** Rows the page may delete: a fresh deletion led by the holder, or one settled by its restorers. */
  apply: string[];
  /** Fresh deletions a member without authority asserted: kept, for the page to replay later. */
  deferred: string[];
  /** Rows another member still holds: kept, and the page advances without them. */
  disputed: string[];
  /** Of `disputed`, the rows this member had not asserted deleted before. */
  newlyDisputed: number;
}

/**
 * Judge a replicated member's row tombstones. A fresh deletion is the lease
 * holder's alone: it is recorded, its siblings are reset so a healthier
 * replica can restore the row, and the row goes. A row with a history is
 * settled by its restorers' agreement, without resetting anyone, and stays
 * until then. Called inside the DuckDB page transaction, before the rows are
 * deleted, so the verdict and the sibling reset are durable first.
 */
export function judgeAnalyticsTombstones(
  db: Db,
  a: AnalyticsTombstoneArgs,
): AnalyticsTombstoneVerdict {
  return db.transaction((): AnalyticsTombstoneVerdict => {
    const namespace = analyticsClaimNamespace(a.tableName);
    const verdict = judgeTombstones(db, namespace, a.sourceId, a.deviceId, a.existingIds, a.now);
    const fresh = a.deletionAuthority ? verdict.fresh : [];
    const deferred = a.deletionAuthority ? [] : verdict.fresh;
    if (fresh.length > 0) {
      recordDeletionClaims(db, namespace, a.sourceId, a.deviceId, fresh, a.now);
      resetSiblingMemberCursors(db, a.sourceId, a.deviceId);
    }
    pruneUncontestedClaims(db, a.sourceId, a.now);
    return {
      apply: [...fresh, ...verdict.settled],
      deferred,
      disputed: verdict.disputed,
      newlyDisputed: verdict.newlyDisputed,
    };
  })();
}

export interface AnalyticsPresenceArgs {
  sourceId: string;
  tableName: string;
  deviceId: string;
  /** Key values of the rows the member's page wrote. */
  keyValues: readonly string[];
  now: number;
}

/**
 * A member's page holds these rows: a deleter withdraws, or becomes a restorer
 * while another deleter stands. Called inside the DuckDB page transaction so
 * a restore is on record before the row it concerns is visible.
 */
export function recordAnalyticsPresence(db: Db, a: AnalyticsPresenceArgs): void {
  recordPresenceClaims(
    db,
    analyticsClaimNamespace(a.tableName),
    a.sourceId,
    a.deviceId,
    a.keyValues,
    a.now,
  );
}

/** The rows a member keeps alive in one table against another member's deletion. */
export function listRestoredAnalyticsKeys(
  db: Db,
  sourceId: string,
  tableName: string,
  deviceId: string,
): string[] {
  return listRestoredExternalIdsByDevice(
    db,
    analyticsClaimNamespace(tableName),
    sourceId,
    deviceId,
  );
}

/**
 * Include durable deletion verdicts: SQLite can settle an omission before
 * DuckDB commits its deletion. A later snapshot must be able to retry it.
 * Presence withdraws or disputes these claims through the ordinary ledger.
 */
export function listAnalyticsOmissionCandidates(
  db: Db,
  sourceId: string,
  tableName: string,
  deviceId: string,
): string[] {
  return db
    .prepare<[string, string, string], { external_id: string }>(
      "SELECT external_id FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? AND device_id = ?",
    )
    .all(analyticsClaimNamespace(tableName), sourceId, deviceId)
    .map((row) => row.external_id);
}

export interface AnalyticsRestorerSnapshotArgs {
  observation?: { pageId: string; ordinal: number };
  sourceId: string;
  tableName: string;
  deviceId: string;
  /** What the member's snapshot said about the rows it keeps alive; resolved off the writer. */
  snapshot: RestorerSnapshot;
  absencePolicy: SnapshotAbsencePolicy;
  now: number;
}

/**
 * Count a member's snapshot against the rows it keeps alive. Returns the keys
 * whose omission matured under the absence policy — the member's `deleted`
 * verdict, which the page then applies exactly like a tombstone.
 */
export function recordAnalyticsRestorerOmissions(
  db: Db,
  a: AnalyticsRestorerSnapshotArgs,
): string[] {
  return db.transaction(() => {
    if (a.observation) {
      const prior = db
        .prepare<
          [string, number],
          { matured_keys: string }
        >("SELECT matured_keys FROM pending_source_page_observations WHERE page_id = ? AND ordinal = ?")
        .get(a.observation.pageId, a.observation.ordinal);
      if (prior) return pendingPageOmissionsCodec.parse(prior.matured_keys);
    }
    const namespace = analyticsClaimNamespace(a.tableName);
    // Naming a formerly deleted key is positive evidence, just like sending
    // its row. It invalidates a retry intent before a later omission can act.
    recordPresenceClaims(db, namespace, a.sourceId, a.deviceId, a.snapshot.named, a.now);
    const matured = recordRestorerOmissions(
      db,
      namespace,
      a.sourceId,
      a.deviceId,
      a.snapshot,
      {
        minObservations: a.absencePolicy.minObservations,
        minAgeMs: a.absencePolicy.minAgeMs,
        spacingMs: observationSpacingMs(a.absencePolicy),
      },
      a.now,
    );
    const omitted = new Set(a.snapshot.omitted);
    const settled = db
      .prepare<[string, string, string], { external_id: string }>(
        "SELECT external_id FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? AND device_id = ? AND role = 'deleted'",
      )
      .all(namespace, a.sourceId, a.deviceId)
      .filter((row) => omitted.has(row.external_id))
      .map((row) => row.external_id);
    // These are candidates, not permission to delete: the DuckDB transaction
    // rejudges each against every current restorer before removing any row.
    const candidates = [...new Set([...matured, ...settled])];
    if (a.observation)
      db.prepare(
        "INSERT INTO pending_source_page_observations (page_id, ordinal, matured_keys) VALUES (?, ?, ?)",
      ).run(
        a.observation.pageId,
        a.observation.ordinal,
        pendingPageOmissionsCodec.serialize(candidates),
      );
    return candidates;
  })();
}

export interface AnalyticsSweepCandidate {
  sourceId: string;
  tableName: string;
  keyValue: string;
}

/** The key of a candidate in `AnalyticsSweepPlan.disputed`. */
export function analyticsSweepCandidateKey(c: AnalyticsSweepCandidate): string {
  return `${c.sourceId} ${c.tableName} ${c.keyValue}`;
}

export interface AnalyticsSweepPlan {
  /** The candidates' sources that are replicated — the only ones the ledger has a say on. */
  replicatedSources: string[];
  /** Candidates (by `analyticsSweepCandidateKey`) another member restored after a deletion: the sweep leaves them. */
  disputed: string[];
}

/**
 * What the ledger says about a batch of due analytics absences before the
 * sweep acts on them, read once for the batch: which sources are replicated
 * at all, and which rows are in dispute. Read before any verdict of the batch
 * is recorded, so a reset made for one row cannot un-dispute the next.
 */
export function planAnalyticsSweep(
  db: Db,
  candidates: readonly AnalyticsSweepCandidate[],
): AnalyticsSweepPlan {
  const modeOf = db.prepare<[string], { multi_device_mode: string | null }>(
    "SELECT multi_device_mode FROM sources WHERE id = ?",
  );
  const modes = new Map<string, string | null>();
  for (const sourceId of new Set(candidates.map((c) => c.sourceId))) {
    modes.set(sourceId, modeOf.get(sourceId)?.multi_device_mode ?? null);
  }
  const replicatedSources = [...modes.entries()]
    .filter(([, mode]) => mode === "replicated")
    .map(([sourceId]) => sourceId);
  const byTable = new Map<string, AnalyticsSweepCandidate[]>();
  for (const c of candidates) {
    if (modes.get(c.sourceId) !== "replicated") continue;
    const key = `${c.sourceId} ${c.tableName}`;
    const list = byTable.get(key);
    if (list) list.push(c);
    else byTable.set(key, [c]);
  }
  const disputed: string[] = [];
  for (const list of byTable.values()) {
    const first = list[0]!;
    const disputedKeys = new Set(
      listDisputedExternalIds(
        db,
        analyticsClaimNamespace(first.tableName),
        first.sourceId,
        list.map((c) => c.keyValue),
      ),
    );
    for (const c of list) {
      if (disputedKeys.has(c.keyValue)) disputed.push(analyticsSweepCandidateKey(c));
    }
  }
  return { replicatedSources, disputed };
}

export interface AnalyticsSweepVerdict extends AnalyticsSweepCandidate {
  /** The member whose snapshots earned the absence, or `''` when unattributed. */
  observedBy: string;
  /** Send every member of the source back to bootstrap with this verdict — once per source and batch. */
  resetMembers: boolean;
}

/**
 * The sweep is deleting a replicated source's row: record it as the verdict
 * of the member whose snapshots earned the absence, so a sibling's restore
 * afterwards is a dispute rather than the start of another delete-and-reset
 * cycle, and — with the first row of the source in the batch — reset every
 * member so a healthier replica can restore what the deletion got wrong. Both
 * in one transaction, called inside the sweep's DuckDB transaction after it
 * re-checked the absence is still due and before the row is deleted.
 */
export function recordAnalyticsSweepVerdict(db: Db, v: AnalyticsSweepVerdict, now: number): void {
  db.transaction(() => {
    if (v.observedBy !== "") {
      recordDeletionClaims(
        db,
        analyticsClaimNamespace(v.tableName),
        v.sourceId,
        v.observedBy,
        [v.keyValue],
        now,
      );
    }
    if (v.resetMembers) resetAllMemberCursors(db, v.sourceId);
  })();
}

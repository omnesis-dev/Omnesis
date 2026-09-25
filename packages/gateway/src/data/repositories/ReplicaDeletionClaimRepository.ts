// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Replica deletion claims — how a replicated source converges when its
 * members disagree about whether an item still exists.
 *
 * Every member of a `replicated` source reads its own copy of the same store
 * and contributes to one shared document set. When the lease holder reports
 * an item explicitly deleted, the gateway removes it and resets every
 * sibling's cursor so each one bootstraps from its own replica and restores
 * anything the deletion got wrong. That is the recovery; this ledger is its
 * memory. Without one, a member whose replica still holds the item puts it
 * back, the deleter's next tick removes it again, and the two loop forever,
 * one full sibling bootstrap per cycle.
 *
 * The ledger keeps one row per (item, member): that member's latest verdict,
 * `deleted` or `restored`. An item with any rows has been deleted at least
 * once. An item with a `restored` row is **disputed**: a sibling put it back
 * after the deletion, and the gateway keeps it until every member that
 * restored it has itself asserted the deletion. The rule is "restore wins
 * until every restorer agrees" because the gateway cannot tell a stale
 * sibling from a deleter with an incomplete view, and the common case — a
 * replica that has not yet received the deletion — converges on its own once
 * that replica sees it. A permanently stale sibling keeps the item alive and
 * visibly flagged; the operator's own delete of the document is the override.
 *
 * Invariant: rows exist for an item ⇒ at least one of them is `deleted`. A
 * member that holds an item it had deleted withdraws its verdict: the item's
 * rows go with the last `deleted` one, and while another deleter still stands
 * the member becomes a restorer instead. A settled item keeps its `deleted`
 * rows until the prune retires them, so a sibling still mid-bootstrap that
 * brings it back is recognised as disputing it.
 *
 * Deletions the gateway infers from snapshots follow the same rule. An
 * absence-sweep deletion on a replicated source is recorded as the verdict of
 * the member whose snapshots earned it, so a sibling's restore afterwards is a
 * dispute. A restorer's own snapshots omitting an item it keeps alive count on
 * its `restored` row under the same two currencies an absence needs — spaced
 * observations and elapsed time — and become its `deleted` verdict only once
 * both are spent; naming the item again, or contributing it, starts that clock
 * over. One snapshot alone never deletes anything.
 *
 * The ledger serves both planes. `namespace` says which one an item belongs
 * to: the provider id for a document, `analytics:<table>` for a structured
 * row (see `AnalyticsReplicaClaimRepository`), so a document and a row that
 * share an id never share a history, while everything keyed by source or
 * member — detach, wipe, reset, the status counts — covers both at once.
 */

import type { Db } from "../types.js";

export type ReplicaClaimRole = "deleted" | "restored";

/**
 * How long an uncontested deletion's rows are kept. They exist so a sibling
 * that restores the item later is recognised as disputing it rather than
 * contributing something new; once every sibling has bootstrapped past the
 * deletion that can only happen from a very late bootstrap, which then costs
 * one more delete-and-reset cycle before the dispute is recorded. Bounded, so
 * the ledger does not have to grow with every deletion ever made.
 */
export const REPLICA_CLAIM_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Ids per `IN (...)` statement; the same size the document paths use. */
const CLAIM_IN_LIST_CHUNK = 500;

/** Items one prune pass may drop, so it never grows with the ledger. */
const PRUNE_CHUNK = 200;

export function createReplicaDeletionClaimsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replica_deletion_claims (
      namespace TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('deleted', 'restored')),
      at INTEGER NOT NULL,
      omissions INTEGER NOT NULL DEFAULT 0,
      first_omitted_at INTEGER,
      last_omitted_at INTEGER,
      PRIMARY KEY (namespace, source_id, external_id, device_id)
    )
  `);
  // The prune walks a source's `deleted` rows by age; the status counts walk
  // `restored` rows across sources. Each has an index that stops at the first
  // row it does not want.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_replica_deletion_claims_source_role_at ON replica_deletion_claims(source_id, role, at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_replica_deletion_claims_role_source ON replica_deletion_claims(role, source_id)",
  );
}

/**
 * Whether the ledger holds anything at all. Every ledger read starts here so
 * the common install — one host, or replicas that never disagreed — pays one
 * probe of an empty table and nothing more. It is asked of the database each
 * time rather than remembered: the gateway reads the ledger from its main
 * thread and writes it from the writer worker, two connections to one file,
 * and a flag cached on one would never learn what the other wrote.
 */
export function hasAnyReplicaClaims(db: Db): boolean {
  return db.prepare("SELECT 1 FROM replica_deletion_claims LIMIT 1").get() !== undefined;
}

interface ClaimRow {
  external_id: string;
  device_id: string;
  role: ReplicaClaimRole;
}

function loadClaims(
  db: Db,
  namespace: string,
  sourceId: string,
  externalIds: readonly string[],
): Map<string, ClaimRow[]> {
  const byItem = new Map<string, ClaimRow[]>();
  for (let i = 0; i < externalIds.length; i += CLAIM_IN_LIST_CHUNK) {
    const chunk = externalIds.slice(i, i + CLAIM_IN_LIST_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        unknown[],
        ClaimRow
      >(`SELECT external_id, device_id, role FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? AND external_id IN (${placeholders})`)
      .all(namespace, sourceId, ...chunk);
    for (const row of rows) {
      const list = byItem.get(row.external_id);
      if (list) list.push(row);
      else byItem.set(row.external_id, [row]);
    }
  }
  return byItem;
}

function upsertClaim(
  db: Db,
  namespace: string,
  sourceId: string,
  externalId: string,
  deviceId: string,
  role: ReplicaClaimRole,
  now: number,
): void {
  // A repeated identical verdict keeps its original time, so `at` reads as
  // "since when" rather than "last heard". Either verdict starts the omission
  // clock over: a `restored` verdict is the item arriving, which is positive
  // evidence; a `deleted` one has nothing left to count.
  db.prepare(
    `INSERT INTO replica_deletion_claims
       (namespace, source_id, external_id, device_id, role, at, omissions, first_omitted_at, last_omitted_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL)
     ON CONFLICT(namespace, source_id, external_id, device_id) DO UPDATE SET
       at = CASE WHEN replica_deletion_claims.role = excluded.role THEN replica_deletion_claims.at ELSE excluded.at END,
       role = excluded.role,
       omissions = 0,
       first_omitted_at = NULL,
       last_omitted_at = NULL`,
  ).run(namespace, sourceId, externalId, deviceId, role, now);
}

/** The corroboration a restorer's omission must reach before it is a verdict. */
export interface RestorerOmissionPolicy {
  /** Snapshots that must all omit the item. */
  minObservations: number;
  /** Elapsed ms since the first omission. */
  minAgeMs: number;
  /** Minimum gap between two counted omissions. */
  spacingMs: number;
}

/** What a member's full snapshot said about the items it keeps alive. */
export interface RestorerSnapshot {
  /** Items the snapshot still names: positive evidence. */
  named: readonly string[];
  /** Items the snapshot no longer names and the page did not tombstone. */
  omitted: readonly string[];
}

/**
 * A restorer's snapshot has spoken about the items it keeps alive: the ones
 * it named are positive evidence and start the clock over; the ones it
 * omitted count, under the same two currencies the absence ledger spends —
 * spaced observations and elapsed time — never one snapshot alone. Returns
 * the items whose omission has now been corroborated: this member's `deleted`
 * verdict, for the caller to apply exactly as it would a tombstone. Unlike an
 * absence, which the sweep spends on its own once the age has passed, an
 * omission matures on the first spaced snapshot after both currencies are
 * met — one snapshot more than the sweep would need. Both halves are set
 * statements per id chunk, so the writer's work is a handful of statements
 * however many items the member keeps alive.
 */
export function recordRestorerOmissions(
  db: Db,
  namespace: string,
  sourceId: string,
  deviceId: string,
  snapshot: RestorerSnapshot,
  policy: RestorerOmissionPolicy,
  now: number,
): string[] {
  if (!hasAnyReplicaClaims(db)) return [];
  for (let i = 0; i < snapshot.named.length; i += CLAIM_IN_LIST_CHUNK) {
    const chunk = snapshot.named.slice(i, i + CLAIM_IN_LIST_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    db.prepare(
      `UPDATE replica_deletion_claims
          SET omissions = 0, first_omitted_at = NULL, last_omitted_at = NULL
        WHERE namespace = ? AND source_id = ? AND device_id = ? AND role = 'restored'
          AND omissions > 0 AND external_id IN (${placeholders})`,
    ).run(namespace, sourceId, deviceId, ...chunk);
  }
  const matured: string[] = [];
  for (let i = 0; i < snapshot.omitted.length; i += CLAIM_IN_LIST_CHUNK) {
    const chunk = snapshot.omitted.slice(i, i + CLAIM_IN_LIST_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    // The first omission starts the clock; one inside the spacing window adds
    // no independent evidence and leaves the row untouched.
    db.prepare(
      `UPDATE replica_deletion_claims
          SET omissions = CASE
                WHEN last_omitted_at IS NULL THEN 1
                WHEN ? - last_omitted_at >= ? THEN omissions + 1
                ELSE omissions END,
              first_omitted_at = CASE
                WHEN last_omitted_at IS NULL THEN ? ELSE first_omitted_at END,
              last_omitted_at = CASE
                WHEN last_omitted_at IS NULL OR ? - last_omitted_at >= ? THEN ?
                ELSE last_omitted_at END
        WHERE namespace = ? AND source_id = ? AND device_id = ? AND role = 'restored'
          AND external_id IN (${placeholders})`,
    ).run(
      now,
      policy.spacingMs,
      now,
      now,
      policy.spacingMs,
      now,
      namespace,
      sourceId,
      deviceId,
      ...chunk,
    );
    const rows = db
      .prepare<
        unknown[],
        { external_id: string }
      >(`SELECT external_id FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? AND device_id = ? AND role = 'restored' AND omissions >= ? AND first_omitted_at <= ? AND external_id IN (${placeholders})`)
      .all(namespace, sourceId, deviceId, policy.minObservations, now - policy.minAgeMs, ...chunk);
    for (const row of rows) matured.push(row.external_id);
  }
  return matured;
}

function clearItem(db: Db, namespace: string, sourceId: string, externalId: string): void {
  db.prepare(
    "DELETE FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? AND external_id = ?",
  ).run(namespace, sourceId, externalId);
}

/** How a page's explicit tombstones divide once the ledger has had its say. */
export interface TombstoneJudgement {
  /** Never deleted before: the lease holder may delete these and reset its siblings. */
  fresh: string[];
  /** Every member that restored the item has now agreed it is gone: delete, reset nobody. */
  settled: string[];
  /** A sibling still holds the item: keep it, and let this page advance without it. */
  disputed: string[];
  /** Disputed items this member had not asserted deleted before. */
  newlyDisputed: number;
}

/**
 * Record `deviceId`'s deletion verdict on each item that already has a
 * history and sort the page's tombstones by what should happen to them.
 * Items with no history are returned untouched as `fresh`; whether they are
 * deleted is the caller's call (only the lease holder leads a fresh deletion),
 * and `recordDeletionClaims` writes their rows once they are.
 */
// See #80 — planned: a deletion stamp on the wire settles a stale restore at once.
export function judgeTombstones(
  db: Db,
  namespace: string,
  sourceId: string,
  deviceId: string,
  externalIds: readonly string[],
  now: number,
): TombstoneJudgement {
  const unique = [...new Set(externalIds)];
  if (unique.length === 0 || !hasAnyReplicaClaims(db)) {
    return { fresh: unique, settled: [], disputed: [], newlyDisputed: 0 };
  }
  const history = loadClaims(db, namespace, sourceId, unique);
  const judgement: TombstoneJudgement = { fresh: [], settled: [], disputed: [], newlyDisputed: 0 };
  for (const externalId of unique) {
    const rows = history.get(externalId);
    if (!rows) {
      judgement.fresh.push(externalId);
      continue;
    }
    const mine = rows.find((row) => row.device_id === deviceId);
    const restorers = rows.filter((row) => row.role === "restored" && row.device_id !== deviceId);
    upsertClaim(db, namespace, sourceId, externalId, deviceId, "deleted", now);
    if (restorers.length === 0) {
      // This member was the last one keeping the item alive, or nobody was:
      // the item goes. Its history stays — every row is now `deleted` — until
      // the prune retires it, so a sibling still mid-bootstrap that brings the
      // item back is recognised as disputing it rather than as a new document.
      judgement.settled.push(externalId);
      continue;
    }
    judgement.disputed.push(externalId);
    if (mine?.role !== "deleted") judgement.newlyDisputed += 1;
  }
  return judgement;
}

/** Open an item's history: `deviceId` deleted it, and its siblings are about to bootstrap. */
export function recordDeletionClaims(
  db: Db,
  namespace: string,
  sourceId: string,
  deviceId: string,
  externalIds: readonly string[],
  now: number,
): void {
  for (const externalId of externalIds) {
    upsertClaim(db, namespace, sourceId, externalId, deviceId, "deleted", now);
  }
}

/**
 * `deviceId`'s page carried these items. For an item with a history that is
 * either the deleter withdrawing its own verdict or a sibling restoring the
 * item — the latter is what makes it disputed. Items without a history are
 * ordinary documents and leave no trace here.
 */
export function recordPresenceClaims(
  db: Db,
  namespace: string,
  sourceId: string,
  deviceId: string,
  externalIds: readonly string[],
  now: number,
): void {
  if (externalIds.length === 0 || !hasAnyReplicaClaims(db)) return;
  const history = loadClaims(db, namespace, sourceId, [...new Set(externalIds)]);
  for (const [externalId, rows] of history) {
    const otherDeleters = rows.some((row) => row.role === "deleted" && row.device_id !== deviceId);
    if (!otherDeleters) {
      // This member was the only one to have deleted the item, and now holds
      // it again: nothing is left to dispute.
      clearItem(db, namespace, sourceId, externalId);
      continue;
    }
    // Against another member's standing deletion, holding the item is a
    // restore — whether this member had deleted it before or not.
    upsertClaim(db, namespace, sourceId, externalId, deviceId, "restored", now);
  }
}

/** The subset of `externalIds` with a history in this source. */
export function listClaimedExternalIds(
  db: Db,
  namespace: string,
  sourceId: string,
  externalIds: readonly string[],
): string[] {
  if (externalIds.length === 0 || !hasAnyReplicaClaims(db)) return [];
  return [...loadClaims(db, namespace, sourceId, [...new Set(externalIds)]).keys()];
}

/** Which of `externalIds` are disputed — kept alive by a sibling's restore. */
export function listDisputedExternalIds(
  db: Db,
  namespace: string,
  sourceId: string,
  externalIds: readonly string[],
): string[] {
  if (externalIds.length === 0 || !hasAnyReplicaClaims(db)) return [];
  const out: string[] = [];
  for (const [externalId, rows] of loadClaims(db, namespace, sourceId, [...new Set(externalIds)])) {
    if (rows.some((row) => row.role === "restored")) out.push(externalId);
  }
  return out;
}

/**
 * The items `deviceId` is keeping alive against another member's deletion.
 * A member's snapshot that omits one of these is that member's own deletion
 * verdict, so the caller turns the omissions into tombstones.
 */
export function listRestoredExternalIdsByDevice(
  db: Db,
  namespace: string,
  sourceId: string,
  deviceId: string,
): string[] {
  if (!hasAnyReplicaClaims(db)) return [];
  return db
    .prepare<[string, string, string], { external_id: string }>(
      "SELECT external_id FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? AND device_id = ? AND role = 'restored'",
    )
    .all(namespace, sourceId, deviceId)
    .map((row) => row.external_id);
}

/**
 * Withdraw the `restored` verdicts of members sent back to bootstrap. A
 * bootstrap re-vouches for everything the replica still holds and records
 * those items again; whatever it no longer holds is no longer kept alive by
 * it. The `deleted` verdicts stay, so the invariant holds.
 */
export function clearRestoredClaims(
  db: Db,
  sourceId: string,
  scope: { deviceId: string } | { exceptDeviceId: string } | "all",
): void {
  if (scope === "all") {
    db.prepare("DELETE FROM replica_deletion_claims WHERE source_id = ? AND role = 'restored'").run(
      sourceId,
    );
  } else if ("deviceId" in scope) {
    db.prepare(
      "DELETE FROM replica_deletion_claims WHERE source_id = ? AND role = 'restored' AND device_id = ?",
    ).run(sourceId, scope.deviceId);
  } else {
    db.prepare(
      "DELETE FROM replica_deletion_claims WHERE source_id = ? AND role = 'restored' AND device_id != ?",
    ).run(sourceId, scope.exceptDeviceId);
  }
}

/**
 * A device that no longer hosts the source has no say in it. Source ids are
 * unique across providers, so the source alone keys these statements.
 */
export function clearClaimsForDevice(db: Db, sourceId: string, deviceId: string): void {
  db.prepare("DELETE FROM replica_deletion_claims WHERE source_id = ? AND device_id = ?").run(
    sourceId,
    deviceId,
  );
  // Items whose only deleter left keep no history: a restore with nothing to
  // dispute is just a document.
  db.prepare(
    `DELETE FROM replica_deletion_claims AS c
      WHERE c.source_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM replica_deletion_claims AS d
           WHERE d.source_id = ? AND d.namespace = c.namespace
             AND d.external_id = c.external_id AND d.role = 'deleted'
        )`,
  ).run(sourceId, sourceId);
}

export function clearClaimsForSource(db: Db, sourceId: string): void {
  db.prepare("DELETE FROM replica_deletion_claims WHERE source_id = ?").run(sourceId);
}

/** The operator removed these documents themselves; nothing is left to dispute. */
export function clearClaimsForExternalIds(
  db: Db,
  namespace: string,
  sourceId: string,
  externalIds: readonly string[],
): void {
  if (externalIds.length === 0 || !hasAnyReplicaClaims(db)) return;
  for (let i = 0; i < externalIds.length; i += CLAIM_IN_LIST_CHUNK) {
    const chunk = externalIds.slice(i, i + CLAIM_IN_LIST_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? AND external_id IN (${placeholders})`,
    ).run(namespace, sourceId, ...chunk);
  }
}

/**
 * Drop the rows of uncontested deletions older than the retention. One
 * bounded chunk per call; the caller runs it on pages that carried tombstones,
 * so a source that keeps deleting keeps its own ledger trimmed. Nothing is
 * pruned while a member of the source still has a reset cursor: that member
 * has not bootstrapped past the deletion yet, and its restore must still be
 * recognised as a dispute rather than as a new document.
 */
export function pruneUncontestedClaims(db: Db, sourceId: string, now: number): number {
  if (!hasAnyReplicaClaims(db)) return 0;
  const result = db
    .prepare(
      `DELETE FROM replica_deletion_claims
        WHERE rowid IN (
          SELECT c.rowid
            FROM replica_deletion_claims AS c
           WHERE c.source_id = ? AND c.role = 'deleted' AND c.at < ?
             AND NOT EXISTS (
               SELECT 1 FROM replica_deletion_claims AS r
                WHERE r.namespace = c.namespace AND r.source_id = c.source_id
                  AND r.external_id = c.external_id AND r.role = 'restored'
             )
             AND NOT EXISTS (
               SELECT 1 FROM sync_state AS s
                WHERE s.source_id = c.source_id AND s.device_id != '' AND s.last_synced_at IS NULL
             )
           LIMIT ${PRUNE_CHUNK}
        )`,
    )
    .run(sourceId, now - REPLICA_CLAIM_RETENTION_MS);
  return result.changes;
}

/** Disputed items per source — what the status surfaces show. */
export function countDisputedBySource(db: Db): Map<string, number> {
  const out = new Map<string, number>();
  if (!hasAnyReplicaClaims(db)) return out;
  const rows = db
    .prepare<[], { source_id: string; n: number }>(
      `SELECT source_id, COUNT(*) AS n
         FROM (SELECT DISTINCT source_id, namespace, external_id
                 FROM replica_deletion_claims WHERE role = 'restored')
        GROUP BY source_id`,
    )
    .all();
  for (const row of rows) out.set(row.source_id, row.n);
  return out;
}

/** Items each member keeps alive against another member's deletion. */
export function countRestoredByMember(db: Db, sourceId: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!hasAnyReplicaClaims(db)) return out;
  const rows = db
    .prepare<
      [string],
      { device_id: string; n: number }
    >("SELECT device_id, COUNT(*) AS n FROM replica_deletion_claims WHERE source_id = ? AND role = 'restored' GROUP BY device_id")
    .all(sourceId);
  for (const row of rows) out.set(row.device_id, row.n);
  return out;
}

/**
 * For each member keeping disputed items alive, the members that reported
 * those items deleted — so a status can name the device it disagrees with.
 */
export function listDeletersByRestorer(db: Db, sourceId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!hasAnyReplicaClaims(db)) return out;
  const rows = db
    .prepare<[string], { restorer: string; deleter: string }>(
      `SELECT DISTINCT r.device_id AS restorer, d.device_id AS deleter
         FROM replica_deletion_claims r
         JOIN replica_deletion_claims d
           ON d.namespace = r.namespace AND d.source_id = r.source_id
          AND d.external_id = r.external_id AND d.role = 'deleted'
        WHERE r.source_id = ? AND r.role = 'restored'`,
    )
    .all(sourceId);
  for (const row of rows) {
    const list = out.get(row.restorer);
    if (list) list.push(row.deleter);
    else out.set(row.restorer, [row.deleter]);
  }
  return out;
}

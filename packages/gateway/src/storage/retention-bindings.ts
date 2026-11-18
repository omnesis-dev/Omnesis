// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { LegacyStorageRetentionBinding } from "@omnesis/config";
import type { ConfigRevisionFence } from "../config-store.js";

export interface StorageRetentionPolicyConfig {
  sourceId: string;
  maxAgeDays: number;
}

/** Operational authority, kept in SQLite rather than the user's config. */
export interface BoundStorageRetentionPolicy extends StorageRetentionPolicyConfig {
  sourceIncarnation: string;
  bindingId: string;
}

export interface StorageRetentionBindingInput extends StorageRetentionPolicyConfig {
  /** Captured before entering the writer queue; never silently recaptured on that thread. */
  sourceIncarnation: string | null;
}

export interface StorageRetentionBindingRecord extends StorageRetentionBindingInput {
  bindingId: string;
  active: boolean;
}

export interface ReconcileStorageRetentionBindingsInput {
  policies: readonly StorageRetentionBindingInput[];
  /** Sources whose configuration changed, including a coalesced disable/re-enable. */
  renewSourceIds?: readonly string[];
  authority?: ConfigRevisionFence;
}

export interface BindStorageRetentionPolicyInput extends StorageRetentionPolicyConfig {
  sourceIncarnation: string;
  authority?: ConfigRevisionFence;
}

export interface StorageRetentionBindingResult {
  stale: boolean;
  changed: number;
}

/**
 * A real source INSERT rotates its identity even when its timestamp is reused.
 * Retired policy bindings survive source deletion, preventing an old config or
 * a restarted job from silently acquiring a replacement source's authority.
 */
export function createStorageRetentionBindingTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_source_incarnations (
      source_id TEXT PRIMARY KEY,
      incarnation TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS storage_source_incarnation_insert
    AFTER INSERT ON sources BEGIN
      INSERT INTO storage_source_incarnations(source_id, incarnation)
      VALUES (new.id, lower(hex(randomblob(16))))
      ON CONFLICT(source_id) DO UPDATE SET incarnation = excluded.incarnation;
    END;
    INSERT OR IGNORE INTO storage_source_incarnations(source_id, incarnation)
      SELECT id, lower(hex(randomblob(16))) FROM sources;
    CREATE TABLE IF NOT EXISTS storage_retention_bindings (
      source_id TEXT PRIMARY KEY,
      max_age_days INTEGER NOT NULL CHECK(max_age_days BETWEEN 1 AND 36500),
      source_incarnation TEXT,
      binding_id TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_storage_retention_bindings_active
      ON storage_retention_bindings(active, source_id);
  `);
}

/** Reads never mint authority, and a deleted source cannot inherit its retired marker. */
export function readStorageSourceIncarnation(
  db: Database.Database,
  sourceId: string,
): string | null {
  return (
    db
      .prepare<[string], { incarnation: string }>(
        `SELECT i.incarnation FROM storage_source_incarnations i
     JOIN sources s ON s.id = i.source_id WHERE i.source_id = ?
     AND NOT EXISTS (SELECT 1 FROM removed_sources r WHERE r.id = s.id)`,
      )
      .get(sourceId)?.incarnation ?? null
  );
}

export function readStorageRetentionBinding(
  db: Database.Database,
  sourceId: string,
): StorageRetentionBindingRecord | null {
  const row = db
    .prepare<[string], Omit<StorageRetentionBindingRecord, "active"> & { active: number }>(
      `SELECT source_id AS sourceId, max_age_days AS maxAgeDays,
      source_incarnation AS sourceIncarnation, binding_id AS bindingId, active
      FROM storage_retention_bindings WHERE source_id = ?`,
    )
    .get(sourceId);
  return row ? { ...row, active: row.active === 1 } : null;
}

/** Capture source identities alongside a config snapshot before queueing reconciliation. */
export function captureStorageRetentionBindingInputs(
  db: Database.Database,
  policies: readonly StorageRetentionPolicyConfig[],
  legacyPolicies: readonly LegacyStorageRetentionBinding[] = [],
): StorageRetentionBindingInput[] {
  return policies.map((policy) => {
    const legacy = legacyPolicies.find((row) => row.sourceId === policy.sourceId);
    const source = db
      .prepare<[string], { createdAt: number; incarnation: string }>(
        `SELECT s.created_at AS createdAt, i.incarnation FROM sources s
       JOIN storage_source_incarnations i ON i.source_id = s.id WHERE s.id = ?
       AND NOT EXISTS (SELECT 1 FROM removed_sources r WHERE r.id = s.id)`,
      )
      .get(policy.sourceId);
    return {
      ...policy,
      sourceIncarnation:
        source && (!legacy || legacy.sourceCreatedAt === source.createdAt)
          ? source.incarnation
          : null,
    };
  });
}

function authorityIsCurrent(authority?: ConfigRevisionFence): boolean {
  return (
    authority === undefined ||
    Atomics.load(new Int32Array(authority.buffer), 0) === authority.revision
  );
}

/** Binding revocation and job cancellation share the same writer transaction. */
function cancelRetiredRollingJobs(db: Database.Database, sourceId: string): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_trim_jobs'").get()
  )
    return;
  const now = Date.now();
  db.prepare(
    `UPDATE storage_trim_jobs SET state = 'cancelled', error = 'Retention policy changed',
    updated_at = ?, completed_at = ?, revision = revision + 1
    WHERE source_id = ? AND kind = 'rolling' AND state IN ('queued', 'running')`,
  ).run(now, now, sourceId);
}

/**
 * Raw config edits may change an existing binding's duration, but never its
 * source identity. Deactivation retains the identity so replaying an old file
 * after source replacement cannot rebind it. Explicit user confirmation uses
 * bindStorageRetentionPolicy instead.
 */
export function reconcileStorageRetentionBindings(
  db: Database.Database,
  input: ReconcileStorageRetentionBindingsInput,
): StorageRetentionBindingResult {
  if (input.policies.length > 1000) throw new Error("Storage retention policy bound exceeded");
  return db.transaction(() => {
    if (!authorityIsCurrent(input.authority)) return { stale: true, changed: 0 };
    const renew = new Set(input.renewSourceIds ?? []);
    const desired = new Set(input.policies.map((policy) => policy.sourceId));
    if (desired.size !== input.policies.length)
      throw new Error("Duplicate storage retention policy");
    let changed = 0;
    const active = db
      .prepare<[], { sourceId: string }>(
        "SELECT source_id AS sourceId FROM storage_retention_bindings WHERE active = 1",
      )
      .all();
    for (const row of active) {
      if (!desired.has(row.sourceId)) {
        db.prepare(
          "UPDATE storage_retention_bindings SET active = 0, binding_id = ? WHERE source_id = ?",
        ).run(randomUUID(), row.sourceId);
        cancelRetiredRollingJobs(db, row.sourceId);
        changed += 1;
      }
    }
    for (const policy of input.policies) {
      const existing = readStorageRetentionBinding(db, policy.sourceId);
      if (
        existing &&
        existing.active &&
        existing.maxAgeDays === policy.maxAgeDays &&
        !renew.has(policy.sourceId)
      )
        continue;
      db.prepare(
        `INSERT INTO storage_retention_bindings(source_id, max_age_days, source_incarnation, binding_id, active)
        VALUES (?, ?, ?, ?, 1) ON CONFLICT(source_id) DO UPDATE SET
        max_age_days = excluded.max_age_days, binding_id = excluded.binding_id, active = 1`,
      ).run(
        policy.sourceId,
        policy.maxAgeDays,
        existing ? existing.sourceIncarnation : policy.sourceIncarnation,
        randomUUID(),
      );
      cancelRetiredRollingJobs(db, policy.sourceId);
      changed += 1;
    }
    return { stale: false, changed };
  })();
}

/** Explicit UI confirmation may bind a replacement source, fenced against a queued ABA change. */
export function bindStorageRetentionPolicy(
  db: Database.Database,
  input: BindStorageRetentionPolicyInput,
): StorageRetentionBindingResult {
  return db.transaction(() => {
    if (
      !authorityIsCurrent(input.authority) ||
      readStorageSourceIncarnation(db, input.sourceId) !== input.sourceIncarnation
    ) {
      return { stale: true, changed: 0 };
    }
    db.prepare(
      `INSERT INTO storage_retention_bindings(source_id, max_age_days, source_incarnation, binding_id, active)
      VALUES (?, ?, ?, ?, 1) ON CONFLICT(source_id) DO UPDATE SET
      max_age_days = excluded.max_age_days, source_incarnation = excluded.source_incarnation,
      binding_id = excluded.binding_id, active = 1`,
    ).run(input.sourceId, input.maxAgeDays, input.sourceIncarnation, randomUUID());
    cancelRetiredRollingJobs(db, input.sourceId);
    return { stale: false, changed: 1 };
  })();
}

export function storageRetentionBindingIsCurrent(
  db: Database.Database,
  policy: BoundStorageRetentionPolicy,
): boolean {
  return (
    db
      .prepare<[string, number, string, string], { current: number }>(
        `SELECT 1 AS current FROM storage_retention_bindings b
     JOIN storage_source_incarnations i ON i.source_id = b.source_id
     JOIN sources s ON s.id = b.source_id
     WHERE b.source_id = ? AND b.max_age_days = ? AND b.source_incarnation = ?
       AND b.binding_id = ? AND b.active = 1 AND i.incarnation = b.source_incarnation
       AND NOT EXISTS (SELECT 1 FROM removed_sources r WHERE r.id = b.source_id)`,
      )
      .get(policy.sourceId, policy.maxAgeDays, policy.sourceIncarnation, policy.bindingId)
      ?.current === 1
  );
}

/** One bounded join avoids repeated synchronous lookups on gateway request paths. */
export function readBoundStorageRetentionPolicies(
  db: Database.Database,
  desired: readonly StorageRetentionPolicyConfig[],
): BoundStorageRetentionPolicy[] {
  if (desired.length === 0) return [];
  const rows = db
    .prepare<[string], BoundStorageRetentionPolicy>(
      `SELECT b.source_id AS sourceId, b.max_age_days AS maxAgeDays,
       b.source_incarnation AS sourceIncarnation, b.binding_id AS bindingId
     FROM json_each(?) p
     JOIN storage_retention_bindings b ON b.source_id = json_extract(p.value, '$.sourceId')
       AND b.max_age_days = json_extract(p.value, '$.maxAgeDays')
     JOIN storage_source_incarnations i ON i.source_id = b.source_id AND i.incarnation = b.source_incarnation
     JOIN sources s ON s.id = b.source_id
     WHERE b.active = 1
       AND NOT EXISTS (SELECT 1 FROM removed_sources r WHERE r.id = b.source_id)`,
    )
    .all(JSON.stringify(desired));
  const bySource = new Map(rows.map((row) => [row.sourceId, row]));
  return desired.flatMap((policy) => {
    const bound = bySource.get(policy.sourceId);
    return bound ? [bound] : [];
  });
}

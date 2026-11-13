// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { SOURCE_HOSTING_DEVICE_KINDS } from "@omnesis/types";
import { sourceFiltersInUse } from "./source-filters-in-use.js";
import { getSourceScopes } from "./scope-descriptors.js";
import type { ScopeRefreshEpochs, ScopeRef, SourceScopeRefreshState } from "@omnesis/types";
import type { Db } from "../data/types.js";

export function createScopeRefreshRequirementsSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scope_native_kinds(source_id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(source_id,kind)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS source_scope_refresh_requirements(source_id TEXT NOT NULL,kind TEXT NOT NULL,epoch TEXT NOT NULL,request_id TEXT,PRIMARY KEY(source_id,kind)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS source_scope_host_support(source_id TEXT NOT NULL,device_id TEXT NOT NULL,kind TEXT NOT NULL,supported INTEGER NOT NULL,fenced INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_id,device_id,kind)) WITHOUT ROWID;`);
  if (
    !db
      .prepare<[], { name: string }>("PRAGMA table_info(source_scope_refresh_requirements)")
      .all()
      .some((column) => column.name === "request_id")
  )
    db.exec("ALTER TABLE source_scope_refresh_requirements ADD COLUMN request_id TEXT");
}
export function sourceScopeRefreshState(db: Db, sourceId: string): SourceScopeRefreshState {
  const result: SourceScopeRefreshState = { epochs: {}, requestIds: {} };
  for (const row of db
    .prepare<[string], { kind: ScopeRef["kind"]; epoch: string; request_id: string | null }>(
      "SELECT kind,epoch,request_id FROM source_scope_refresh_requirements WHERE source_id=?",
    )
    .all(sourceId)) {
    result.epochs[row.kind] = row.epoch;
    if (row.request_id) result.requestIds[row.kind] = row.request_id;
  }
  return result;
}
export function recordNativeScopeKind(db: Db, sourceId: string, kind: ScopeRef["kind"]): void {
  db.prepare("INSERT OR IGNORE INTO scope_native_kinds VALUES(?,?)").run(sourceId, kind);
}
export function sourceScopeRefreshEpochs(db: Db, sourceId: string): ScopeRefreshEpochs {
  return Object.fromEntries(
    db
      .prepare<[string], { kind: ScopeRef["kind"]; epoch: string }>(
        "SELECT kind,epoch FROM source_scope_refresh_requirements WHERE source_id=?",
      )
      .all(sourceId)
      .map((row) => [row.kind, row.epoch]),
  );
}

/** Every explicit new cut needs distinct witnesses, including remote omissions. */
export function beginScopeRefresh(
  db: Db,
  sourceId: string,
  kind: string,
  epoch?: string,
  restart = false,
  requestId?: string,
): boolean {
  const previous = db
    .prepare<[string, string], { epoch: string; active: number }>(
      `SELECT r.epoch,f.active FROM source_scope_refresh_requirements r
    JOIN source_scope_refreshes f USING(source_id,kind) WHERE r.source_id=? AND r.kind=?`,
    )
    .get(sourceId, kind);
  if (previous && epoch !== undefined && previous.epoch !== epoch) return false;
  if (restart && previous && previous.epoch !== epoch) return false;
  if (previous?.active && !restart) return true;
  db.prepare(
    "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch,request_id) VALUES(?,?,?,?) ON CONFLICT(source_id,kind) DO UPDATE SET epoch=excluded.epoch,request_id=excluded.request_id",
  ).run(sourceId, kind, randomUUID(), requestId ?? null);
  return true;
}

/** Whether a collector has reported this kind for the source, now or in an earlier refresh. */
function hasNativeScopeState(db: Db, sourceId: string, kind: string): boolean {
  return !!(kind === "participant"
    ? db
        .prepare("SELECT 1 FROM scope_conversations WHERE source_id=? AND mode='snapshot' LIMIT 1")
        .get(sourceId)
    : db
        .prepare(
          `SELECT 1 FROM scope_native_kinds WHERE source_id=? AND kind=?
          UNION ALL SELECT 1 FROM source_scope_kind_readiness WHERE source_id=? AND kind=? AND ready=1
          UNION ALL SELECT 1 FROM source_scope_refreshes WHERE source_id=? AND kind=? LIMIT 1`,
        )
        .get(sourceId, kind, sourceId, kind, sourceId, kind));
}

/**
 * Require a refresh of one kind and withdraw its readiness until a collector
 * completes it. `keepActiveEpoch` leaves a refresh already under way on its
 * epoch, so its scan in progress still counts; otherwise the epoch is new and
 * a scan made under the previous one completes nothing.
 */
function requireScopeRefresh(
  db: Db,
  sourceId: string,
  kind: string,
  keepActiveEpoch: boolean,
): void {
  const current = keepActiveEpoch
    ? db
        .prepare<[string, string], { epoch: string; active: number }>(
          `SELECT r.epoch,f.active FROM source_scope_refresh_requirements r
        JOIN source_scope_refreshes f USING(source_id,kind) WHERE r.source_id=? AND r.kind=?`,
        )
        .get(sourceId, kind)
    : undefined;
  const epoch = current?.active ? current.epoch : randomUUID();
  db.prepare(
    "INSERT INTO source_scope_refresh_requirements(source_id,kind,epoch) VALUES(?,?,?) ON CONFLICT(source_id,kind) DO UPDATE SET request_id=CASE WHEN source_scope_refresh_requirements.epoch<>excluded.epoch THEN NULL ELSE source_scope_refresh_requirements.request_id END,epoch=excluded.epoch",
  ).run(sourceId, kind, epoch);
  db.prepare(
    "INSERT INTO source_scope_refreshes VALUES(?,?,1) ON CONFLICT(source_id,kind) DO UPDATE SET active=1 WHERE active<>1",
  ).run(sourceId, kind);
  db.prepare(
    "INSERT INTO source_scope_kind_readiness VALUES(?,?,0) ON CONFLICT(source_id,kind) DO UPDATE SET ready=0 WHERE ready<>0",
  ).run(sourceId, kind);
}

/**
 * Start every kind a collector has reported, for any source, on a new refresh,
 * and withdraw the readiness of every kind. Used when the gateway forgets its
 * fact state: nothing a collector reported before then may be taken as
 * complete afterwards, and the new epoch is what makes it report again.
 */
export function restartEveryNativeScopeRefresh(db: Db): void {
  const reported = db
    .prepare<[], { source_id: string; kind: string }>(
      `SELECT source_id, kind FROM scope_native_kinds
       UNION SELECT source_id, kind FROM source_scope_kind_readiness
       UNION SELECT source_id, kind FROM source_scope_refreshes
       UNION SELECT source_id, kind FROM source_scope_refresh_requirements
       UNION SELECT DISTINCT source_id, 'participant' FROM scope_conversations WHERE mode='snapshot'`,
    )
    .all();
  for (const { source_id, kind } of reported) requireScopeRefresh(db, source_id, kind, false);
}

/** Whether a host still attached to the source cannot report this kind. */
function hasUnsupportedScopeHost(db: Db, sourceId: string, kind: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM source_scope_host_support h JOIN devices d ON d.id=h.device_id
      WHERE h.source_id=? AND h.kind=? AND h.supported=0 AND d.revoked_at IS NULL
        AND (EXISTS(SELECT 1 FROM sources s WHERE s.id=h.source_id AND s.device_id=h.device_id)
          OR EXISTS(SELECT 1 FROM source_devices m WHERE m.source_id=h.source_id AND m.device_id=h.device_id))
      LIMIT 1`,
    )
    .get(sourceId, kind);
}

/**
 * Close the fences of hosts that no longer hold the kind back: ones that now
 * report it, were detached, or were revoked. Such a host may have written
 * after any scan made while it was attached, and the collector that made that
 * scan does not report it again, so the kind starts one new refresh. While a
 * host that cannot report the kind is still attached nothing changes: its
 * fence stays, and no further refresh is asked for. Returns whether a new
 * refresh was started.
 */
function settleScopeHostFences(db: Db, sourceId: string, kind: string): boolean {
  const fenced = db
    .prepare(
      "SELECT 1 FROM source_scope_host_support WHERE source_id=? AND kind=? AND fenced=1 LIMIT 1",
    )
    .get(sourceId, kind);
  if (!fenced || hasUnsupportedScopeHost(db, sourceId, kind)) return false;
  db.prepare(
    "UPDATE source_scope_host_support SET fenced=0 WHERE source_id=? AND kind=? AND fenced=1",
  ).run(sourceId, kind);
  requireScopeRefresh(db, sourceId, kind, false);
  return true;
}

/**
 * A source-wide mutable cut is invalid once an unsupported host may miss
 * native changes. Such a host is fenced once: the kind is refreshed and stays
 * unready for as long as the host is attached and cannot report it, however
 * many pages it writes. Nothing is recorded while source filters are not in use.
 */
export function requireScopeRefreshForHost(
  db: Db,
  deviceId: string,
  admittedSourceId?: string,
): void {
  if (!sourceFiltersInUse(db)) return;
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scope_native_kinds'")
      .get()
  )
    return;
  const actor = db
    .prepare<[string], { kind: string; capabilities: string; revoked_at: number | null }>(
      "SELECT kind,capabilities,revoked_at FROM devices WHERE id=?",
    )
    .get(deviceId);
  if (
    !actor ||
    actor.revoked_at !== null ||
    !SOURCE_HOSTING_DEVICE_KINDS.some((kind) => kind === actor.kind)
  )
    return;
  let range: { min?: number; max?: number } | undefined;
  try {
    range = JSON.parse(actor.capabilities).sourceScopes;
  } catch {
    range = undefined;
  }
  const sources =
    admittedSourceId === undefined
      ? db
          .prepare<[string, string], { id: string; type: string }>(
            `SELECT s.id,s.type FROM sources s WHERE s.device_id=? OR EXISTS
      (SELECT 1 FROM source_devices m WHERE m.source_id=s.id AND m.device_id=?)`,
          )
          .all(deviceId, deviceId)
      : db
          .prepare<[string], { id: string; type: string }>("SELECT id,type FROM sources WHERE id=?")
          .all(admittedSourceId);
  db.transaction(() => {
    for (const source of sources)
      for (const item of getSourceScopes(db, source.type)?.items ?? []) {
        if (item.link !== "changes" && item.link !== "hierarchy") continue;
        const requirement = db
          .prepare("SELECT 1 FROM source_scope_refresh_requirements WHERE source_id=? AND kind=?")
          .get(source.id, item.kind);
        const minimum = item.link === "hierarchy" || requirement ? 2 : 1;
        const supported =
          Number.isSafeInteger(range?.min) &&
          Number.isSafeInteger(range?.max) &&
          Number(range?.min) >= 1 &&
          Number(range?.max) >= Number(range?.min) &&
          Number(range?.min) <= minimum &&
          Number(range?.max) >= minimum;
        const prior = db
          .prepare<[string, string, string], { supported: number; fenced: number }>(
            "SELECT supported,fenced FROM source_scope_host_support WHERE source_id=? AND device_id=? AND kind=?",
          )
          .get(source.id, deviceId, item.kind);
        if (!prior || prior.supported !== +supported)
          db.prepare(
            `INSERT INTO source_scope_host_support VALUES(?,?,?,?,0) ON CONFLICT(source_id,device_id,kind)
        DO UPDATE SET supported=excluded.supported`,
          ).run(source.id, deviceId, item.kind, +supported);
        if (supported) {
          // A host that reports the kind settles the source's fences on each
          // of its writes: its own after an update, and those of hosts that
          // were detached or revoked, which never write again to close theirs.
          settleScopeHostFences(db, source.id, item.kind);
          continue;
        }
        if (prior?.fenced || !hasNativeScopeState(db, source.id, item.kind)) continue;
        requireScopeRefresh(db, source.id, item.kind, true);
        db.prepare(
          "UPDATE source_scope_host_support SET fenced=1 WHERE source_id=? AND device_id=? AND kind=?",
        ).run(source.id, deviceId, item.kind);
      }
  })();
}

/** Reclassify persisted unsupported hosts before the gateway accepts corpus reads. */
export function requireScopeRefreshForStoredHosts(db: Db): void {
  const hosts = db
    .prepare<[], { device_id: string }>(
      "SELECT device_id FROM sources UNION SELECT device_id FROM source_devices",
    )
    .all();
  for (const host of hosts) requireScopeRefreshForHost(db, host.device_id);
}

/**
 * Whether a refresh of this kind may be completed with `epoch`: it is the
 * epoch asked for, and no host still attached is unable to report the kind.
 */
export function canCompleteScopeRefresh(
  db: Db,
  sourceId: string,
  kind: string,
  epoch?: string,
): boolean {
  if (hasUnsupportedScopeHost(db, sourceId, kind)) return false;
  const required = db
    .prepare<[string, string], { epoch: string }>(
      "SELECT epoch FROM source_scope_refresh_requirements WHERE source_id=? AND kind=?",
    )
    .get(sourceId, kind);
  return !required || required.epoch === epoch;
}

/**
 * Accept or refuse the completion of a refresh. A fence left by a host that
 * has since stopped holding the kind back is closed here, which starts a new
 * refresh and refuses this completion.
 */
export function completeScopeRefresh(
  db: Db,
  sourceId: string,
  kind: string,
  epoch?: string,
): boolean {
  if (!canCompleteScopeRefresh(db, sourceId, kind, epoch)) return false;
  return !settleScopeHostFences(db, sourceId, kind);
}

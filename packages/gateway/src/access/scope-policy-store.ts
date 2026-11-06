// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled } from "@omnesis/core";
import { isScopeQuarantined } from "./scope-quarantine.js";

import { createScopeStorageFloor, withScopePolicyMutation } from "./scope-storage-floor.js";
import { createScopePolicySourceIndex } from "./scope-policy-source-index.js";
import { encodeStoredScopePolicies, decodeStoredScopePolicies } from "./scope-policy-encoding.js";
import type { ScopePolicy } from "@omnesis/types";
import type { Db } from "../data/types.js";
import type { AccessGrantCapability } from "./types.js";

export class ScopePolicyEditError extends Error {}

export type ScopeOwner = "level" | "grant";
type ScopeRuleState = Pick<
  AccessGrantCapability,
  "capability" | "sourceMode" | "sourceIds" | "filterRevision" | "scopePolicies"
>;
type ScopeCapability = AccessGrantCapability["capability"];
export interface StoredScopeState {
  sourceMode: AccessGrantCapability["sourceMode"];
  sourceIds: string[];
  filterRevision: number;
  scopePolicies: ScopePolicy[];
}

/** Canonical boundaries stay separate from the conservative rows older gateways read. */
export function createScopePolicyStore(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS access_scope_capabilities (
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('level', 'grant')),
    owner_id TEXT NOT NULL,
    capability TEXT NOT NULL CHECK(capability IN ('direct', 'answer')),
    source_mode TEXT NOT NULL CHECK(source_mode IN ('all', 'allowlist', 'denylist')),
    source_ids TEXT NOT NULL,
    filter_revision INTEGER NOT NULL CHECK(filter_revision > 0),
    policies TEXT NOT NULL,
    PRIMARY KEY(owner_kind, owner_id, capability)
  )`);
  createScopePolicySourceIndex(db);
  createScopeStorageFloor(db);
  db.exec(`CREATE TRIGGER IF NOT EXISTS access_scope_grant_delete
    AFTER DELETE ON access_grants BEGIN
      DELETE FROM access_scope_capabilities WHERE owner_kind = 'grant' AND owner_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS access_scope_level_delete
    AFTER DELETE ON access_levels BEGIN
      DELETE FROM access_scope_capabilities WHERE owner_kind = 'level' AND owner_id = OLD.id;
    END;`);
}

export function readScopeState(
  db: Db,
  owner: ScopeOwner,
  id: string,
  capability: ScopeCapability,
): StoredScopeState | null {
  const row = db
    .prepare<
      [ScopeOwner, string, ScopeCapability],
      {
        source_mode: StoredScopeState["sourceMode"];
        source_ids: string;
        filter_revision: number;
        policies: string;
      }
    >(
      `SELECT source_mode, source_ids, filter_revision, policies FROM access_scope_capabilities
      WHERE owner_kind = ? AND owner_id = ? AND capability = ?`,
    )
    .get(owner, id, capability);
  if (!row) return null;
  const sourceIds: unknown = JSON.parse(row.source_ids);
  const rawPolicies: unknown = JSON.parse(row.policies);
  if (
    !Array.isArray(sourceIds) ||
    !sourceIds.every((value) => typeof value === "string") ||
    !Number.isSafeInteger(row.filter_revision) ||
    row.filter_revision <= 0 ||
    !Array.isArray(rawPolicies)
  ) {
    throw new Error("Invalid stored scope authorization.");
  }
  const scopePolicies = decodeStoredScopePolicies(rawPolicies);
  const quarantined = isScopeQuarantined(db, owner, id, capability);
  return {
    sourceMode: quarantined ? "allowlist" : row.source_mode,
    sourceIds: quarantined ? [] : sourceIds,
    filterRevision: row.filter_revision,
    scopePolicies,
  };
}

export function writeScopeState(
  db: Db,
  owner: ScopeOwner,
  id: string,
  capability: ScopeCapability,
  state: StoredScopeState | null,
): void {
  withScopePolicyMutation(db, owner, id, () => {
    db.prepare(
      "DELETE FROM access_scope_legacy_denials WHERE owner_kind=? AND owner_id=? AND capability=?",
    ).run(owner, id, capability);
    if (!state) {
      db.prepare(
        "DELETE FROM access_scope_capabilities WHERE owner_kind = ? AND owner_id = ? AND capability = ?",
      ).run(owner, id, capability);
      return;
    }
    if (capability === "notes") throw new Error("Notes cannot carry source filters.");
    db.prepare(
      `INSERT INTO access_scope_capabilities
    (owner_kind, owner_id, capability, source_mode, source_ids, filter_revision, policies)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_kind, owner_id, capability) DO UPDATE SET
    source_mode=excluded.source_mode, source_ids=excluded.source_ids,
    filter_revision=excluded.filter_revision, policies=excluded.policies`,
    ).run(
      owner,
      id,
      capability,
      state.sourceMode,
      JSON.stringify(state.sourceIds),
      state.filterRevision,
      JSON.stringify(encodeStoredScopePolicies(state.scopePolicies)),
    );
  });
}

export { conservativeSources } from "./scope-legacy-boundary.js";

/** Reject a stale editor before it can replace or omit a filtered capability. */
export function assertScopeEditRevisions(
  previous: readonly ScopeRuleState[],
  next: readonly ScopeRuleState[],
  expected?: Partial<Record<"direct" | "answer", number>>,
): void {
  for (const rule of next) {
    const current = previous.find((candidate) => candidate.capability === rule.capability);
    const mapped = rule.capability === "notes" ? undefined : expected?.[rule.capability];
    if (
      (rule.filterRevision ?? mapped ?? 0) !== (current?.filterRevision ?? 0) ||
      (mapped !== undefined && mapped !== (current?.filterRevision ?? 0))
    ) {
      throw new Error("Stale source filter revision.");
    }
  }
  for (const current of previous) {
    if ((current.filterRevision ?? 0) === 0) continue;
    const replacement = next.find((rule) => rule.capability === current.capability);
    const supplied = current.capability === "notes" ? undefined : expected?.[current.capability];
    if ((replacement?.filterRevision ?? supplied) !== current.filterRevision) {
      throw new Error("Stale source filter revision.");
    }
  }
}

/** Called only for owner edits. Internal level copies preserve already-authorized policies. */
export function nextScopeState(
  current: ScopeRuleState | undefined,
  next: ScopeRuleState,
  levelId: string,
): StoredScopeState | null {
  const scopePolicies = next.scopePolicies ?? [];
  if (next.capability === "notes" && scopePolicies.length)
    throw new Error("Notes cannot carry source filters.");
  for (const policy of scopePolicies) {
    if (
      typeof policy.audience !== "object" ||
      policy.audience.accessLevel !== levelId ||
      policy.audience.capability !== next.capability
    )
      throw new Error("Invalid filter audience.");
    const listed = next.sourceIds.includes(policy.sourceId);
    if (next.sourceMode === "allowlist" ? !listed : next.sourceMode === "denylist" && listed) {
      throw new Error("A filter must belong to a granted source.");
    }
  }
  const changed = JSON.stringify(current?.scopePolicies ?? []) !== JSON.stringify(scopePolicies);
  if (changed && !experimentalEnabled())
    throw new Error("Source filters require experimental mode.");
  const revision = (current?.filterRevision ?? 0) + Number(changed);
  if (!revision) return null;
  return {
    sourceMode: next.sourceMode,
    sourceIds: next.sourceIds,
    filterRevision: revision,
    scopePolicies,
  };
}

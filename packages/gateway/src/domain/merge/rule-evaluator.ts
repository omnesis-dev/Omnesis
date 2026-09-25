// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import { markPeopleGraphDirty } from "../../data/DirtyMarks.js";
import {
  advanceOccWatermark,
  captureOccVersion,
  readOccMeta,
} from "../../data/occ-materialized.js";
import {
  type MergeEquivalenceRow,
  type MergeEquivalenceSnapshot,
  type MergeEquivalencesIoData,
  type MergeRuleDbRow,
  type UpsertMergeEquivalencesResult,
} from "./types.js";

const log = createLogger("gateway:people");

/**
 * Pure-read evaluator. For each active rule, find people matching
 * each side via `person_aliases`. Build a graph: every cross-product
 * of (side A people × side B people) is an edge. Compute connected
 * components (union-find). For each component, pick the canonical
 * root deterministically:
 *
 *   1. is_self person wins (only one self exists; explicit invariant)
 *   2. earliest first_seen
 *   3. lexicographic id (final tiebreak)
 *
 * For every non-root member, emit (from=member, to=root). The
 * `winner_side` field on rules is *advisory* — it can't always be
 * honored when chained rules disagree. Earliest first_seen is the
 * deterministic tiebreaker; winner_side only matters when the
 * canonical-pick is ambiguous.
 *
 * Self-aware: if any person in the component is `is_self=TRUE`, that
 * person becomes the root regardless of first_seen. This preserves
 * the user-merging-with-self case the user signed off on.
 *
 * Designed for the IO worker (read-only handle). Worst case:
 * O(rules + people-in-graph). At thousands of rules + thousands of
 * matched people, this is sub-second.
 */
/**
 * IO-only phase: load rules, resolve aliases, fetch person metadata.
 * Returns a serializable intermediate for the CPU phase.
 */
export function fetchMergeEquivalencesData(db: Db): MergeEquivalencesIoData {
  const dirtyVersion = captureOccVersion(db, "merge_rules");
  const computedAt = new Date().toISOString();

  const rules = db.prepare<[], MergeRuleDbRow>("SELECT * FROM merge_rules WHERE active = 1").all();
  if (rules.length === 0) {
    return { dirtyVersion, computedAt, resolvedRules: [], collapsedRuleIds: [], personMeta: [] };
  }

  const resolveCache = new Map<string, string[]>();
  const resolve = (side: { side_alias_type: string; side_alias: string }): string[] => {
    const key = `${side.side_alias_type}:${side.side_alias}`;
    const cached = resolveCache.get(key);
    if (cached) return cached;
    const isName = side.side_alias_type === "name";
    const rows = isName
      ? db
          .prepare<
            [string],
            { person_id: string }
          >("SELECT person_id FROM person_aliases WHERE alias_type = 'name' AND LOWER(alias) = ?")
          .all(side.side_alias)
      : db
          .prepare<
            [string, string],
            { person_id: string }
          >("SELECT person_id FROM person_aliases WHERE alias_type = ? AND alias = ?")
          .all(side.side_alias_type, side.side_alias);
    const ids = rows.map((r) => r.person_id);
    resolveCache.set(key, ids);
    return ids;
  };

  const sameSet = (a: string[], b: string[]): boolean => {
    if (a.length === 0 || a.length !== b.length) return false;
    const sa = new Set(a);
    for (const id of b) if (!sa.has(id)) return false;
    return true;
  };

  const resolvedRules: MergeEquivalencesIoData["resolvedRules"] = [];
  const collapsedRuleIds: string[] = [];
  const allPersonIds = new Set<string>();

  for (const rule of rules) {
    const sideA = resolve({
      side_alias_type: rule.side_a_alias_type,
      side_alias: rule.side_a_alias,
    });
    const sideB = resolve({
      side_alias_type: rule.side_b_alias_type,
      side_alias: rule.side_b_alias,
    });
    if (sideA.length === 0 || sideB.length === 0) continue;
    if (sameSet(sideA, sideB)) {
      collapsedRuleIds.push(rule.id);
      continue;
    }
    resolvedRules.push({ ruleId: rule.id, sideA, sideB, winnerSide: rule.winner_side });
    for (const id of sideA) allPersonIds.add(id);
    for (const id of sideB) allPersonIds.add(id);
  }

  const personMeta: MergeEquivalencesIoData["personMeta"] = [];
  if (allPersonIds.size > 0) {
    const ids = [...allPersonIds];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare<
        unknown[],
        { id: string; first_seen: string; is_self: number }
      >(`SELECT id, first_seen, is_self FROM people WHERE id IN (${placeholders})`)
      .all(...ids);
    for (const r of rows) {
      personMeta.push({ id: r.id, firstSeen: r.first_seen, isSelf: r.is_self === 1 });
    }
  }

  return { dirtyVersion, computedAt, resolvedRules, collapsedRuleIds, personMeta };
}

/**
 * Pure-compute phase: union-find + canonical selection. No DB access.
 * Receives pre-fetched data from `fetchMergeEquivalencesData`.
 */
export function computeMergeEquivalencesFromData(
  data: MergeEquivalencesIoData,
): MergeEquivalenceSnapshot {
  if (data.resolvedRules.length === 0) {
    return {
      equivalences: [],
      dirtyVersion: data.dirtyVersion,
      computedAt: data.computedAt,
      collapsedRuleIds: data.collapsedRuleIds,
    };
  }

  const parent = new Map<string, string>();
  const ensureNode = (id: string): void => {
    if (!parent.has(id)) parent.set(id, id);
  };
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, parent.get(next) ?? next);
      cur = next;
    }
    return cur;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent.set(ra, rb);
  };

  const votes = new Map<string, number>();

  for (const rule of data.resolvedRules) {
    for (const id of rule.sideA) ensureNode(id);
    for (const id of rule.sideB) ensureNode(id);
    const anchorB = rule.sideB[0];
    for (const id of rule.sideA) union(id, anchorB);
    const anchorA = rule.sideA[0];
    for (const id of rule.sideB) union(id, anchorA);
    const winners = rule.winnerSide === "a" ? rule.sideA : rule.sideB;
    for (const id of winners) {
      votes.set(id, (votes.get(id) ?? 0) + 1);
    }
  }

  const components = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const arr = components.get(root);
    if (arr) arr.push(id);
    else components.set(root, [id]);
  }

  const metaMap = new Map<string, { firstSeen: string; isSelf: boolean }>();
  for (const m of data.personMeta) {
    metaMap.set(m.id, { firstSeen: m.firstSeen, isSelf: m.isSelf });
  }

  const equivalences: MergeEquivalenceRow[] = [];
  for (const [_root, members] of components) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => {
      const ma = metaMap.get(a);
      const mb = metaMap.get(b);
      const sa = ma?.isSelf ? 1 : 0;
      const sb = mb?.isSelf ? 1 : 0;
      if (sa !== sb) return sb - sa;
      const va = votes.get(a) ?? 0;
      const vb = votes.get(b) ?? 0;
      if (va !== vb) return vb - va;
      const fa = ma?.firstSeen ?? "";
      const fb = mb?.firstSeen ?? "";
      const c = fa.localeCompare(fb);
      if (c !== 0) return c;
      return a.localeCompare(b);
    });
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      equivalences.push({ fromId: sorted[i], toId: canonical });
    }
  }

  return {
    equivalences,
    dirtyVersion: data.dirtyVersion,
    computedAt: data.computedAt,
    collapsedRuleIds: data.collapsedRuleIds,
  };
}

/** Combined IO + CPU for backward compat and tests. */
export function computeMergeEquivalences(db: Db): MergeEquivalenceSnapshot {
  return computeMergeEquivalencesFromData(fetchMergeEquivalencesData(db));
}

/**
 * Pure-write applicator. Applies the snapshot to `person_equivalences`
 * + `people.merged_into`. Idempotent: re-running with the same
 * snapshot is a no-op (diff filter skips matching rows).
 *
 * Yieldable: when `options.token` is supplied, applies in chunks of
 * `chunkSize` (default 500) and bails on preempt-token request between
 * chunks. The meta watermark is only advanced on a complete pass —
 * partial yields don't advance, so the next tick re-fires (cheap
 * because the diff filter skips already-applied rows).
 */
export function upsertMergeEquivalences(
  db: Db,
  snapshot: MergeEquivalenceSnapshot,
  options: { token?: { requested(): boolean }; chunkSize?: number } = {},
): UpsertMergeEquivalencesResult {
  const chunkSize = Math.max(1, options.chunkSize ?? 500);
  const token = options.token;

  // Stale-snapshot guard. Two apply paths can compute concurrently (the
  // periodic eval and the user-action fast lane); the writer serializes
  // their applies, but a snapshot computed against an OLDER dirty version
  // than one already applied must not overwrite the newer state. Equal
  // versions re-apply harmlessly — the diff filter skips matching rows.
  const applied = readOccMeta(db, "merge_rules").lastComputedVersion;
  if (snapshot.dirtyVersion < applied) {
    log.info(
      `Eval apply skipped: snapshot dirtyVersion ${snapshot.dirtyVersion} predates applied ${applied}`,
    );
    return { added: 0, changed: 0, removed: 0, unchanged: 0, deletedCollapsed: 0 };
  }

  // Load the current equivalences into memory for diffing.
  const current = new Map<string, string>();
  for (const r of db
    .prepare<
      [],
      { from_id: string; to_id: string }
    >("SELECT from_id, to_id FROM person_equivalences")
    .iterate()) {
    current.set(r.from_id, r.to_id);
  }

  // Build the desired state into a Map for O(1) lookups.
  const desired = new Map<string, string>();
  for (const eq of snapshot.equivalences) desired.set(eq.fromId, eq.toId);

  // Diff into three buckets:
  //   - add: in desired, not in current
  //   - change: in both, different toId
  //   - remove: in current, not in desired
  // Anything in both with same toId is unchanged (skip).
  const toAdd: MergeEquivalenceRow[] = [];
  const toChange: MergeEquivalenceRow[] = [];
  const toRemove: string[] = [];
  let unchanged = 0;
  for (const [fromId, toId] of desired) {
    const cur = current.get(fromId);
    if (cur === undefined) toAdd.push({ fromId, toId });
    else if (cur !== toId) toChange.push({ fromId, toId });
    else unchanged++;
  }
  for (const fromId of current.keys()) {
    if (!desired.has(fromId)) toRemove.push(fromId);
  }

  const insertEq = db.prepare(
    "INSERT INTO person_equivalences (from_id, to_id, applied_at) VALUES (?, ?, ?)",
  );
  const updateEq = db.prepare(
    "UPDATE person_equivalences SET to_id = ?, applied_at = ? WHERE from_id = ?",
  );
  const deleteEq = db.prepare("DELETE FROM person_equivalences WHERE from_id = ?");
  const setMergedInto = db.prepare(
    "UPDATE people SET merged_into = ?, updated_at = ? WHERE id = ?",
  );
  const clearMergedInto = db.prepare(
    "UPDATE people SET merged_into = NULL, updated_at = ? WHERE id = ?",
  );

  const now = snapshot.computedAt;
  const nowMs = Date.now();
  let added = 0;
  let changed = 0;
  let removed = 0;
  let yielded = false;

  // Helper to apply a chunk of operations under one transaction.
  const applyChunk = (ops: Array<() => void>): void => {
    const txn = db.transaction(() => {
      for (const op of ops) op();
    });
    txn();
  };

  // Apply removes first (unmerge), so subsequent merges don't conflict
  // with stale state. Each remove also clears the loser's merged_into.
  for (let i = 0; i < toRemove.length; i += chunkSize) {
    const slice = toRemove.slice(i, i + chunkSize);
    applyChunk(
      slice.map((fromId) => () => {
        deleteEq.run(fromId);
        clearMergedInto.run(now, fromId);
        removed++;
      }),
    );
    if (token?.requested()) {
      yielded = true;
      break;
    }
  }
  if (!yielded) {
    // Apply adds.
    for (let i = 0; i < toAdd.length; i += chunkSize) {
      const slice = toAdd.slice(i, i + chunkSize);
      applyChunk(
        slice.map(({ fromId, toId }) => () => {
          insertEq.run(fromId, toId, now);
          setMergedInto.run(toId, now, fromId);
          added++;
        }),
      );
      if (token?.requested()) {
        yielded = true;
        break;
      }
    }
  }
  if (!yielded) {
    // Apply changes (different to_id from current).
    for (let i = 0; i < toChange.length; i += chunkSize) {
      const slice = toChange.slice(i, i + chunkSize);
      applyChunk(
        slice.map(({ fromId, toId }) => () => {
          updateEq.run(toId, now, fromId);
          setMergedInto.run(toId, now, fromId);
          changed++;
        }),
      );
      if (token?.requested()) {
        yielded = true;
        break;
      }
    }
  }

  // Orphan-pointer sweep: clear any `people.merged_into` that has no
  // backing `person_equivalences` row. This catches out-of-band
  // corruption (manual SQL edits, half-rolled-back transactions,
  // pre-rules-era leftovers, self-cycles like `merged_into = id`)
  // that the diff loop above can't detect — it only operates on rows
  // that are or were in `person_equivalences`. `merged_into` is
  // supposed to be purely derived from rules; orphan pointers are
  // an inconsistency the eval pass should heal.
  let orphansCleared = 0;
  if (!yielded) {
    const sweep = db
      .prepare(
        `UPDATE people SET merged_into = NULL, updated_at = ?
         WHERE merged_into IS NOT NULL
           AND id NOT IN (SELECT from_id FROM person_equivalences)`,
      )
      .run(now);
    orphansCleared = sweep.changes;
    if (orphansCleared > 0) {
      log.warn(`Cleared ${orphansCleared} orphan merged_into pointer(s) (no backing equivalence)`);
    }
  }

  // Auto-delete collapsed rules. A collapsed rule has both sides
  // resolving to the same person — the merge it asserts has already
  // happened by some other path, so the rule is doing no useful work
  // and lingers as UI noise. We DELETE rather than deactivate because
  // there's nothing to "veto" — the merge is real, the operator's
  // intent is honored, and a kept rule would just confuse the
  // operator into thinking they still need to review it.
  //
  // Don't bump `merge_rules_meta.dirty_version` from here: the deletes
  // produce zero new equivalences (collapsed rules contributed
  // nothing in compute), so re-eval would be a no-op. Skipping the
  // bump lets the watermark advance below cleanly.
  let deletedCollapsed = 0;
  if (!yielded && snapshot.collapsedRuleIds.length > 0) {
    const placeholders = snapshot.collapsedRuleIds.map(() => "?").join(",");
    const result = db
      .prepare(`DELETE FROM merge_rules WHERE id IN (${placeholders})`)
      .run(...snapshot.collapsedRuleIds);
    deletedCollapsed = result.changes;
    if (deletedCollapsed > 0) {
      log.info(
        `Eval pass: deleted ${deletedCollapsed} collapsed rule(s) (both sides resolved to same person)`,
      );
    }
  }

  // Score graph reshuffled if any equivalences moved.
  if (added > 0 || changed > 0 || removed > 0 || orphansCleared > 0) {
    markPeopleGraphDirty(db);
  }

  // Only advance the watermark on a complete pass — partial yields
  // leave dirty_version > last_evaluated_version so the next tick
  // re-runs. The diff filter makes the re-run cheap (most rows skip).
  if (!yielded) {
    advanceOccWatermark(db, {
      job: "merge_rules",
      capturedVersion: snapshot.dirtyVersion,
      nowMs,
    });
  }

  return { added, changed, removed, unchanged, deletedCollapsed };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Grouping of the Sources table by source type.
//
// A type with several accounts — one per mailbox, workspace or bank
// connection — would otherwise repeat its family name on every row and push
// everything else off the page. Rows of such a type are folded under one
// header that names the family once and summarises its accounts; a type with
// a single account renders as the plain row it always was.
//
// Nothing here knows any particular source: the family identity is whatever
// the meta cache holds under the bare type key, and each account's label is
// whatever the source itself reported.

import { sourceTypeOf, sourceAccountOf } from "./source-id.js";

/** The state a Sources row shows: a removing row reports its purge, not a sync. */
export function sourceRowState(row) {
  return row.removing ? "removing" : (row.syncStatus?.state ?? "idle");
}

/** The words a state pill and a group summary show for a state. */
export function sourceStateLabel(state) {
  switch (state) {
    case "needs-auth":
      return "needs auth";
    case "rate-limited":
      return "rate limited";
    case "auth-expiring":
      return "expiring";
    default:
      return state;
  }
}

/**
 * States that ask the operator to do something. A group holding one starts
 * expanded, so the row that needs attention is on screen without a click.
 */
export const ATTENTION_STATES = new Set(["error", "needs-auth", "auth-expiring", "stale"]);

// Summary order: what needs attention first, then work in flight, then rest.
const STATE_ORDER = [
  "error",
  "needs-auth",
  "auth-expiring",
  "stale",
  "rate-limited",
  "syncing",
  "removing",
  "paused",
  "idle",
  "synced",
  "completed",
];

function stateRank(state) {
  const i = STATE_ORDER.indexOf(state);
  return i === -1 ? STATE_ORDER.length : i;
}

/** The number a row counts toward its group's total. */
export function sourceRowCount(row) {
  return row.displayCount ?? row.documentCount ?? 0;
}

/**
 * The primary text of an account row inside a group.
 *
 * The source's own label when it has one. A label that only repeats the
 * family name — an account that has not reported a name of its own, so the
 * meta lookup fell back to its type — says nothing the group header has not,
 * so the account half of the id stands in for it.
 */
export function accountRowLabel(sourceId, ownLabel, familyLabel) {
  if (ownLabel && ownLabel !== familyLabel) return ownLabel;
  return sourceAccountOf(sourceId) || sourceId;
}

/**
 * Fold Sources rows into display entries, in the rows' own order.
 *
 * Returns one entry per source type, placed where that type's first row was:
 *   - `{ kind: "single", type, row }` for a type with one row;
 *   - `{ kind: "group", type, rows, states, total, unitName, lastSyncAt,
 *       attention }` for a type with two or more, where `states` is the
 *       per-state row count in summary order, `total` the sum of the rows'
 *       counts, `unitName` the rows' shared unit noun (null when they
 *       disagree or declare none), `lastSyncAt` the newest sync among them
 *       and `attention` whether any row is in an attention state.
 */
export function groupSourceRows(rows) {
  const byType = new Map();
  const order = [];
  for (const row of rows) {
    const type = sourceTypeOf(row.id);
    let bucket = byType.get(type);
    if (!bucket) {
      bucket = [];
      byType.set(type, bucket);
      order.push(type);
    }
    bucket.push(row);
  }
  return order.map((type) => {
    const members = byType.get(type);
    if (members.length === 1) return { kind: "single", type, row: members[0] };
    const stateCounts = new Map();
    let total = 0;
    let lastSyncAt = null;
    let attention = false;
    const units = new Set();
    for (const row of members) {
      const state = sourceRowState(row);
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
      if (ATTENTION_STATES.has(state)) attention = true;
      total += sourceRowCount(row);
      units.add(row.unitName ?? row.syncStatus?.unitName ?? null);
      const synced = row.syncStatus?.lastSyncAt ?? null;
      if (synced && (!lastSyncAt || Date.parse(synced) > Date.parse(lastSyncAt))) lastSyncAt = synced;
    }
    const states = [...stateCounts.entries()]
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.state.localeCompare(b.state));
    const unitName = units.size === 1 ? [...units][0] : null;
    return { kind: "group", type, rows: members, states, total, unitName, lastSyncAt, attention };
  });
}

/** "14 syncing · 1 error · 1 synced", in summary order. */
export function groupStateSummary(states) {
  return states.map(({ state, count }) => `${count} ${sourceStateLabel(state)}`).join(" · ");
}

/**
 * Whether a group is expanded: the operator's own toggle when they made one,
 * else open exactly when one of its rows needs attention.
 */
export function groupExpanded(group, toggles) {
  const chosen = toggles?.[group.type];
  return typeof chosen === "boolean" ? chosen : group.attention;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a cell is *holding* something, or merely remembering it.
 *
 * A list says "this watch is tracking three things" from a count of the cells
 * it holds, and that count is not the claim it looks like. A `stateful.cooldown`
 * cell is a stamp — "this key last fired at T" — kept so a later arrival can be
 * suppressed; once `min_interval` has elapsed it suppresses nothing and is pure
 * history. A `stateful.persistence` cell whose window has drained holds no
 * arrivals. A `sql` cell at rest is the resting state itself. So a watch waiting
 * on nothing reports keys, which is the one claim the mark exists to make and
 * the one it must not make falsely.
 *
 * The obvious filter — `state = 'live'` — is wrong in the mirror direction: a
 * persistence cell two arms of three toward its floor is `accumulating`, and it
 * is exactly what an operator wants to see. Filtering it out would report
 * "nothing live" about a watch two thirds of the way to firing.
 *
 * "Holding" versus "remembering" is a per-node-type judgement, so each node type
 * contributes one here: a {@link HoldingKind} naming which columns decide it and
 * a single duration parameterising them. The aggregate then expresses all of
 * them in one SQL expression, which is what keeps the reading affordable on a
 * polled list — the alternative reads every cell of every watch to draw a
 * summary line.
 */

import { durationMs, parseDuration } from "../time/duration.js";

/**
 * How a node type decides its cells are holding something.
 *
 * Each member names the columns it reads. `opaque` is the honest answer for a
 * cell this cannot read — a node type added later, or a definition that no
 * longer parses — and it counts as holding: over-reporting a husk is a smaller
 * fault than a surface silently losing sight of a node type it cannot place.
 */
export type HoldingKind =
  /** Cooldown: the suppression window it stamped is still open. */
  | "suppressing"
  /** Persistence: an arrival still inside the window it is counted against. */
  | "window"
  /** Join and sequence: an arm has arrived, and the deadline has not passed. */
  | "slots"
  /** Wait: it has not reached the deadline whose expiry is its fire. */
  | "deadline"
  /** SQL: the predicate holds, and this episode of it has not fired yet. */
  | "predicate"
  /** LLM: the arm that armed this cell has not been fired on yet. */
  | "unfired"
  /** Anything this cannot read — assumed to be holding. */
  | "opaque";

/** One node's reading, against the watch and node the cells are keyed by. */
export interface WatchHoldingSpec {
  readonly watchId: string;
  readonly nodeId: string;
  readonly kind: HoldingKind;
  /**
   * The duration the kind is measured against, in milliseconds — the cooldown's
   * `min_interval`, the persistence window. Zero where the kind reads no
   * duration at all.
   */
  readonly ms: number;
}

/** Every node type this build can read, and what it reads. */
const KINDS: Readonly<Record<string, HoldingKind>> = {
  "stateful.cooldown": "suppressing",
  "stateful.persistence": "window",
  "stateful.and": "slots",
  "stateful.threshold": "slots",
  "stateful.sequence": "slots",
  "stateful.wait": "deadline",
  sql: "predicate",
  llm: "unfired",
};

/** Which field carries the duration a kind is measured against. */
const DURATION_FIELD: Readonly<Partial<Record<HoldingKind, string>>> = {
  suppressing: "min_interval",
  window: "duration",
};

/**
 * How to read every node of one stored watch.
 *
 * Takes the definition as stored rather than as parsed: this runs once per
 * watch on every poll of a list, and re-validating a document against the whole
 * DSL schema to learn two fields per node would cost more than the read it
 * feeds. A document it cannot walk yields no specs at all, which the aggregate
 * reads as `opaque` — the conservative direction.
 */
export function holdingSpecs(watchId: string, dsl: unknown): WatchHoldingSpec[] {
  const nodes = (dsl as { watch?: { nodes?: unknown } } | null)?.watch?.nodes;
  if (!Array.isArray(nodes)) return [];
  const specs: WatchHoldingSpec[] = [];
  const claimed = new Set<string>();
  for (const raw of nodes) {
    const node = raw as Record<string, unknown> | null;
    const nodeId = node?.id;
    const type = node?.type;
    if (typeof nodeId !== "string" || typeof type !== "string") continue;
    // One spec per node id, first declaration winning. The validator refuses a
    // duplicate id at install, so this only fires for a document stored by
    // something that did not validate — and the aggregate joins on the node,
    // so a second row would multiply that node's cells into the population
    // counts. Wrong numbers with nothing to raise is the worse failure.
    if (claimed.has(nodeId)) continue;
    claimed.add(nodeId);
    const declared = KINDS[type] ?? "opaque";
    const ms = durationOf(node, declared);
    // A kind whose duration cannot be read is demoted rather than measured
    // against nothing: the reading is only as good as the field it rests on.
    specs.push(
      ms === null
        ? { watchId, nodeId, kind: "opaque", ms: 0 }
        : { watchId, nodeId, kind: declared, ms },
    );
  }
  return specs;
}

/**
 * The declared duration in milliseconds; null when the kind needs one and this
 * document does not carry one it can read.
 *
 * Null rather than zero, because zero is a *decision* for the two kinds that
 * read a duration — it makes every cell read as long expired — and a document
 * whose window this build cannot parse is exactly the case the `opaque`
 * fallback exists for. Reading it as zero would report "nothing live" for a
 * watch that is holding something, which is the failure the whole reading is
 * meant to prevent.
 */
function durationOf(node: Record<string, unknown> | null, kind: HoldingKind): number | null {
  const field = DURATION_FIELD[kind];
  if (field === undefined) return 0;
  const declared = node?.[field];
  if (typeof declared !== "string") return null;
  const parsed = parseDuration(declared);
  return parsed === null ? null : durationMs(parsed);
}

/** The kinds {@link specRow} may write; anything else is written as `opaque`. */
const HOLDING_KINDS = [
  "suppressing",
  "window",
  "slots",
  "deadline",
  "predicate",
  "unfired",
  "opaque",
] as const satisfies readonly HoldingKind[];

/**
 * Every kind is written, and every written kind is decided.
 *
 * Three hand-kept lists — the union, the array above and the `CASE` below —
 * and a member missing from either of the last two fails silently: `specRows`
 * rewrites it to `opaque`, or the `CASE` falls through to `ELSE 1`. This makes
 * the first omission a type error; a test asserts the second.
 */
type EveryKindListed =
  Exclude<HoldingKind, (typeof HOLDING_KINDS)[number]> extends never ? true : never;
const _everyKindListed: EveryKindListed = true;
void _everyKindListed;

/**
 * Where the readings are put so a query can join to them.
 *
 * A temp table with a primary key rather than a `VALUES` list, and the
 * difference is not stylistic: SQLite builds no index over a `VALUES` CTE, so
 * joining cells to it is a full scan of every reading for every cell. On an
 * install with ten thousand cells and a thousand nodes that is a quarter of a
 * second, taken inside the write lease the rest of the gateway queues behind,
 * on a list that is polled. The keyed table makes the same read three
 * milliseconds, and its primary key is also what stops a document carrying two
 * nodes of one id from multiplying that node's cells into the counts.
 *
 * Temporary, so it belongs to this connection alone and no other writer can see
 * it; rewritten on each read, because it describes the definitions as they are
 * now.
 */
export const SPEC_TABLE = `CREATE TEMP TABLE IF NOT EXISTS watch_holding_spec (
      watch_id TEXT NOT NULL,
      node_id  TEXT NOT NULL,
      kind     TEXT NOT NULL,
      ms       INTEGER NOT NULL,
      PRIMARY KEY (watch_id, node_id)
    ) WITHOUT ROWID`;

/** One reading, as the columns {@link SPEC_TABLE} holds. */
export function specRow(spec: WatchHoldingSpec): [string, string, string, number] {
  return [
    spec.watchId,
    spec.nodeId,
    // Closed values, both. An unrecognised kind is written as `opaque` rather
    // than reaching the query, where it would match no branch and be held for
    // a reason nobody chose.
    HOLDING_KINDS.includes(spec.kind) ? spec.kind : "opaque",
    Number.isFinite(spec.ms) ? Math.trunc(spec.ms) : 0,
  ];
}

/**
 * The SQL that decides one cell, against a `spec` row joined to it.
 *
 * Written once here rather than at the query, so the reading a surface shows
 * and the reading the node type declares cannot come apart. `:now` is bound by
 * the caller; `c` is the cell and `s` its spec.
 *
 * A cell with no spec — a node the definition no longer declares, or a watch
 * whose document could not be walked — leaves `s.kind` null, which matches no
 * branch and falls to `ELSE 1`: held, for the reason `opaque` is.
 */
export const HOLDING_SQL = `CASE s.kind
      WHEN 'suppressing' THEN c.last_fired_at_ms IS NOT NULL AND c.last_fired_at_ms + s.ms > :now
      WHEN 'window'      THEN (SELECT MAX(a.value) FROM json_each(c.arrivals_json) a) + s.ms > :now
      WHEN 'slots'       THEN c.slots_json <> '{}'
                          AND (c.deadline_at_ms IS NULL OR c.deadline_at_ms > :now)
      WHEN 'deadline'    THEN c.deadline_at_ms IS NULL OR c.deadline_at_ms > :now
      WHEN 'predicate'   THEN c.held_since_ms IS NOT NULL
                          AND (c.last_fired_at_ms IS NULL OR c.last_fired_at_ms < c.held_since_ms)
      WHEN 'unfired'     THEN c.last_fired_at_ms IS NULL OR c.last_fired_at_ms < c.armed_at_ms
      ELSE 1
    END`;

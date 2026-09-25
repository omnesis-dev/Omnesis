// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each node carries forward.
 *
 * Every node has a **structured output** in addition to its fired/not-fired
 * signal, and downstream `$n.<node>.<field>` references are checked against it.
 * This module answers two questions the validator asks constantly: what does a
 * journal event of kind K look like, and what does a node of type T project
 * before any `output_map` renames it.
 *
 * The event field lists here are the journal payloads: the exact field sets
 * whatever produces the journal has to emit. Keeping them in one place means a
 * producer has a single list to satisfy rather than a scattering of string
 * literals to discover.
 */

import {
  BOOLEAN,
  ID,
  OBJECT,
  STRING,
  TIMESTAMP,
  UNKNOWN,
  listOf,
  type ValueType,
} from "../dsl/value-type.js";
import type { WatchNode } from "../dsl/schema.js";

export interface FieldInfo {
  readonly type: ValueType;
  /**
   * Whether a reference to this field can resolve to null at fire time.
   * A branch of an OR that did not fire contributes nulls, and the validator
   * requires those to be made null-safe before they reach a binding site.
   */
  readonly nullable: boolean;
}

export interface NodeOutput {
  readonly fields: ReadonlyMap<string, FieldInfo>;
  /**
   * Whether the field set is known to be complete. A SQL node with an unaliased
   * projection has result columns the analyzer cannot name, so a reference into
   * one of them is accepted untyped rather than reported as unknown — the
   * validator cannot prove it wrong. The unaliased projection itself is the
   * error; suppressing a second, speculative one here keeps the diagnostics
   * pointed at the actual defect.
   */
  readonly fieldsIncomplete: boolean;
  /** Whether `$n.<node>.$fired_by` is meaningful (OR and N-of-M only). */
  readonly supportsFiredBy: boolean;
  /** The node's key components, referenceable as `$n.<node>.$key.<component>`. */
  readonly keyComponents: ReadonlyMap<string, ValueType>;
}

export function fieldMap(
  entries: Record<string, ValueType>,
  nullable = false,
): Map<string, FieldInfo> {
  return new Map(Object.entries(entries).map(([name, type]) => [name, { type, nullable }]));
}

// ---------------------------------------------------------------------------
// Journal event payloads
// ---------------------------------------------------------------------------

/**
 * `doc.event` — the enriched document event.
 *
 * `people` arrives already resolved to canonical person ids. That is a
 * requirement on the producer, not an observation: people are resolved
 * asynchronously after a document is written, so an event emitted at write time
 * would carry no ids at all and every person-keyed predicate would be
 * undefined. The producer holds the event until people settle.
 */
export const DOC_EVENT_FIELDS: Record<string, ValueType> = {
  op: STRING,
  docId: ID,
  sourceId: STRING,
  providerId: STRING,
  documentType: STRING,
  title: STRING,
  /** The document's own event time — when the thing happened, not when it was
   * ingested. Every windowed operator evaluates on this. */
  semanticTime: TIMESTAMP,
  changedFields: listOf(STRING),
  contentChanged: BOOLEAN,
  /** Set when people settlement timed out and the event shipped unresolved. */
  degraded: BOOLEAN,
  metadata: OBJECT,
  people: listOf(OBJECT),
};

/** The leaf fields of an element of `$e.people`. */
export const PERSON_MENTION_FIELDS: Record<string, ValueType> = {
  personId: ID,
  role: STRING,
  isSelf: BOOLEAN,
};

/**
 * `analytics.row` — deduplicated before it reaches a watch, so `inserted`
 * really does mean a row nobody has seen. The raw ingest signal is not: it
 * re-fires for every row on every sync page, which would make a
 * naive count climb on every re-sync.
 */
export const ANALYTICS_ROW_FIELDS: Record<string, ValueType> = {
  op: STRING,
  table: STRING,
  sourceId: STRING,
  pk: OBJECT,
  row: OBJECT,
};

/** `loop.event` — before/after snapshots of an open loop. */
export const LOOP_EVENT_FIELDS: Record<string, ValueType> = {
  op: STRING,
  loopId: ID,
  before: OBJECT,
  after: OBJECT,
};

/** The fields of a loop snapshot, reachable as `$e.after.<field>`. */
export const LOOP_SNAPSHOT_FIELDS: Record<string, ValueType> = {
  state: STRING,
  title: STRING,
  deadline: TIMESTAMP,
  actors: listOf(ID),
  involved: listOf(ID),
  blockedBy: listOf(ID),
};

/** `timer.fired` — a due-gate coming due, journaled like every other event so
 * that replaying the journal replays time. */
export const TIMER_EVENT_FIELDS: Record<string, ValueType> = {
  timerId: STRING,
  dueAt: TIMESTAMP,
};

/** The event payload a source node's `$e.` references resolve against. */
export function eventFieldsFor(node: WatchNode): Record<string, ValueType> | null {
  switch (node.type) {
    case "source.document_event":
      return DOC_EVENT_FIELDS;
    case "source.analytics_row":
      return ANALYTICS_ROW_FIELDS;
    case "source.open_loop":
      return LOOP_EVENT_FIELDS;
    case "source.time":
      return TIMER_EVENT_FIELDS;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Node-native outputs
// ---------------------------------------------------------------------------

const EMPTY_KEYS: ReadonlyMap<string, ValueType> = new Map();

export function makeNodeOutput(
  fields: Map<string, FieldInfo>,
  options: {
    fieldsIncomplete?: boolean;
    supportsFiredBy?: boolean;
    keyComponents?: ReadonlyMap<string, ValueType>;
  } = {},
): NodeOutput {
  return {
    fields,
    fieldsIncomplete: options.fieldsIncomplete ?? false,
    supportsFiredBy: options.supportsFiredBy ?? false,
    keyComponents: options.keyComponents ?? EMPTY_KEYS,
  };
}

/** The `unknown`-typed field set a SQL projection produces. */
export function sqlResultFields(columns: readonly string[]): Map<string, FieldInfo> {
  const fields = new Map<string, FieldInfo>();
  for (const column of columns) {
    // `fires` is the firing signal, not payload — it is not addressable
    // downstream, because a downstream node reads the *fact* that this node
    // fired, never the boolean it fired on.
    if (column.toLowerCase() === "fires") continue;
    fields.set(column, { type: UNKNOWN, nullable: false });
  }
  return fields;
}

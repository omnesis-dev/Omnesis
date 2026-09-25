// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each node type is, in one exhaustive table.
 *
 * Every rule that varies by node type lives here rather than in a scattering of
 * sets and switch statements: whether the node is a trip-wire, whether it can
 * take a cancel input, which collision modes it accepts, whether it has
 * branches to report through `$fired_by`, and whether it holds an instance
 * between arm and fire.
 *
 * The table is keyed by the node union, so **adding a node type to the DSL
 * fails to compile until every one of these questions is answered for it.**
 * That is the point: the previous shape — several `Set<string>` lookups — let a
 * new node type silently inherit "no rules apply".
 */

import type { CollisionMode, SqlNode, WatchNode, WatchNodeType } from "../dsl/schema.js";

export interface NodeTraits {
  /** A trip-wire: no inputs, instantiated by a journal event or a timer. */
  readonly source: boolean;
  /** Whether a `cancel` input means anything on this node. */
  readonly cancellable: boolean;
  /**
   * The collision modes this node accepts. Empty means the node evaluates
   * instantly on arm and holds nothing that a second arm could collide with.
   */
  readonly collisionModes: readonly CollisionMode[];
  /** Whether `$n.<id>.$fired_by` is meaningful — only branching nodes have it. */
  readonly firedBy: boolean;
  /**
   * Whether the node holds an instance between arm and fire. `"by-shape"` means
   * the DSL fields decide rather than the type: a SQL node with no timer, no
   * persistence and no level tracking is stateless-instant.
   */
  readonly stateful: boolean | "by-shape";
}

export const NODE_TRAITS: Record<WatchNodeType, NodeTraits> = {
  "source.document_event": {
    source: true,
    cancellable: false,
    collisionModes: [],
    firedBy: false,
    stateful: false,
  },
  "source.analytics_row": {
    source: true,
    cancellable: false,
    collisionModes: [],
    firedBy: false,
    stateful: false,
  },
  "source.open_loop": {
    source: true,
    cancellable: false,
    collisionModes: [],
    firedBy: false,
    stateful: false,
  },
  "source.time": {
    source: true,
    cancellable: false,
    collisionModes: [],
    firedBy: false,
    stateful: false,
  },

  "stateless.or": {
    source: false,
    cancellable: false,
    collisionModes: [],
    firedBy: true,
    stateful: false,
  },
  "stateless.transform": {
    source: false,
    cancellable: false,
    collisionModes: [],
    firedBy: false,
    stateful: false,
  },

  "stateful.wait": {
    source: false,
    cancellable: true,
    collisionModes: ["reset", "ignore", "spawn"],
    firedBy: false,
    stateful: true,
  },
  "stateful.and": {
    source: false,
    cancellable: true,
    // `spawn` on a multi-arm node is a combinatorial explosion waiting to
    // happen: every arm would have to pick which live instance it belongs to.
    collisionModes: ["reset", "ignore"],
    firedBy: false,
    stateful: true,
  },
  "stateful.threshold": {
    source: false,
    cancellable: true,
    collisionModes: ["reset", "ignore"],
    firedBy: true,
    stateful: true,
  },
  "stateful.sequence": {
    source: false,
    cancellable: true,
    collisionModes: ["reset", "ignore"],
    firedBy: false,
    stateful: true,
  },
  "stateful.cooldown": {
    source: false,
    cancellable: true,
    // The cell must outlive firings — that is what a cooldown is — so no other
    // mode is meaningful.
    collisionModes: ["accumulate"],
    firedBy: false,
    stateful: true,
  },
  "stateful.persistence": {
    source: false,
    cancellable: true,
    collisionModes: ["accumulate"],
    firedBy: false,
    stateful: true,
  },
  sql: {
    source: false,
    cancellable: true,
    collisionModes: ["reset", "ignore", "spawn", "accumulate"],
    firedBy: false,
    stateful: "by-shape",
  },
  llm: {
    source: false,
    cancellable: true,
    collisionModes: ["reset", "ignore", "spawn", "accumulate"],
    firedBy: false,
    stateful: true,
  },
};

export function traitsOf(node: WatchNode): NodeTraits {
  return NODE_TRAITS[node.type];
}

/**
 * Whether a node holds an instance between arm and fire. For a SQL node the
 * answer is in its fields: a timer re-runs the query, persistence makes the
 * predicate hold over time, and rising-edge detection remembers the last level.
 */
export function isStateful(node: WatchNode): boolean {
  const declared = traitsOf(node).stateful;
  if (declared !== "by-shape") return declared;

  const sql = node as SqlNode;
  return sql.timer !== undefined || sql.persistence !== undefined || sql.fire_on === "rising_edge";
}

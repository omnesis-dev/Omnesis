// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The state one validation run shares between its collaborators.
 *
 * Checking a watch is a single pass in topological order, and each node's
 * checks depend on what the pass has already established about the nodes
 * upstream of it — their declared outputs, their key components, the set of
 * nodes they descend from. That accumulating knowledge is the context: the
 * graph walker fills it in, and the reference resolver, the output deriver and
 * the per-node checks read it.
 *
 * It is deliberately a plain record of maps rather than an object with
 * behaviour. Anything that reasons about the contents belongs in the
 * collaborator that owns that reasoning.
 */

import type { WatchDefinition, WatchNode } from "../dsl/schema.js";
import type { DocumentFrequency } from "../runtime/lexical.js";
import type { ValueType } from "../dsl/value-type.js";
import type { OntologyReads } from "../ontology/snapshot.js";
import type { DiagnosticCollector } from "./diagnostics.js";
import type { NodeOutput } from "./node-output.js";

export interface ValidationContext {
  readonly watch: WatchDefinition;
  readonly ontology: OntologyReads;
  /**
   * How often a literal term appears in the corpus, when anything can say.
   *
   * Optional because a validator run has no index of its own: a live install
   * answers from the search index and the PoC universe answers from its
   * journal. Absent, a lexical arm is still checked for shape but not for
   * distinctiveness, and the backtest's reach count is the only guardrail left.
   */
  readonly docFrequency?: DocumentFrequency;
  readonly diag: DiagnosticCollector;
  /** Every node by id, first declaration winning on a duplicate. */
  readonly nodes: ReadonlyMap<string, WatchNode>;
  /** Declared output per node, filled in as the pass reaches each one. */
  readonly outputs: Map<string, NodeOutput>;
  /** Transitive input closure per node. */
  readonly ancestors: Map<string, ReadonlySet<string>>;
  /** The key each node ended up with, typed from its edges. */
  readonly keyComponents: Map<string, ReadonlyMap<string, ValueType>>;
  /** Compile-time constants, typed from their declarations. */
  readonly constants: ReadonlyMap<string, ValueType>;
}

/** Everything a reference can resolve against at one site. */
export interface Scope {
  /** The node the expression is written on. */
  readonly node: WatchNode;
  /** JSON pointer for diagnostics raised here. */
  readonly path: string;
  /** `$e.` — present only inside a source node. */
  readonly event: Record<string, ValueType> | null;
  /** `.field` — present only inside a key extractor map. */
  readonly edge: NodeOutput | null;
  /** Bare identifiers — this node's own native output. */
  readonly native: NodeOutput | null;
  /** `$key.` — this node's own key components. */
  readonly ownKey: ReadonlyMap<string, ValueType>;
  /** Whether this site binds a value that must not be null. */
  readonly requiresNonNull: boolean;
  /**
   * Nodes whose output reaches this site through a branch that may not have
   * fired — the arms of an OR or an N-of-M, and everything upstream of them.
   * A reference into one is nullable however the branch itself declared it.
   */
  readonly nullableThroughBranch: ReadonlySet<string>;
}

export interface ResolvedExpression {
  readonly type: ValueType;
  readonly nullable: boolean;
}

/** The sources a document-event node listens to, however the filter spells it. */
export function sourceIdsOf(node: Extract<WatchNode, { type: "source.document_event" }>): string[] {
  const source = node.filter.source;
  return typeof source === "string" ? [source] : [...source];
}

/** The DSL type a source declares a metadata field to hold. */
export function metadataFieldType(declared: string): ValueType {
  switch (declared) {
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "string-array":
      return { kind: "list", of: { kind: "string" } };
    default:
      return { kind: "string" };
  }
}

/** The DSL type an analytics column's declared SQL type maps onto. */
export function analyticsColumnType(declared: string): ValueType {
  if (declared.startsWith("DECIMAL")) return { kind: "number" };
  switch (declared) {
    case "INTEGER":
    case "BIGINT":
    case "DOUBLE":
    case "FLOAT":
      return { kind: "number" };
    case "BOOLEAN":
      return { kind: "boolean" };
    case "DATE":
      return { kind: "date" };
    case "TIMESTAMP":
    case "TIMESTAMPTZ":
      return { kind: "timestamp" };
    case "VARCHAR[]":
      return { kind: "list", of: { kind: "string" } };
    default:
      return { kind: "string" };
  }
}

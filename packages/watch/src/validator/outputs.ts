// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a node carries forward, and whether it can be null when it gets there.
 *
 * A node's output is either what its `output_map` names or, absent one, what
 * the node natively projects: a source event's fields, a SQL query's result
 * columns, a judge's declared schema, or — for a node that neither queries nor
 * judges — its inputs' outputs passed straight through.
 *
 * Nullability is the subtle half. A branch of an OR that did not fire
 * contributes nothing, so every value that reached this node through one can be
 * null, whether it was read through the OR's own projection or by reaching
 * around it to the branch. Getting that wrong is how a key extractor ends up
 * keyed on null and an instance is armed that nothing can ever cancel.
 */

import { nodeInputs, type WatchNode } from "../dsl/schema.js";
import { UNKNOWN, parseValueType, typesCompatible, type ValueType } from "../dsl/value-type.js";
import { traitsOf } from "./node-traits.js";
import {
  eventFieldsFor,
  fieldMap,
  makeNodeOutput,
  sqlResultFields,
  type FieldInfo,
  type NodeOutput,
} from "./node-output.js";
import { analyzeSql } from "./sql.js";
import type { ReferenceResolver } from "./references.js";
import type { ValidationContext } from "./context.js";

export class OutputDeriver {
  constructor(
    private readonly ctx: ValidationContext,
    private readonly resolver: ReferenceResolver,
  ) {}

  deriveOutput(node: WatchNode, path: string): NodeOutput {
    const keyComponents = this.keyComponentsOf(node);
    const native = this.nativeOutput(node);
    const supportsFiredBy = traitsOf(node).firedBy;

    if (node.output_map === undefined) {
      return makeNodeOutput(new Map(native.fields), {
        fieldsIncomplete: native.fieldsIncomplete,
        supportsFiredBy,
        keyComponents,
      });
    }

    const fields = new Map<string, FieldInfo>();
    const nullableThroughBranch = this.nullableAncestors(node.id);
    for (const [name, expression] of Object.entries(node.output_map)) {
      const fieldPath = `${path}/output_map/${name}`;
      const resolved = this.resolver.resolveText(expression, fieldPath, {
        node,
        path: fieldPath,
        event: eventFieldsFor(node),
        edge: null,
        native,
        ownKey: keyComponents,
        requiresNonNull: false,
        nullableThroughBranch,
      });
      fields.set(name, { type: resolved?.type ?? UNKNOWN, nullable: resolved?.nullable ?? false });
    }

    return makeNodeOutput(fields, { supportsFiredBy, keyComponents });
  }

  /**
   * Nodes whose value can be null by the time it reaches `nodeId`, because it
   * travelled through a branch that may not have fired.
   *
   * It is not enough to mark the branches of an OR when reading the OR's own
   * projection: a downstream node can reference a branch node directly
   * (`$n.<branch>.<field>`), reaching around the OR, and the value is exactly
   * as absent either way.
   */
  nullableAncestors(nodeId: string): ReadonlySet<string> {
    const nullable = new Set<string>();
    for (const candidate of [nodeId, ...(this.ctx.ancestors.get(nodeId) ?? [])]) {
      const node = this.ctx.nodes.get(candidate);
      if (!node || !traitsOf(node).firedBy) continue;
      for (const id of this.branchClosure(node)) nullable.add(id);
    }
    return nullable;
  }

  /** Every node reachable through this node's arm branches, inclusive. */
  branchClosure(node: WatchNode): ReadonlySet<string> {
    const closure = new Set<string>();
    for (const [inputId, input] of Object.entries(nodeInputs(node))) {
      if (input.role !== "arm") continue;
      closure.add(inputId);
      for (const ancestor of this.ctx.ancestors.get(inputId) ?? []) closure.add(ancestor);
    }
    return closure;
  }

  /** What a node projects before any `output_map` renames it. */
  nativeOutput(node: WatchNode): NodeOutput {
    switch (node.type) {
      case "source.document_event":
      case "source.analytics_row":
      case "source.open_loop":
      case "source.time": {
        const fields = eventFieldsFor(node)!;
        return makeNodeOutput(fieldMap(fields));
      }
      case "sql":
      case "stateless.transform": {
        const analysis = analyzeSql(node.query);
        return makeNodeOutput(sqlResultFields(analysis.outputColumns), {
          fieldsIncomplete: analysis.unaliasedOutputCount > 0 || analysis.problem !== null,
        });
      }
      case "llm": {
        const fields = new Map<string, FieldInfo>();
        for (const [field, type] of Object.entries(node.output_schema)) {
          fields.set(field, { type: parseValueType(type) ?? UNKNOWN, nullable: false });
        }
        return makeNodeOutput(fields);
      }
      default:
        return this.passthroughOutput(node);
    }
  }

  /**
   * A node that neither queries nor judges carries its inputs' outputs forward.
   * OR and N-of-M contribute nullable fields — a branch that did not fire has
   * nothing to give — and a name projected by two branches with different types
   * degrades to `unknown` rather than silently picking one.
   */
  passthroughOutput(node: WatchNode): NodeOutput {
    const nullable = traitsOf(node).firedBy;
    const fields = new Map<string, FieldInfo>();

    for (const [inputId, input] of Object.entries(nodeInputs(node))) {
      if (input.role !== "arm") continue;
      const upstream = this.ctx.outputs.get(inputId);
      if (!upstream) continue;
      for (const [name, info] of upstream.fields) {
        const existing = fields.get(name);
        if (!existing) {
          fields.set(name, { type: info.type, nullable: nullable || info.nullable });
          continue;
        }
        fields.set(name, {
          type: typesCompatible(existing.type, info.type) ? existing.type : UNKNOWN,
          nullable: existing.nullable || info.nullable || nullable,
        });
      }
    }

    return makeNodeOutput(fields);
  }

  private keyComponentsOf(node: WatchNode): ReadonlyMap<string, ValueType> {
    return this.ctx.keyComponents.get(node.id) ?? new Map();
  }
}

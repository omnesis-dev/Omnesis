// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Resolving a reference to what it names.
 *
 * Every `$e.`, `$n.`, `$key.`, `$const.` and `$judge.` in a watch passes
 * through here, along with the two unadorned forms — `.field` for the arriving
 * edge and a bare name for the node's own output. Resolution answers three
 * questions at once: does the thing exist, what type does it carry, and can it
 * be null by the time it arrives. The third is what makes a key extracted from
 * an OR branch a compile error rather than an instance nobody can ever cancel.
 *
 * The resolver holds no state of its own. It reads the graph the validator has
 * built so far through `ValidationContext`, which is also how it knows that a
 * node referencing itself mid-derivation is reaching for something that does
 * not exist yet.
 */

import {
  DATE_TRUNC_UNITS,
  EXTRACTOR_FUNCTIONS,
  parseExpression,
  type Expression,
  type PathSegment,
} from "../dsl/expression.js";
import {
  STRING,
  TIMESTAMP,
  UNKNOWN,
  formatValueType,
  listOf,
  parseValueType,
  typesCompatible,
  type ValueType,
} from "../dsl/value-type.js";
import { lookup } from "../internal/lookup.js";
import { LOOP_SNAPSHOT_FIELDS, PERSON_MENTION_FIELDS } from "./node-output.js";
import {
  analyticsColumnType,
  metadataFieldType,
  sourceIdsOf,
  type ResolvedExpression,
  type Scope,
  type ValidationContext,
} from "./context.js";

/** The value-type kinds `date_trunc` can read an instant out of. */
const DATE_TRUNC_VALUE_TYPES = new Set(["date", "timestamp", "string", "number", "unknown"]);

export class ReferenceResolver {
  constructor(private readonly ctx: ValidationContext) {}

  resolveText(text: string, path: string, scope: Scope): ResolvedExpression | null {
    const parsed = parseExpression(text);
    if (!parsed.ok) {
      this.ctx.diag.error(
        "EXPRESSION_PARSE_ERROR",
        path,
        `${parsed.error.message} (at offset ${parsed.error.offset}).`,
        { expression: text, offset: parsed.error.offset },
      );
      return null;
    }
    return this.resolve(parsed.value, scope);
  }

  resolve(expression: Expression, scope: Scope): ResolvedExpression | null {
    switch (expression.kind) {
      case "literal":
        return { type: expression.type, nullable: expression.value === null };

      case "call":
        return this.resolveCall(expression, scope);

      case "const": {
        const type = this.ctx.constants.get(expression.name);
        if (!type) {
          this.ctx.diag.error(
            "REF_CONSTANT_UNKNOWN",
            scope.path,
            `No constant '${expression.name}' is declared on this watch.`,
            { name: expression.name, declared: [...this.ctx.constants.keys()] },
          );
          return null;
        }
        return { type, nullable: false };
      }

      case "key": {
        const type = scope.ownKey.get(expression.component);
        if (type === undefined) {
          this.ctx.diag.error(
            "REF_KEY_COMPONENT_UNKNOWN",
            scope.path,
            `'${expression.component}' is not a component of this node's key.`,
            { component: expression.component, declared: [...scope.ownKey.keys()] },
          );
          return null;
        }
        return { type, nullable: false };
      }

      case "judge":
        return this.resolveJudgeRef(expression.field, scope);

      case "edge":
        return this.resolveEdgeRef(expression.path, scope);

      case "native":
        return this.resolveNativeRef(expression.path, scope);

      case "event":
        return this.resolveEventRef(expression.path, scope);

      case "node":
        return this.resolveNodeRef(expression, scope);
    }
  }

  private resolveCall(
    expression: Extract<Expression, { kind: "call" }>,
    scope: Scope,
  ): ResolvedExpression | null {
    const signature = lookup(EXTRACTOR_FUNCTIONS, expression.fn);
    if (!signature) {
      this.ctx.diag.error(
        "EXPRESSION_FUNCTION_UNKNOWN",
        scope.path,
        `'${expression.fn}' is not an extractor function.`,
        { function: expression.fn, available: Object.keys(EXTRACTOR_FUNCTIONS) },
      );
      return null;
    }
    if (
      expression.args.length < signature.minArity ||
      expression.args.length > signature.maxArity
    ) {
      this.ctx.diag.error(
        "EXPRESSION_FUNCTION_ARITY",
        scope.path,
        `'${expression.fn}' takes ${signature.minArity}..${signature.maxArity} arguments, got ${expression.args.length}.`,
        { function: expression.fn, got: expression.args.length },
      );
      return null;
    }

    // Arguments of a null-merging call are allowed to be null — merging them is
    // the point. Everything else inherits the site's null-safety requirement.
    const argumentScope: Scope =
      expression.fn === "coalesce" ? { ...scope, requiresNonNull: false } : scope;
    const resolved = expression.args.map((arg) => this.resolve(arg, argumentScope));

    if (expression.fn === "date_trunc") {
      this.checkDateTruncArguments(expression, resolved, scope);
      return { type: TIMESTAMP, nullable: resolved[1]?.nullable ?? false };
    }
    // `coalesce` IS the null-safety escape the validator asks for, so its
    // result is null-safe by construction. Merging the branches of an OR is
    // exactly what it is for: at least one of them fired.
    //
    // Its type is a branch's only when the branches agree on one. A merge of a
    // timestamp and a document id could hand back either, so claiming the first
    // one's type would let the argument order decide whether a downstream
    // mistake is caught — `unknown` is what is actually known.
    const known = resolved.filter((r): r is ResolvedExpression => r !== null);
    const first = known[0];
    const agree = known.every((r) => typesCompatible(r.type, first?.type ?? UNKNOWN));
    return { type: agree ? (first?.type ?? UNKNOWN) : UNKNOWN, nullable: false };
  }

  /**
   * Check what `date_trunc` was actually handed.
   *
   * Its result type is `TIMESTAMP` whatever it is given, so nothing downstream
   * ever notices a nonsense call: the runtime returns null for an unknown unit
   * and null for a value it cannot read as an instant, and the watch runs
   * forever reporting nothing. That silence is the reason this is checked here
   * rather than left to the operator to notice.
   */
  private checkDateTruncArguments(
    expression: Extract<Expression, { kind: "call" }>,
    resolved: readonly (ResolvedExpression | null)[],
    scope: Scope,
  ): void {
    const unit = expression.args[0];
    const unitLiteral =
      unit?.kind === "literal" && typeof unit.value === "string" ? unit.value : null;
    // Compared case-insensitively because the runtime lowercases before it
    // matches. A stricter rule here would refuse a watch that has been firing
    // correctly for months — and refusing one is not academic: every stored
    // definition is re-validated as it runs, and one that fails is paused.
    const named =
      unitLiteral !== null &&
      (DATE_TRUNC_UNITS as readonly string[]).includes(unitLiteral.toLowerCase());
    if (!named) {
      this.ctx.diag.error(
        "EXPRESSION_DATE_TRUNC_UNIT",
        scope.path,
        `date_trunc's first argument is the unit, written as one of ${DATE_TRUNC_UNITS.join(", ")}.`,
        // The argument as the author wrote it. An expression's internal kind
        // would name a category nobody typed.
        { got: unitLiteral ?? "not a quoted unit", units: [...DATE_TRUNC_UNITS] },
      );
    }

    const value = resolved[1];
    // `unknown` is a SQL result column, whose type nobody can know without
    // running the query — the validator's job is to be honest about what it can
    // prove. `string` and `number` are in because an instant genuinely arrives
    // as both: a metadata field is typed `string` whatever it holds, and an
    // epoch is a number. `id` is out even though ids and strings are one family
    // for *comparison*: a document or person id has no instant in it, and the
    // family rule exists so a key can be matched, not so an id can be a date.
    if (value && !DATE_TRUNC_VALUE_TYPES.has(value.type.kind)) {
      this.ctx.diag.error(
        "EXPRESSION_DATE_TRUNC_VALUE",
        scope.path,
        `date_trunc's second argument is the instant to truncate; this one is ${formatValueType(value.type)}.`,
        { type: formatValueType(value.type) },
      );
    }
  }

  private resolveJudgeRef(field: string, scope: Scope): ResolvedExpression | null {
    const node = scope.node;
    if (node.type !== "source.document_event" || node.judge === undefined) {
      this.ctx.diag.error(
        "REF_JUDGE_WITHOUT_SEMANTIC_MATCH",
        scope.path,
        `'$judge.*' reads the nomination judge's decision; this node has no judge block.`,
        { nodeId: node.id },
      );
      return null;
    }
    const declared = lookup(node.judge.output_schema, field);
    if (declared === undefined) {
      this.ctx.diag.error(
        "REF_JUDGE_FIELD_UNKNOWN",
        scope.path,
        `The judge does not declare an output field '${field}'.`,
        { field, declared: Object.keys(node.judge.output_schema) },
      );
      return null;
    }
    return { type: parseValueType(declared) ?? UNKNOWN, nullable: false };
  }

  private resolveEdgeRef(path: readonly string[], scope: Scope): ResolvedExpression | null {
    if (!scope.edge) {
      this.ctx.diag.error(
        "REF_EDGE_NOT_IN_SCOPE",
        scope.path,
        `A leading '.' names a field of the arriving edge's payload, which only exists inside a key extractor.`,
        { path: path.join(".") },
      );
      return null;
    }
    if (path.length !== 1) {
      this.ctx.diag.error(
        "REF_FIELD_UNKNOWN",
        scope.path,
        `A key extractor reads one field of the arriving payload; '.${path.join(".")}' walks deeper than the edge exposes.`,
        { path: path.join(".") },
      );
      return null;
    }
    const info = scope.edge.fields.get(path[0]!);
    if (!info) {
      if (scope.edge.fieldsIncomplete) return { type: UNKNOWN, nullable: false };
      this.ctx.diag.error(
        "REF_FIELD_UNKNOWN",
        scope.path,
        `The upstream node does not project '${path[0]}'.`,
        { field: path[0], available: [...scope.edge.fields.keys()] },
      );
      return null;
    }
    this.checkNullSafety(info.nullable, scope, path.join("."));
    return { type: info.type, nullable: info.nullable };
  }

  private resolveNativeRef(path: readonly string[], scope: Scope): ResolvedExpression | null {
    if (!scope.native) {
      this.ctx.diag.error(
        "REF_FIELD_UNKNOWN",
        scope.path,
        `'${path.join(".")}' is a bare field reference, and there is no native output in scope here. Quote it ('${path.join(".")}') if you meant a literal.`,
        { path: path.join(".") },
      );
      return null;
    }
    const info = scope.native.fields.get(path[0]!);
    if (!info) {
      if (scope.native.fieldsIncomplete) return { type: UNKNOWN, nullable: false };
      this.ctx.diag.error(
        "REF_FIELD_UNKNOWN",
        scope.path,
        `This node does not project '${path[0]}'.`,
        {
          field: path[0],
          available: [...scope.native.fields.keys()],
        },
      );
      return null;
    }
    return { type: info.type, nullable: info.nullable };
  }

  private resolveNodeRef(
    expression: Extract<Expression, { kind: "node" }>,
    scope: Scope,
  ): ResolvedExpression | null {
    const target = this.ctx.nodes.get(expression.node);
    if (!target) {
      this.ctx.diag.error(
        "REF_NODE_UNKNOWN",
        scope.path,
        `No node '${expression.node}' in this watch.`,
        { nodeId: expression.node, known: [...this.ctx.nodes.keys()] },
      );
      return null;
    }

    const ancestors = this.ctx.ancestors.get(scope.node.id) ?? new Set<string>();
    const reachable = expression.node === scope.node.id || ancestors.has(expression.node);
    if (!reachable) {
      this.ctx.diag.error(
        "REF_NODE_NOT_UPSTREAM",
        scope.path,
        `'${expression.node}' is not upstream of '${scope.node.id}' — signal flows downstream only, so its output is not available here.`,
        { referenced: expression.node, from: scope.node.id, upstream: [...ancestors] },
      );
      return null;
    }

    const output = this.ctx.outputs.get(expression.node);
    if (!output) {
      // The only way an upstream node has no output yet is that it *is* this
      // node, mid-derivation — a node cannot read what it is still computing.
      this.ctx.diag.error(
        "REF_NODE_NOT_UPSTREAM",
        scope.path,
        `'${expression.node}' cannot read its own output while computing it. A node's own fields are named without the '$n.' prefix.`,
        { referenced: expression.node, from: scope.node.id },
      );
      return null;
    }

    switch (expression.component.kind) {
      case "fired_by": {
        if (!output.supportsFiredBy) {
          this.ctx.diag.error(
            "REF_FIRED_BY_UNSUPPORTED",
            scope.path,
            `'$fired_by' says which branch fired; only OR and N-of-M nodes have branches.`,
            { nodeId: expression.node, nodeType: target.type },
          );
          return null;
        }
        return {
          type: target.type === "stateless.or" ? STRING : listOf(STRING),
          nullable: false,
        };
      }
      case "key": {
        const type = output.keyComponents.get(expression.component.component);
        if (type === undefined) {
          this.ctx.diag.error(
            "REF_KEY_COMPONENT_UNKNOWN",
            scope.path,
            `'${expression.node}' has no key component '${expression.component.component}'.`,
            {
              nodeId: expression.node,
              component: expression.component.component,
              declared: [...output.keyComponents.keys()],
            },
          );
          return null;
        }
        return { type, nullable: false };
      }
      case "field": {
        const info = output.fields.get(expression.component.name);
        if (!info) {
          if (output.fieldsIncomplete) return { type: UNKNOWN, nullable: false };
          this.ctx.diag.error(
            "REF_FIELD_UNKNOWN",
            scope.path,
            `'${expression.node}' does not project '${expression.component.name}'.`,
            {
              nodeId: expression.node,
              field: expression.component.name,
              available: [...output.fields.keys()],
            },
          );
          return null;
        }
        const nullable = info.nullable || scope.nullableThroughBranch.has(expression.node);
        this.checkNullSafety(nullable, scope, `$n.${expression.node}.${expression.component.name}`);
        return { type: info.type, nullable };
      }
    }
  }

  private checkNullSafety(nullable: boolean, scope: Scope, what: string): void {
    if (!nullable || !scope.requiresNonNull) return;
    this.ctx.diag.error(
      "REF_NULLABLE_UNSAFE",
      scope.path,
      `'${what}' can be null (it reaches through a branch that may not have fired) and this site cannot take a null. Wrap it in coalesce().`,
      { reference: what },
    );
  }

  private resolveEventRef(path: readonly PathSegment[], scope: Scope): ResolvedExpression | null {
    if (!scope.event) {
      this.ctx.diag.error(
        "REF_EVENT_NOT_IN_SCOPE",
        scope.path,
        `'$e.*' reads the journal event that armed a source node; this node has no event of its own. Reference the source through '$n.<source>.<field>'.`,
        { nodeId: scope.node.id },
      );
      return null;
    }

    const head = path[0]!;
    if (head.kind !== "field") {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `'$e' must be followed by a field name.`,
      );
      return null;
    }

    const rootType = lookup(scope.event, head.name);
    if (rootType === undefined) {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `'${head.name}' is not a field of this event kind.`,
        { field: head.name, available: Object.keys(scope.event) },
      );
      return null;
    }

    if (path.length === 1) return { type: rootType, nullable: false };

    switch (head.name) {
      case "metadata":
        return this.resolveMetadataPath(path.slice(1), scope);
      case "people":
        return this.resolvePeoplePath(path.slice(1), scope);
      case "row":
      case "pk":
        return this.resolveAnalyticsRowPath(head.name, path.slice(1), scope);
      case "before":
      case "after":
        return this.resolveLoopSnapshotPath(head.name, path.slice(1), scope);
      default:
        this.ctx.diag.error(
          "REF_EVENT_FIELD_UNKNOWN",
          scope.path,
          `'$e.${head.name}' is a scalar; it has no sub-fields.`,
          { field: head.name },
        );
        return null;
    }
  }

  private resolveMetadataPath(
    rest: readonly PathSegment[],
    scope: Scope,
  ): ResolvedExpression | null {
    if (scope.node.type !== "source.document_event") return null;
    if (rest.some((segment) => segment.kind !== "field")) {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `Metadata is addressed by dotted path only.`,
      );
      return null;
    }

    const path = rest.map((segment) => (segment as { name: string }).name).join(".");
    let resolved: ValueType | null = null;

    for (const sourceId of sourceIdsOf(scope.node)) {
      const field = this.ctx.ontology.metadataField(sourceId, path);
      if (!field) {
        this.ctx.diag.error(
          "METADATA_FIELD_UNDECLARED",
          scope.path,
          `'${sourceId}' does not declare 'metadata.${path}'. A field the source does not declare is a field a compiled watch cannot rely on.`,
          {
            sourceId,
            path,
            declared: (this.ctx.ontology.source(sourceId)?.profile.metadataFields ?? []).map(
              (f) => f.path,
            ),
          },
        );
        continue;
      }
      resolved = metadataFieldType(field.type);
    }

    return resolved === null ? null : { type: resolved, nullable: false };
  }

  private resolvePeoplePath(rest: readonly PathSegment[], scope: Scope): ResolvedExpression | null {
    const [filter, leaf, ...extra] = rest;
    if (filter?.kind !== "filter" || leaf?.kind !== "field" || extra.length > 0) {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `Address a person mention as '$e.people[role=<role>].<field>' — an unfiltered people list has no single value to extract.`,
        { available: Object.keys(PERSON_MENTION_FIELDS) },
      );
      return null;
    }

    if (filter.field !== "role") {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `People mentions are selected by role; '${filter.field}' is not a selector.`,
        { selector: filter.field },
      );
      return null;
    }

    if (scope.node.type === "source.document_event") {
      for (const sourceId of sourceIdsOf(scope.node)) {
        const roles = this.ctx.ontology.source(sourceId)?.profile.personRoles ?? [];
        if (roles.length === 0 || (roles as readonly string[]).includes(filter.value)) continue;
        this.ctx.diag.error(
          "PERSON_ROLE_UNDECLARED",
          scope.path,
          `'${sourceId}' never writes a '${filter.value}' mention, so this extraction is always empty.`,
          { sourceId, role: filter.value, declared: roles },
        );
      }
    }

    const type = lookup(PERSON_MENTION_FIELDS, leaf.name);
    if (type === undefined) {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `'${leaf.name}' is not a field of a person mention.`,
        { field: leaf.name, available: Object.keys(PERSON_MENTION_FIELDS) },
      );
      return null;
    }
    // A role the document happens not to carry yields no mention — unless the
    // node's own filter already demands one, in which case every event that
    // arms this node carries it.
    const required =
      scope.node.type === "source.document_event" &&
      (scope.node.filter.people ?? []).some((p) => p.role === filter.value);
    return { type, nullable: !required };
  }

  private resolveAnalyticsRowPath(
    root: "row" | "pk",
    rest: readonly PathSegment[],
    scope: Scope,
  ): ResolvedExpression | null {
    if (scope.node.type !== "source.analytics_row") return null;
    const [leaf, ...extra] = rest;
    if (leaf?.kind !== "field" || extra.length > 0) {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `'$e.${root}' is addressed by column name.`,
      );
      return null;
    }

    const table = this.ctx.ontology.table(scope.node.table);
    if (!table) return { type: UNKNOWN, nullable: false };

    const column = table.columns.find((c) => c.name === leaf.name);
    if (!column) {
      this.ctx.diag.error(
        "ANALYTICS_COLUMN_UNKNOWN",
        scope.path,
        `'${scope.node.table}' has no column '${leaf.name}'.`,
        { table: scope.node.table, column: leaf.name, declared: table.columns.map((c) => c.name) },
      );
      return null;
    }
    if (root === "pk" && !table.primaryKey.includes(leaf.name)) {
      this.ctx.diag.error(
        "ANALYTICS_COLUMN_UNKNOWN",
        scope.path,
        `'${leaf.name}' is not part of the primary key of '${scope.node.table}'.`,
        { table: scope.node.table, column: leaf.name, primaryKey: table.primaryKey },
      );
      return null;
    }
    return { type: analyticsColumnType(column.type), nullable: false };
  }

  private resolveLoopSnapshotPath(
    root: "before" | "after",
    rest: readonly PathSegment[],
    scope: Scope,
  ): ResolvedExpression | null {
    const [leaf, ...extra] = rest;
    if (leaf?.kind !== "field" || extra.length > 0) {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `A loop snapshot is addressed by field name.`,
      );
      return null;
    }
    const type = lookup(LOOP_SNAPSHOT_FIELDS, leaf.name);
    if (type === undefined) {
      this.ctx.diag.error(
        "REF_EVENT_FIELD_UNKNOWN",
        scope.path,
        `'${leaf.name}' is not a field of a loop snapshot.`,
        { field: leaf.name, available: Object.keys(LOOP_SNAPSHOT_FIELDS) },
      );
      return null;
    }

    // There is no `before` on a creation. A node that filters creations out has
    // a `before` on every event that can arm it.
    const nullable =
      root === "before" &&
      scope.node.type === "source.open_loop" &&
      scope.node.op.includes("created");
    return { type, nullable };
  }
}

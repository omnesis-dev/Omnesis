// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Computing what the validator only checks.
 *
 * The same expression grammar serves three purposes at run time: extracting an
 * instance key from an arriving payload, building the structured output a node
 * carries forward, and deciding a `fire_when` predicate over a judge's verdict.
 * All three resolve against a scope the caller assembles — the event, the
 * upstream outputs, the node's own key, the watch's constants.
 *
 * An unresolvable reference evaluates to `null` rather than throwing. The
 * validator's job is to make that impossible before a watch ever runs; if one
 * survives to here, a null propagating into a key or a payload is far easier to
 * see in a trace than an exception unwinding the whole event.
 */

import {
  parseExpression,
  parsePredicate,
  type Expression,
  type PathSegment,
  type Predicate,
} from "../dsl/expression.js";

/** Everything an expression can reach at one evaluation site. */
export interface EvaluationScope {
  /** `$e.…` — the journal event that armed a source node. */
  readonly event?: Readonly<Record<string, unknown>>;
  /** `$judge.…` — an embedded semantic-match judge's output. */
  readonly judge?: Readonly<Record<string, unknown>>;
  /** `$n.<node>.…` — upstream nodes' outputs, by node id. */
  readonly upstream?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** `$n.<node>.$key.…` — upstream nodes' keys. */
  readonly upstreamKeys?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** `$n.<node>.$fired_by` — which branch fired. */
  readonly firedBy?: Readonly<Record<string, unknown>>;
  /** `$key.…` — this node's own key. */
  readonly key?: Readonly<Record<string, unknown>>;
  /** `$const.…` — compile-time constants. */
  readonly constants?: Readonly<Record<string, unknown>>;
  /** `.field` — the arriving edge's payload, inside a key extractor. */
  readonly edge?: Readonly<Record<string, unknown>>;
  /** A bare name — this node's own native output. */
  readonly native?: Readonly<Record<string, unknown>>;
}

function evaluateExpression(text: string, scope: EvaluationScope): unknown {
  const parsed = parseExpression(text);
  return parsed.ok ? evaluate(parsed.value, scope) : null;
}

/** Evaluate every entry of an `output_map` (or a key extractor map). */
export function evaluateMap(
  map: Readonly<Record<string, string>> | undefined,
  scope: EvaluationScope,
  fallback: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  if (map === undefined) return { ...fallback };
  const out: Record<string, unknown> = {};
  for (const [name, expression] of Object.entries(map)) {
    out[name] = evaluateExpression(expression, scope);
  }
  return out;
}

function evaluate(expression: Expression, scope: EvaluationScope): unknown {
  switch (expression.kind) {
    case "literal":
      return expression.value;

    case "const":
      return scope.constants?.[expression.name] ?? null;

    case "key":
      return scope.key?.[expression.component] ?? null;

    case "judge":
      return scope.judge?.[expression.field] ?? null;

    case "edge":
      return readPath(scope.edge, expression.path);

    case "native":
      return readPath(scope.native, expression.path);

    case "event":
      return readEventPath(scope.event, expression.path);

    case "node": {
      const { node, component } = expression;
      if (component.kind === "fired_by") return scope.firedBy?.[node] ?? null;
      if (component.kind === "key")
        return scope.upstreamKeys?.[node]?.[component.component] ?? null;
      return scope.upstream?.[node]?.[component.name] ?? null;
    }

    case "call":
      return evaluateCall(expression, scope);
  }
}

function evaluateCall(
  expression: Extract<Expression, { kind: "call" }>,
  scope: EvaluationScope,
): unknown {
  const args = expression.args.map((arg) => evaluate(arg, scope));

  switch (expression.fn) {
    case "coalesce":
      return args.find((value) => value !== null && value !== undefined) ?? null;

    case "date_trunc": {
      const unit = String(args[0] ?? "");
      const value = args[1];
      return typeof value === "string" || typeof value === "number" ? truncate(value, unit) : null;
    }

    default:
      return null;
  }
}

/**
 * Truncate an instant to a unit boundary, in UTC.
 *
 * The result is the boundary *instant*, not a shortened rendering of it: a
 * month truncates to `2026-03-01`, not `2026-03`. That matters because a
 * truncated key is routinely compared against SQL's own `date_trunc`, and
 * `2026-03` is not something a date column can be compared to. Matching SQL's
 * semantics here keeps a key computed in the engine and a key computed in a
 * query the same value.
 */
function truncate(value: string | number, unit: string): string | null {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);

  switch (unit.toLowerCase()) {
    case "year":
      return `${at.toISOString().slice(0, 4)}-01-01`;
    case "month":
      return `${at.toISOString().slice(0, 7)}-01`;
    case "day":
      return at.toISOString().slice(0, 10);
    case "hour":
      return `${at.toISOString().slice(0, 13)}:00:00.000Z`;
    case "minute":
      return `${at.toISOString().slice(0, 16)}:00.000Z`;
    default:
      return null;
  }
}

function readPath(
  source: Readonly<Record<string, unknown>> | undefined,
  path: readonly string[],
): unknown {
  let cursor: unknown = source;
  for (const step of path) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return null;
    if (!Object.hasOwn(cursor as object, step)) return null;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return cursor ?? null;
}

/**
 * Walk an event payload, including the one filtered form the grammar allows:
 * `$e.people[role=sender].personId` picks the mention with that role.
 */
function readEventPath(
  event: Readonly<Record<string, unknown>> | undefined,
  path: readonly PathSegment[],
): unknown {
  let cursor: unknown = event;

  for (const segment of path) {
    if (cursor === null || cursor === undefined) return null;

    if (segment.kind === "field") {
      if (typeof cursor !== "object" || !Object.hasOwn(cursor as object, segment.name)) return null;
      cursor = (cursor as Record<string, unknown>)[segment.name];
      continue;
    }

    if (!Array.isArray(cursor)) return null;
    cursor =
      cursor.find(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          (item as Record<string, unknown>)[segment.field] === segment.value,
      ) ?? null;
  }

  return cursor ?? null;
}

/** Decide a `fire_when` predicate over a node's own typed output. */
export function evaluatePredicate(
  text: string,
  output: Readonly<Record<string, unknown>>,
): boolean {
  const parsed = parsePredicate(text);
  return parsed.ok ? decide(parsed.value, output) : false;
}

function decide(predicate: Predicate, output: Readonly<Record<string, unknown>>): boolean {
  switch (predicate.kind) {
    case "and":
      return predicate.operands.every((operand) => decide(operand, output));
    case "or":
      return predicate.operands.some((operand) => decide(operand, output));
    case "not":
      return !decide(predicate.operand, output);
    case "truthy":
      return Boolean(operand(predicate.operand, output));
    case "comparison": {
      const left = operand(predicate.left, output);
      const right = operand(predicate.right, output);
      switch (predicate.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case ">":
          return compare(left, right) > 0;
        case ">=":
          return compare(left, right) >= 0;
        case "<":
          return compare(left, right) < 0;
        case "<=":
          return compare(left, right) <= 0;
      }
    }
  }
}

function operand(expression: Expression, output: Readonly<Record<string, unknown>>): unknown {
  return evaluate(expression, { native: output });
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The value types that flow along a watch DAG's edges.
 *
 * Every node declares what it carries forward — a judge's `output_schema`, a
 * source event's fields, a SQL node's result columns — and the validator uses
 * these types to check that a key extractor on an arm edge and the one on the
 * matching cancel edge agree, that a `fire_when` comparison names a real enum
 * member, and that a reference is used where its type makes sense.
 *
 * The spelling is the one the DSL examples use: `"string"`, `"bool"`,
 * `"date"`, `"list<id>"`, `"enum[clear, probable, ambiguous]"`.
 *
 * `unknown` is a first-class member, not a failure. A SQL node's result column
 * types are not knowable without executing the query against the analytics
 * engine, so they arrive as `unknown` and are compatible with everything. The
 * validator's job is to be *honest* about what it can prove, not to invent
 * types it does not have.
 */

import { lookup } from "../internal/lookup.js";

export type ValueType =
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "date" }
  | { readonly kind: "timestamp" }
  | { readonly kind: "id" }
  | { readonly kind: "object" }
  | { readonly kind: "unknown" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "list"; readonly of: ValueType };

export const STRING: ValueType = { kind: "string" };
export const NUMBER: ValueType = { kind: "number" };
export const BOOLEAN: ValueType = { kind: "boolean" };
export const DATE: ValueType = { kind: "date" };
export const TIMESTAMP: ValueType = { kind: "timestamp" };
export const ID: ValueType = { kind: "id" };
export const OBJECT: ValueType = { kind: "object" };
export const UNKNOWN: ValueType = { kind: "unknown" };

export function listOf(of: ValueType): ValueType {
  return { kind: "list", of };
}

export function enumOf(values: readonly string[]): ValueType {
  return { kind: "enum", values };
}

const SCALAR_SPELLINGS: Record<string, ValueType> = {
  string: STRING,
  number: NUMBER,
  int: NUMBER,
  float: NUMBER,
  bool: BOOLEAN,
  boolean: BOOLEAN,
  date: DATE,
  timestamp: TIMESTAMP,
  id: ID,
  object: OBJECT,
  unknown: UNKNOWN,
};

/**
 * How deeply `list<…>` may nest. A type expression is written by a model, so a
 * pathological nesting depth is a real input, and unbounded recursion here
 * would surface as a stack overflow escaping the validator instead of as a
 * diagnostic. No meaningful type comes close.
 */
const MAX_TYPE_DEPTH = 16;

/**
 * Parse a DSL type expression. Returns `null` for anything unrecognised so the
 * caller can raise a diagnostic pointing at the exact JSON path.
 */
export function parseValueType(text: string, depth = 0): ValueType | null {
  if (depth > MAX_TYPE_DEPTH) return null;
  const trimmed = text.trim();

  const scalar = lookup(SCALAR_SPELLINGS, trimmed.toLowerCase());
  if (scalar) return scalar;

  const list = /^list<(.+)>$/i.exec(trimmed);
  if (list) {
    const inner = parseValueType(list[1]!, depth + 1);
    return inner ? listOf(inner) : null;
  }

  const enumMatch = /^enum\[(.*)]$/i.exec(trimmed);
  if (enumMatch) {
    const values = enumMatch[1]!
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (values.length === 0) return null;
    if (new Set(values).size !== values.length) return null;
    return enumOf(values);
  }

  return null;
}

/** Canonical spelling — what a diagnostic message should print. */
export function formatValueType(type: ValueType): string {
  switch (type.kind) {
    case "enum":
      return `enum[${type.values.join(", ")}]`;
    case "list":
      return `list<${formatValueType(type.of)}>`;
    default:
      return type.kind;
  }
}

/**
 * Whether two types can hold the same value. Deliberately permissive in three
 * places, each because the substrate genuinely blurs them:
 *
 * - `unknown` matches everything (a SQL result column, an undeclared field).
 * - `id` and `string` match (a person id is stored as a bare UUID string).
 * - `date` and `timestamp` match (`$semanticTime` is compared against dates all
 *   over the examples).
 *
 * Enums compare by their value sets, not their identity, so a key extracted
 * from one enum-typed field can be matched against another with the same
 * members.
 */
export function typesCompatible(a: ValueType, b: ValueType): boolean {
  if (a.kind === "unknown" || b.kind === "unknown") return true;

  if (a.kind === "list" && b.kind === "list") return typesCompatible(a.of, b.of);
  if (a.kind === "list" || b.kind === "list") return false;

  if (a.kind === "enum" && b.kind === "enum") {
    return setsEqual(a.values, b.values);
  }
  // An enum is a constrained string; comparing it to a string is legitimate.
  if (a.kind === "enum") return b.kind === "string";
  if (b.kind === "enum") return a.kind === "string";

  if (a.kind === b.kind) return true;

  return inSameFamily(a.kind, b.kind);
}

const FAMILIES: readonly (readonly string[])[] = [
  ["id", "string"],
  ["date", "timestamp"],
];

function inSameFamily(a: string, b: string): boolean {
  return FAMILIES.some((family) => family.includes(a) && family.includes(b));
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

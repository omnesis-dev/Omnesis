// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { parseExpression, parsePredicate } from "./expression.js";

function parse(text: string) {
  const result = parseExpression(text);
  if (!result.ok) throw new Error(`${text}: ${result.error.message}`);
  return result.value;
}

describe("parseExpression", () => {
  it("reads the five reference namespaces", () => {
    expect(parse("$e.docId")).toEqual({ kind: "event", path: [{ kind: "field", name: "docId" }] });
    expect(parse("$n.inbound.doc_id")).toEqual({
      kind: "node",
      node: "inbound",
      component: { kind: "field", name: "doc_id" },
    });
    expect(parse("$key.month")).toEqual({ kind: "key", component: "month" });
    expect(parse("$const.passport_expiry")).toEqual({ kind: "const", name: "passport_expiry" });
    expect(parse("$judge.stance")).toEqual({ kind: "judge", field: "stance" });
  });

  it("reads a node's key components and fired-by marker", () => {
    expect(parse("$n.month_over_500.$key.month")).toEqual({
      kind: "node",
      node: "month_over_500",
      component: { kind: "key", component: "month" },
    });
    expect(parse("$n.any_decline.$fired_by")).toEqual({
      kind: "node",
      node: "any_decline",
      component: { kind: "fired_by" },
    });
  });

  it("selects a person mention by role", () => {
    expect(parse("$e.people[role=sender].personId")).toEqual({
      kind: "event",
      path: [
        { kind: "field", name: "people" },
        { kind: "filter", field: "role", value: "sender" },
        { kind: "field", name: "personId" },
      ],
    });
  });

  it("distinguishes an edge field, a native field, and a literal", () => {
    expect(parse(".thread_id")).toEqual({ kind: "edge", path: ["thread_id"] });
    expect(parse("avg_hr")).toEqual({ kind: "native", path: ["avg_hr"] });
    expect(parse("'avg_hr'")).toEqual({
      kind: "literal",
      value: "avg_hr",
      type: { kind: "string" },
    });
  });

  it("reads calls, including nested ones", () => {
    expect(parse("date_trunc('month', $e.row.date)")).toMatchObject({
      kind: "call",
      fn: "date_trunc",
    });
    expect(parse("coalesce($n.a.doc, coalesce($n.b.doc, $n.c.doc))")).toMatchObject({
      kind: "call",
      fn: "coalesce",
      args: [{ kind: "node" }, { kind: "call", fn: "coalesce" }],
    });
  });

  it("reads a signed number", () => {
    expect(parse("-45")).toEqual({ kind: "literal", value: -45, type: { kind: "number" } });
    expect(parse("-1.5")).toEqual({ kind: "literal", value: -1.5, type: { kind: "number" } });
  });

  it("does not swallow a hyphen into an identifier", () => {
    // `count-1` is not a field named `count-1`; the grammar has no arithmetic,
    // so this is a syntax error rather than a silently-wrong reference.
    expect(parseExpression("count-1").ok).toBe(false);
  });

  it.each([
    ["$e", "a namespace with no path"],
    ["$nope.x", "an unknown namespace"],
    ["date_trunc('month'", "an unclosed call"],
    ["'unterminated", "an unterminated literal"],
    ["$n.node", "a node reference with no component"],
    ["$e.docId extra", "trailing input"],
    ["$e[role=sender]", "a filter with no field to filter"],
  ])("rejects %s (%s)", (text) => {
    expect(parseExpression(text).ok).toBe(false);
  });

  it("reports the offset of a syntax error", () => {
    const result = parseExpression("coalesce($n.a.b, )");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.offset).toBe(17);
  });
});

describe("parsePredicate", () => {
  it("parses the fire_when forms the examples use", () => {
    expect(parsePredicate("decision == true AND confidence == 'clear'").ok).toBe(true);
    expect(parsePredicate("decision AND confidence != 'ambiguous'").ok).toBe(true);
    expect(parsePredicate("decision").ok).toBe(true);
  });

  it("binds AND tighter than OR", () => {
    const result = parsePredicate("a AND b OR c");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        kind: "or",
        operands: [{ kind: "and" }, { kind: "truthy" }],
      });
    }
  });

  it("respects parentheses and NOT", () => {
    const result = parsePredicate("NOT (a OR b)");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ kind: "not", operand: { kind: "or" } });
  });

  it("compares against a signed number", () => {
    expect(parsePredicate("delta < -45").ok).toBe(true);
  });

  it.each(["decision AND", "== 'clear'", "(decision"])("rejects '%s'", (text) => {
    expect(parsePredicate(text).ok).toBe(false);
  });

  it("reports deep nesting as a diagnostic rather than overflowing the stack", () => {
    // These documents are model-written, so a pathological nesting depth is a
    // real input. It must come back as a parse failure, never as a RangeError.
    expect(parsePredicate(`${"NOT ".repeat(20000)}decision`).ok).toBe(false);
    expect(parsePredicate(`${"(".repeat(20000)}decision${")".repeat(20000)}`).ok).toBe(false);
  });
});

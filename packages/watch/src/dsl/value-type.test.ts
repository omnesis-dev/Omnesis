// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  BOOLEAN,
  DATE,
  ID,
  NUMBER,
  STRING,
  TIMESTAMP,
  UNKNOWN,
  enumOf,
  formatValueType,
  listOf,
  parseValueType,
  typesCompatible,
} from "./value-type.js";

describe("parseValueType", () => {
  it.each([
    ["string", STRING],
    ["bool", BOOLEAN],
    ["boolean", BOOLEAN],
    ["date", DATE],
    ["id", ID],
    ["list<id>", listOf(ID)],
    ["list<list<string>>", listOf(listOf(STRING))],
    ["enum[clear, probable, ambiguous]", enumOf(["clear", "probable", "ambiguous"])],
  ])("parses %s", (text, expected) => {
    expect(parseValueType(text)).toEqual(expected);
  });

  it.each(["text", "enum[]", "enum[a, a]", "list<>", "list<nope>", ""])("rejects '%s'", (text) => {
    expect(parseValueType(text)).toBeNull();
  });

  it("gives up on absurd nesting instead of overflowing the stack", () => {
    const deep = `${"list<".repeat(20000)}string${">".repeat(20000)}`;
    expect(parseValueType(deep)).toBeNull();
  });

  it("does not resolve a type name off the prototype chain", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(parseValueType(name)).toBeNull();
    }
  });

  it("round-trips through its canonical spelling", () => {
    for (const text of ["string", "list<id>", "enum[a, b]"]) {
      expect(formatValueType(parseValueType(text)!)).toBe(text);
    }
  });
});

describe("typesCompatible", () => {
  it("lets unknown stand in for anything", () => {
    expect(typesCompatible(UNKNOWN, listOf(ID))).toBe(true);
    expect(typesCompatible(NUMBER, UNKNOWN)).toBe(true);
  });

  it("treats a person id as the string it is stored as", () => {
    expect(typesCompatible(ID, STRING)).toBe(true);
  });

  it("treats a date and a timestamp as the same instant family", () => {
    expect(typesCompatible(DATE, TIMESTAMP)).toBe(true);
  });

  it("compares enums by their members, not their identity", () => {
    expect(typesCompatible(enumOf(["a", "b"]), enumOf(["b", "a"]))).toBe(true);
    expect(typesCompatible(enumOf(["a", "b"]), enumOf(["a", "c"]))).toBe(false);
    expect(typesCompatible(enumOf(["a"]), STRING)).toBe(true);
  });

  it("refuses genuinely different types — this is what catches a never-cancel key", () => {
    expect(typesCompatible(STRING, TIMESTAMP)).toBe(false);
    expect(typesCompatible(NUMBER, BOOLEAN)).toBe(false);
    expect(typesCompatible(listOf(STRING), STRING)).toBe(false);
  });
});

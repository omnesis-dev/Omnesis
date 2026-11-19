// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DuckDBListValue } from "@duckdb/node-api";
import { describe, expect, test } from "vitest";
import { convertDuckDBValue } from "./internal.js";

describe("analytics integer serialization", () => {
  test("keeps existing safe integer results as numbers", () => {
    for (const value of [0n, 42n, 9007199254740991n, -9007199254740991n]) {
      expect(convertDuckDBValue(value)).toBe(Number(value));
    }
  });

  test("preserves unsafe integers, including signed limits and nested lists", () => {
    const values = [
      9007199254740992n,
      9007199254740993n,
      9223372036854775807n,
      -9223372036854775808n,
    ];
    expect(values.map(convertDuckDBValue)).toEqual(values.map(String));
    expect(convertDuckDBValue(new DuckDBListValue([42n, new DuckDBListValue(values)]))).toEqual([
      42,
      values.map(String),
    ]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import { getWidgetOrigins, resetWidgetOrigins, setWidgetOrigins } from "./widget-origins.js";
import { widgetOriginsBody } from "./http/schemas/admin.js";

describe("widget-origins registry", () => {
  afterEach(() => {
    // Process-level module state; reset so tests don't leak into each other.
    resetWidgetOrigins();
  });

  test("starts empty before any collector push", () => {
    expect(getWidgetOrigins()).toEqual({ script: [], frame: [], connect: [] });
  });

  test("stores the pushed origins per directive, sorted", () => {
    setWidgetOrigins({
      script: ["https://cdn.b.test", "https://cdn.a.test"],
      frame: ["https://*.b.test"],
      connect: ["https://api.b.test"],
    });
    expect(getWidgetOrigins()).toEqual({
      script: ["https://cdn.a.test", "https://cdn.b.test"],
      frame: ["https://*.b.test"],
      connect: ["https://api.b.test"],
    });
  });

  test("trims, de-duplicates, and drops empty entries", () => {
    setWidgetOrigins({
      script: ["  https://cdn.a.test ", "https://cdn.a.test", "", "  "],
      frame: [],
      connect: [],
    });
    expect(getWidgetOrigins().script).toEqual(["https://cdn.a.test"]);
  });

  test("omitted directives default to empty", () => {
    setWidgetOrigins({ script: ["https://cdn.a.test"] });
    expect(getWidgetOrigins()).toEqual({
      script: ["https://cdn.a.test"],
      frame: [],
      connect: [],
    });
  });

  test("re-pushing fully replaces the previous set", () => {
    setWidgetOrigins({ script: ["https://cdn.a.test"], frame: [], connect: [] });
    setWidgetOrigins({ script: ["https://cdn.b.test"], frame: [], connect: [] });
    expect(getWidgetOrigins().script).toEqual(["https://cdn.b.test"]);
  });
});

describe("widgetOriginsBody schema rejects malformed origins", () => {
  test("accepts https origins with optional wildcard and port", () => {
    const parsed = widgetOriginsBody.parse({
      script: ["https://cdn.plaid.com"],
      frame: ["https://*.plaid.com"],
      connect: ["https://production.plaid.com:443"],
    });
    expect(parsed.script).toEqual(["https://cdn.plaid.com"]);
  });

  test("defaults missing directives to empty arrays", () => {
    expect(widgetOriginsBody.parse({})).toEqual({ script: [], frame: [], connect: [] });
  });

  test.each([
    ["a path is not allowed", "https://cdn.plaid.com/link"],
    ["a bare host with no scheme is not allowed", "cdn.plaid.com"],
    ["a non-http scheme is not allowed", "ftp://cdn.plaid.com"],
    ["a 'self' keyword is not an origin (the policy adds 'self' itself)", "'self'"],
    ["a bare wildcard is not allowed", "https://*"],
  ])("rejects: %s", (_why, bad) => {
    expect(() => widgetOriginsBody.parse({ script: [bad], frame: [], connect: [] })).toThrow();
  });
});

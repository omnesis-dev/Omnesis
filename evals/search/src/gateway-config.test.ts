// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { gatewayConfig, parseVariants, RESULT_DEPTH } from "./gateway-config.js";

describe("gatewayConfig", () => {
  test("overrides search params and keeps the run's own settings", () => {
    const config = gatewayConfig({ rrfK: 20 });
    expect(config.search.params).toEqual({ candidateLimit: RESULT_DEPTH, rrfK: 20 });
    expect(config.search.temporal).toEqual({ enabled: false });
    expect(gatewayConfig({}).search.params).toEqual({ candidateLimit: RESULT_DEPTH });
  });
});

describe("parseVariants", () => {
  test("reads labels and their overrides in file order", () => {
    expect(parseVariants('{"settled": {}, "k20": {"rrfK": 20, "vectorWeight": 1.5}}')).toEqual([
      ["settled", {}],
      ["k20", { rrfK: 20, vectorWeight: 1.5 }],
    ]);
  });

  test.each([
    ["[]", "JSON object"],
    ['{"K20": {"rrfK": 20}}', "K20"],
    ['{"k20": {"rrfK": "20"}}', "k20"],
    ['{"k20": [20]}', "k20"],
    ['{"k20": null}', "k20"],
  ])("refuses %s", (text, message) => {
    expect(() => parseVariants(text)).toThrow(message);
  });
});

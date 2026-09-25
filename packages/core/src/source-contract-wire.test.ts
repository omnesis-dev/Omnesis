// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { assertGatewaySourceContract, SOURCE_CONTRACT_WIRE_RANGE } from "./source-contract-wire.js";

describe("source contract wire compatibility", () => {
  test.each([undefined, {}])(
    "an absent capability requires gateway upgrade (%j)",
    (capabilities) => {
      expect(() => assertGatewaySourceContract({ status: "ok", capabilities })).toThrow(
        "Gateway upgrade required",
      );
    },
  );

  test.each([null, {}, { status: "healthy" }, { status: "ok", capabilities: null }])(
    "invalid health responses are not treated as a legacy gateway (%j)",
    (health) =>
      expect(() => assertGatewaySourceContract(health)).toThrow("invalid health response"),
  );

  test.each([true, 1, { min: 0, max: 1 }, { min: 2, max: 1 }, { min: 1, max: 1.5 }])(
    "malformed capability refuses work (%j)",
    (sourceContract) => {
      expect(() =>
        assertGatewaySourceContract({ status: "ok", capabilities: { sourceContract } }),
      ).toThrow("invalid health response");
    },
  );

  test.each([SOURCE_CONTRACT_WIRE_RANGE, { min: 1, max: 2 }])(
    "an overlapping range is accepted (%j)",
    (sourceContract) => {
      expect(() =>
        assertGatewaySourceContract({ status: "ok", capabilities: { sourceContract } }),
      ).not.toThrow();
    },
  );

  test("a future gateway dropping our revision requires collector upgrade", () => {
    expect(() =>
      assertGatewaySourceContract({
        status: "ok",
        capabilities: { sourceContract: { min: 2, max: 3 } },
      }),
    ).toThrow("Collector upgrade required");
  });
});

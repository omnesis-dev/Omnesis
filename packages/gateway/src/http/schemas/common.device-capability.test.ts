// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { parseRequestPayload, PROTOCOL_VERSION, SOURCE_CONTRACT_WIRE_RANGE } from "@omnesis/core";
import { deviceCapabilitySchema } from "./common.js";

describe("deviceCapabilitySchema", () => {
  test("pairing and WS hello validate the same source-contract range", () => {
    const valid = { sourceContract: SOURCE_CONTRACT_WIRE_RANGE };
    expect(deviceCapabilitySchema.parse(valid)).toEqual(valid);
    expect(
      parseRequestPayload("hello", { protocolVersion: PROTOCOL_VERSION, capabilities: valid }).ok,
    ).toBe(true);
    const invalid = { sourceContract: { min: 2, max: 1 } };
    expect(deviceCapabilitySchema.safeParse(invalid).success).toBe(false);
    expect(
      parseRequestPayload("hello", { protocolVersion: PROTOCOL_VERSION, capabilities: invalid }).ok,
    ).toBe(false);
  });
  test("accepts only the affirmative remote-doctor capability", () => {
    expect(deviceCapabilitySchema.safeParse({ deviceDoctor: true }).success).toBe(true);
    expect(deviceCapabilitySchema.safeParse({ deviceDoctor: false }).success).toBe(false);
  });
});

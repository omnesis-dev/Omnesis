// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
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
  test.each([
    {
      name: "a future TLS mode with an extra key",
      capabilities: { tls: { mode: "pinned-chain", chainFingerprint: "ab".repeat(32) } },
      accepted: true,
    },
    {
      name: "a TLS mode longer than 32 characters",
      capabilities: { tls: { mode: "m".repeat(33) } },
      accepted: false,
    },
    {
      name: "an unknown top-level capability",
      capabilities: { capabilityFromANewerClient: { enabled: true } },
      accepted: true,
    },
  ])("pairing and WS hello agree on $name", ({ capabilities, accepted }) => {
    expect(deviceCapabilitySchema.safeParse(capabilities).success, "pairing").toBe(accepted);
    expect(
      parseRequestPayload("hello", { protocolVersion: PROTOCOL_VERSION, capabilities }).ok,
      "WS hello",
    ).toBe(accepted);
  });
  describe("the pairing-reminder capability", () => {
    afterEach(() => vi.unstubAllEnvs());
    test("is a typed boolean with the cloud relay opt-in", () => {
      vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
      expect(deviceCapabilitySchema.parse({ pairingNotifications: true })).toEqual({
        pairingNotifications: true,
      });
      const refused = deviceCapabilitySchema.safeParse({ pairingNotifications: "yes" });
      expect(refused.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
        {
          path: ["pairingNotifications"],
          message: "Invalid input: expected boolean, received string",
        },
      ]);
    });
    test("is an unknown key like any other without it", () => {
      vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "");
      for (const value of [true, "yes", { enabled: 1 }, null])
        expect(deviceCapabilitySchema.parse({ pairingNotifications: value })).toEqual({
          pairingNotifications: value,
        });
      expect(deviceCapabilitySchema.parse({})).toEqual({});
    });
  });
  test("validates native source scope facts ranges while accepting legacy absence", () => {
    for (const capabilities of [
      {},
      { sourceScopes: { min: 1, max: 1 } },
      { sourceScopes: { min: 2, max: 3 } },
    ]) {
      expect(deviceCapabilitySchema.safeParse(capabilities).success).toBe(true);
      expect(
        parseRequestPayload("hello", { protocolVersion: PROTOCOL_VERSION, capabilities }).ok,
      ).toBe(true);
    }
    for (const sourceScopes of [
      { min: 2, max: 1 },
      { min: 0, max: 1 },
      { min: 1.5, max: 2 },
    ]) {
      expect(deviceCapabilitySchema.safeParse({ sourceScopes }).success).toBe(false);
      expect(
        parseRequestPayload("hello", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { sourceScopes },
        }).ok,
      ).toBe(false);
    }
  });
  test("accepts only the affirmative remote-doctor capability", () => {
    expect(deviceCapabilitySchema.safeParse({ deviceDoctor: true }).success).toBe(true);
    expect(deviceCapabilitySchema.safeParse({ deviceDoctor: false }).success).toBe(false);
  });
});

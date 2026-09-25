// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading `/health` decides what gets installed and which tools get
 * registered, so the interesting cases are the ones where the answer is
 * absent or the responder is not a gateway at all.
 */

import { describe, expect, test } from "vitest";

import { parseGatewayCapabilities } from "./gateway-capabilities.js";

const HEALTH = {
  status: "ok",
  version: "0.4.0",
  experimental: false,
  capabilities: { subscriptions: false },
  compat: { schema: 200, ws: 3, pairing: 2, watchPrivacyPolicy: 1 },
};

describe("what the gateway says it can do", () => {
  test("reads the advertised capability and version", () => {
    expect(parseGatewayCapabilities(HEALTH)).toEqual({
      version: "0.4.0",
      subscriptions: false,
      watchPrivacyPolicy: 1,
    });
    expect(
      parseGatewayCapabilities({ ...HEALTH, capabilities: { subscriptions: true } }).subscriptions,
    ).toBe(true);
  });

  test("falls back to experimental mode on a gateway that names no capabilities", () => {
    // The whole story for a gateway older than the capability: experimental
    // mode was the gate, so it is the honest answer to the same question.
    const older = { status: "ok", version: "0.3.0", compat: { watchPrivacyPolicy: 1 } };
    expect(parseGatewayCapabilities({ ...older, experimental: true }).subscriptions).toBe(true);
    expect(parseGatewayCapabilities({ ...older, experimental: false }).subscriptions).toBe(false);
    expect(parseGatewayCapabilities(older).subscriptions).toBe(false);
  });

  test("prefers the capability over experimental mode when both are present", () => {
    expect(
      parseGatewayCapabilities({ ...HEALTH, experimental: true, capabilities: {} }).subscriptions,
    ).toBe(false);
  });

  test("omits a version and contract it was not told", () => {
    expect(parseGatewayCapabilities({ status: "ok" })).toEqual({ subscriptions: false });
  });

  test("refuses to read anything that is not an Omnesis health response", () => {
    // A proxy, a captive portal, or a load balancer's error page must not be
    // read as "this gateway has no capabilities" — a caller would persist that
    // and drop the tools it decides by.
    for (const body of [null, undefined, "ok", 200, [], {}, { capabilities: {} }]) {
      expect(() => parseGatewayCapabilities(body)).toThrow(/health response/u);
    }
  });
});

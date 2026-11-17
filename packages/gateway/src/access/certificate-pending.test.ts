// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { pendingCertificateOrigins, relayCertificatePending } from "./certificate-pending.js";
import type { CloudRelayManagementStatus } from "@omnesis/cloud-relay";

const RELAY_ORIGIN = "https://quiet-river.relay.example.net";

function relayStatus(overrides: {
  enabled?: boolean;
  enrollment?: CloudRelayManagementStatus["enrollment"]["state"];
  certificate?: CloudRelayManagementStatus["certificate"]["state"];
  lastError?: CloudRelayManagementStatus["certificate"]["lastError"];
}): CloudRelayManagementStatus {
  return {
    enabled: overrides.enabled ?? true,
    publicOrigin: RELAY_ORIGIN,
    enrollment: { state: overrides.enrollment ?? "enrolled" },
    certificate: {
      state: overrides.certificate ?? "valid",
      ...(overrides.lastError ? { lastError: overrides.lastError } : {}),
    },
  } as CloudRelayManagementStatus;
}

describe("relayCertificatePending", () => {
  test("is pending while the relay enrolls or before its certificate is issued", () => {
    expect(
      relayCertificatePending(relayStatus({ enrollment: "pending", certificate: "unconfigured" })),
    ).toBe(true);
    expect(relayCertificatePending(relayStatus({ certificate: "unconfigured" }))).toBe(true);
    expect(relayCertificatePending(relayStatus({ certificate: "bootstrap" }))).toBe(true);
  });

  test("is not pending once issued, when off, refused or failed", () => {
    expect(relayCertificatePending(relayStatus({ certificate: "valid" }))).toBe(false);
    expect(relayCertificatePending(relayStatus({ certificate: "expiring" }))).toBe(false);
    expect(
      relayCertificatePending(relayStatus({ enabled: false, certificate: "unconfigured" })),
    ).toBe(false);
    expect(
      relayCertificatePending(relayStatus({ enrollment: "failed", certificate: "unconfigured" })),
    ).toBe(false);
    expect(
      relayCertificatePending(
        relayStatus({ certificate: "bootstrap", lastError: "certificate-renewal-failed" }),
      ),
    ).toBe(false);
  });
});

describe("pendingCertificateOrigins", () => {
  const tailscale = (origin: string | null, pending: boolean) => ({
    tailnetOrigin: () => origin,
    tailnetCertificatePending: () => pending,
  });

  test("names the tailnet device and the relay while their certificates are on the way", async () => {
    const origins = await pendingCertificateOrigins({
      tailscale: tailscale("https://gateway.tail0000.ts.net", true),
      relay: { status: async () => relayStatus({ certificate: "bootstrap" }) },
    });
    expect([...origins]).toEqual(["https://gateway.tail0000.ts.net", RELAY_ORIGIN]);
  });

  test("names nothing once issued, without the features, or when the relay cannot say", async () => {
    expect(
      await pendingCertificateOrigins({
        tailscale: tailscale("https://gateway.tail0000.ts.net", false),
        relay: { status: async () => relayStatus({}) },
      }),
    ).toEqual(new Set());
    expect(await pendingCertificateOrigins({})).toEqual(new Set());
    expect(
      await pendingCertificateOrigins({
        tailscale: tailscale(null, true),
        relay: { status: () => Promise.reject(new Error("relay unavailable")) },
      }),
    ).toEqual(new Set());
  });
});

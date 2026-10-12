// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  deviceTlsTrust,
  deviceTlsTrustMode,
  type TlsTrustDeviceFacts,
  type TlsTrustSnapshotFacts,
} from "./tls-device-trust.js";

const FINGERPRINT = "ab".repeat(32);
const ROTATED_AT = "2026-09-10T00:00:00.000Z";
const BEFORE = Date.parse(ROTATED_AT) - 1000;
const AFTER = Date.parse(ROTATED_AT) + 1000;
const RENEWS_AT = "2026-12-10T00:00:00.000Z";

function snapshot(patch: Partial<TlsTrustSnapshotFacts> = {}): TlsTrustSnapshotFacts {
  return {
    served: {
      state: "valid",
      fingerprintSha256: FINGERPRINT,
      subject: "CN=gateway.tail-example.ts.net",
      issuer: "CN=test root",
      selfSigned: false,
      notBefore: "2026-09-10T00:00:00.000Z",
      notAfter: "2026-12-09T00:00:00.000Z",
      daysRemaining: 88,
      names: ["gateway.tail-example.ts.net"],
      uncoveredHosts: [],
    },
    rotation: null,
    renewsAt: null,
    ...patch,
  };
}

function device(patch: Partial<TlsTrustDeviceFacts> = {}): TlsTrustDeviceFacts {
  return { name: "studio-phone", kind: "ios", pairedAt: BEFORE, lastSeenAt: BEFORE, ...patch };
}

const rotated = snapshot({
  rotation: { previousFingerprintSha256: "cd".repeat(32), rotatedAt: ROTATED_AT },
});

describe("deviceTlsTrust", () => {
  test("a device that verifies by name, or carries no pin, is never flagged", () => {
    for (const tlsMode of ["system", "legacy"] as const) {
      expect(deviceTlsTrust(device({ tlsMode }), rotated)).toBeNull();
      expect(deviceTlsTrust(device({ tlsMode }), snapshot({ renewsAt: RENEWS_AT }))).toBeNull();
    }
  });

  test("a pinned authority signs every renewal, so it is never flagged", () => {
    expect(deviceTlsTrust(device({ tlsMode: "pinned-ca" }), rotated)).toBeNull();
    expect(
      deviceTlsTrust(device({ tlsMode: "pinned-ca" }), snapshot({ renewsAt: RENEWS_AT })),
    ).toBeNull();
  });

  test("a stranded phone that reports its pin is told to pair again, not to update", () => {
    expect(deviceTlsTrust(device({ tlsMode: "pinned-leaf" }), rotated)?.remedy).toBe(
      "Pair it again: `omnesis devices repair studio-phone`.",
    );
  });

  test("the reported mode narrows to the known ones; anything else reads as unreported", () => {
    expect(deviceTlsTrustMode({ tls: { mode: "pinned-leaf" } })).toBe("pinned-leaf");
    expect(deviceTlsTrustMode({ tls: { mode: "pinned-ca", extra: 1 } })).toBe("pinned-ca");
    expect(deviceTlsTrustMode({ tls: { mode: "future-mode" } })).toBeNull();
    expect(deviceTlsTrustMode({ tls: "system" })).toBeNull();
    expect(deviceTlsTrustMode({})).toBeNull();
    expect(deviceTlsTrustMode(null)).toBeNull();
  });

  test("a revoked device and a missing snapshot are never flagged", () => {
    expect(deviceTlsTrust(device({ revokedAt: BEFORE }), rotated)).toBeNull();
    expect(deviceTlsTrust(device(), null)).toBeNull();
  });

  test("a phone or agent paired before a rotation and silent since is stranded", () => {
    expect(deviceTlsTrust(device(), rotated)).toEqual({
      status: "stranded",
      rotatedAt: ROTATED_AT,
      remedy:
        "Update the app and open it, or pair it again: `omnesis devices repair studio-phone`.",
    });
    expect(
      deviceTlsTrust(
        device({ name: "studio-agent", kind: "agent", harness: "openclaw", lastSeenAt: null }),
        rotated,
      ),
    ).toEqual({
      status: "stranded",
      rotatedAt: ROTATED_AT,
      remedy: `On the machine running it: \`omnesis connect openclaw --refresh --trust-fingerprint sha256:${FINGERPRINT}\`.`,
    });
  });

  test("a device that connected after the rotation, or paired after it, is not stranded", () => {
    expect(deviceTlsTrust(device({ lastSeenAt: AFTER }), rotated)).toBeNull();
    expect(deviceTlsTrust(device({ pairedAt: AFTER, lastSeenAt: null }), rotated)).toBeNull();
  });

  test("a device kind that never pins is stranded only when it reports a pin", () => {
    expect(deviceTlsTrust(device({ kind: "collector" }), rotated)).toBeNull();
    // An agent device that is not a managed harness connects through a client
    // that verifies by name.
    expect(deviceTlsTrust(device({ kind: "agent", harness: null }), rotated)).toBeNull();
    expect(deviceTlsTrust(device({ kind: "collector", tlsMode: "pinned-leaf" }), rotated)).toEqual(
      expect.objectContaining({
        status: "stranded",
        remedy: "On that machine: `omnesis tls trust`.",
      }),
    );
  });

  test("a reported pin is flagged ahead of the gateway's own renewal; an unreported mode is not", () => {
    const renewing = snapshot({ renewsAt: RENEWS_AT });
    expect(deviceTlsTrust(device({ tlsMode: "pinned-leaf" }), renewing)).toEqual({
      status: "pinned-renews",
      renewsAt: RENEWS_AT,
      remedy:
        "Pair it again by the gateway's Tailscale or domain name to follow renewals; otherwise it needs `omnesis devices repair studio-phone` after the renewal.",
    });
    // Nothing run before the renewal can trust the next certificate, so an
    // agent is not handed a fingerprint ahead of time.
    expect(
      deviceTlsTrust(device({ kind: "agent", harness: "hermes", tlsMode: "pinned-leaf" }), renewing)
        ?.remedy,
    ).not.toContain("--trust-fingerprint");
    expect(deviceTlsTrust(device(), renewing)).toBeNull();
    expect(deviceTlsTrust(device({ tlsMode: "pinned-leaf" }), snapshot())).toBeNull();
  });

  test("an agent's remedy omits the fingerprint when the served certificate is unreadable", () => {
    const unreadable = snapshot({
      ...rotated,
      served: { ...rotated.served, fingerprintSha256: null },
    });
    expect(deviceTlsTrust(device({ kind: "agent", harness: "hermes" }), unreadable)?.remedy).toBe(
      "On the machine running it: `omnesis connect hermes --refresh`.",
    );
  });
});

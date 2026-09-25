// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { checkGatewayTls, type TlsCheckSink } from "./tls-checks.js";
import type { TlsLifecycleSnapshot } from "../tls-material.js";

interface Recorded {
  status: "pass" | "warn" | "fail";
  section: string;
  id: string;
  message: string;
  hint?: string;
}

function sink(): TlsCheckSink & { out: Recorded[] } {
  const out: Recorded[] = [];
  return {
    out,
    pass: (section, id, message) => out.push({ status: "pass", section, id, message }),
    warn: (section, id, message, hint) => out.push({ status: "warn", section, id, message, hint }),
    fail: (section, id, message, hint) => out.push({ status: "fail", section, id, message, hint }),
  };
}

function snapshot(overrides: Partial<TlsLifecycleSnapshot> = {}): TlsLifecycleSnapshot {
  return {
    checkedAt: "2026-09-14T00:00:00.000Z",
    ownership: "self-signed",
    certPath: "/srv/omnesis/tls/cert.pem",
    keyPath: "/srv/omnesis/tls/key.pem",
    served: {
      state: "valid",
      fingerprintSha256: "ab".repeat(32),
      subject: "CN=gateway (self-signed)",
      issuer: "CN=gateway (self-signed)",
      selfSigned: true,
      notBefore: "2026-09-01T00:00:00.000Z",
      notAfter: "2036-09-01T00:00:00.000Z",
      daysRemaining: 3640,
      names: ["localhost", "gateway"],
      uncoveredHosts: [],
    },
    pendingReplacement: null,
    renewal: {
      mode: "automatic",
      renewBeforeDays: 30,
      lastAttemptAt: null,
      lastError: null,
      lastRenewedAt: null,
    },
    rotation: null,
    ...overrides,
  };
}

const served = (
  patch: Partial<TlsLifecycleSnapshot["served"]>,
): TlsLifecycleSnapshot["served"] => ({ ...snapshot().served, ...patch });

describe("checkGatewayTls", () => {
  test("an older gateway without a snapshot adds nothing", () => {
    const ck = sink();
    checkGatewayTls(undefined, [], ck);
    checkGatewayTls(null, [], ck);
    expect(ck.out).toEqual([]);
  });

  test("a valid certificate passes with its expiry", () => {
    const ck = sink();
    checkGatewayTls(snapshot(), [], ck);
    expect(ck.out).toEqual([
      {
        status: "pass",
        section: "Gateway",
        id: "gateway.tls",
        message:
          "Serving the gateway's self-signed certificate, valid until 2036-09-01T00:00:00.000Z (3640 days)",
      },
    ]);
  });

  test("expiring warns with the remedy for the renewal mode, expired fails and names the pinned clients", () => {
    const expiring = sink();
    checkGatewayTls(
      snapshot({
        ownership: "tailscale",
        served: served({
          state: "expiring",
          daysRemaining: 12,
          notAfter: "2026-09-26T00:00:00.000Z",
        }),
        renewal: {
          mode: "automatic",
          renewBeforeDays: 30,
          lastAttemptAt: "2026-09-13T03:00:00.000Z",
          lastError: "`tailscale cert` failed: HTTPS is not enabled",
          lastRenewedAt: null,
        },
      }),
      [],
      expiring,
    );
    expect(expiring.out.map((c) => c.id)).toEqual(["gateway.tls", "gateway.tls-renewal"]);
    expect(expiring.out[0]).toMatchObject({
      status: "warn",
      message: expect.stringMatching(
        /^the tailscale certificate expires in 12 days \(2026-09-26T00:00:00.000Z\)$/iu,
      ),
      hint: expect.stringMatching(
        /renews it itself from 30 days.*The last attempt \(2026-09-13T03:00:00.000Z\) failed: `tailscale cert` failed/u,
      ),
    });
    expect(expiring.out[1]).toMatchObject({
      status: "warn",
      hint: expect.stringMatching(/Tailscale operator.*omnesis tls refresh/u),
    });

    const expired = sink();
    checkGatewayTls(
      snapshot({
        served: served({ state: "expired", daysRemaining: -4 }),
        renewal: { ...snapshot().renewal, mode: "disabled" },
      }),
      [],
      expired,
    );
    expect(expired.out).toHaveLength(1);
    expect(expired.out[0]).toMatchObject({
      status: "fail",
      id: "gateway.tls",
      message: expect.stringMatching(/expired 4 days ago.*cannot connect/u),
      hint: expect.stringMatching(
        /Automatic renewal is off.*omnesis tls renew.*omnesis devices repair <name>.*omnesis tls trust/u,
      ),
    });
  });

  test("a container's installer tier and an operator's own material are renewed elsewhere", () => {
    const host = sink();
    checkGatewayTls(
      snapshot({
        ownership: "mkcert",
        certPath: "/srv/omnesis/tls/mkcert.crt",
        served: served({ state: "expiring", daysRemaining: 3 }),
        renewal: { ...snapshot().renewal, mode: "host" },
      }),
      [],
      host,
    );
    expect(host.out[0]?.hint).toMatch(
      /runs in a container, so the mkcert certificate is renewed on the host: re-run its issuer into \/srv\/omnesis\/tls\/mkcert.crt, then `omnesis tls reload`/u,
    );

    const external = sink();
    checkGatewayTls(
      snapshot({
        ownership: "external",
        certPath: "/etc/letsencrypt/live/gw/fullchain.pem",
        served: served({ state: "expired", daysRemaining: -1, selfSigned: false }),
        renewal: { ...snapshot().renewal, mode: "external" },
      }),
      [],
      external,
    );
    expect(external.out[0]).toMatchObject({
      status: "fail",
      message: expect.stringMatching(/^The operator-managed certificate expired 1 days ago/u),
      hint: expect.stringMatching(/Renew it with the tool that issued it.*omnesis tls reload/u),
    });
  });

  test("a clock problem and unverifiable material fail with their own remedies", () => {
    const clock = sink();
    checkGatewayTls(snapshot({ served: served({ state: "not-yet-valid" }) }), [], clock);
    expect(clock.out[0]).toMatchObject({
      status: "fail",
      message: "The gateway's self-signed certificate is not valid before 2026-09-01T00:00:00.000Z",
      hint: expect.stringMatching(/clock/u),
    });

    const broken = sink();
    checkGatewayTls(
      snapshot({
        served: served({
          state: "key-mismatch",
          error: "The private key does not belong to the certificate.",
        }),
      }),
      [],
      broken,
    );
    expect(broken.out[0]).toMatchObject({
      status: "fail",
      message: expect.stringMatching(/could not be verified: The private key does not belong/u),
    });
  });

  test("uncovered names and a replacement that could not be activated are warnings beside a valid certificate", () => {
    const ck = sink();
    checkGatewayTls(
      snapshot({
        served: served({ uncoveredHosts: ["gw.tail.example", "omnesis.local"] }),
        pendingReplacement: {
          fingerprintSha256: "cd".repeat(32),
          error: "it expired on 2026-01-01T00:00:00.000Z",
        },
      }),
      [],
      ck,
    );
    expect(ck.out.map((c) => [c.id, c.status])).toEqual([
      ["gateway.tls", "pass"],
      ["gateway.tls-names", "warn"],
      ["gateway.tls-replacement", "warn"],
    ]);
    expect(ck.out[1]).toMatchObject({
      message: expect.stringMatching(
        /does not cover gw.tail.example, omnesis.local; .*those names/u,
      ),
      hint: expect.stringMatching(/omnesis tls renew --force.*omnesis devices repair/u),
    });
    expect(ck.out[2]?.hint).toMatch(/omnesis tls reload/u);

    const tier = sink();
    checkGatewayTls(
      snapshot({ ownership: "mkcert", served: served({ uncoveredHosts: ["192.0.2.60"] }) }),
      [],
      tier,
    );
    expect(tier.out[1]).toMatchObject({
      message: expect.stringMatching(/that name/u),
      hint: "Run `omnesis tls refresh` on the gateway host to re-provision it for the current names.",
    });
  });

  test("phones paired before a rotation and silent since are named for repair; the rest are not", () => {
    const rotatedAt = "2026-09-10T00:00:00.000Z";
    const before = Date.parse(rotatedAt) - 1000;
    const after = Date.parse(rotatedAt) + 1000;
    const ck = sink();
    checkGatewayTls(
      snapshot({ rotation: { previousFingerprintSha256: "cd".repeat(32), rotatedAt } }),
      [
        { name: "old-phone", kind: "ios", pairedAt: before, lastSeenAt: before },
        { name: "silent-phone", kind: "android", pairedAt: before, lastSeenAt: null },
        { name: "fine-phone", kind: "ios", pairedAt: before, lastSeenAt: after },
        { name: "new-phone", kind: "ios", pairedAt: after, lastSeenAt: null },
        {
          name: "revoked-phone",
          kind: "ios",
          pairedAt: before,
          lastSeenAt: before,
          revokedAt: before,
        },
        { name: "studio-collector", kind: "collector", pairedAt: before, lastSeenAt: before },
      ],
      ck,
    );
    const repair = ck.out.find((c) => c.id === "fleet.tls-pin-repair");
    expect(repair).toMatchObject({
      status: "warn",
      section: "Fleet",
      message: `2 phones paired before the certificate rotated on ${rotatedAt} have not connected since: old-phone, silent-phone`,
      hint: expect.stringMatching(
        /omnesis devices repair <name>.*system trust reconnects on its own/u,
      ),
    });

    const one = sink();
    checkGatewayTls(
      snapshot({ rotation: { previousFingerprintSha256: "cd".repeat(32), rotatedAt } }),
      [{ name: "old-phone", kind: "ios", pairedAt: before, lastSeenAt: before }],
      one,
    );
    expect(one.out.find((c) => c.id === "fleet.tls-pin-repair")).toMatchObject({
      message: expect.stringMatching(/^1 phone paired .* has not connected since: old-phone$/u),
      hint: expect.stringMatching(/omnesis devices repair old-phone`/u),
    });

    const none = sink();
    checkGatewayTls(
      snapshot({ rotation: { previousFingerprintSha256: "cd".repeat(32), rotatedAt } }),
      [],
      none,
    );
    expect(none.out.map((c) => c.id)).toEqual(["gateway.tls"]);

    // A certificate issued by a CA is verified by name; its rotation strands no phone.
    const issued = sink();
    checkGatewayTls(
      snapshot({
        ownership: "tailscale",
        served: served({ selfSigned: false }),
        rotation: { previousFingerprintSha256: "cd".repeat(32), rotatedAt },
      }),
      [{ name: "old-phone", kind: "ios", pairedAt: before, lastSeenAt: before }],
      issued,
    );
    expect(issued.out.map((c) => c.id)).toEqual(["gateway.tls"]);
  });
});

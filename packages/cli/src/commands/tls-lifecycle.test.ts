// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  renderTlsStatus,
  runTlsReload,
  runTlsRenew,
  runTlsStatus,
  runTlsTrust,
  type TlsLifecycleDeps,
} from "./tls-lifecycle.js";
import { activateProvisionedMaterial } from "./tls-provision.js";
import type { TlsLifecycleSnapshot } from "@omnesis/core";

function snapshot(overrides: Partial<TlsLifecycleSnapshot> = {}): TlsLifecycleSnapshot {
  return {
    checkedAt: "2026-09-14T00:00:00.000Z",
    ownership: "tailscale",
    certPath: "/srv/omnesis/tls/tailscale.crt",
    keyPath: "/srv/omnesis/tls/tailscale.key",
    served: {
      state: "expiring",
      fingerprintSha256: "ab".repeat(32),
      subject: "CN=studio.tail-example.ts.net",
      issuer: "CN=Example CA",
      selfSigned: false,
      notBefore: "2026-07-01T00:00:00.000Z",
      notAfter: "2026-09-29T00:00:00.000Z",
      daysRemaining: 15,
      names: ["studio.tail-example.ts.net"],
      uncoveredHosts: ["omnesis.local"],
    },
    pendingReplacement: null,
    renewal: {
      mode: "automatic",
      renewBeforeDays: 30,
      lastAttemptAt: "2026-09-13T03:00:00.000Z",
      lastError: "`tailscale cert` failed: HTTPS is not enabled",
      lastRenewedAt: null,
    },
    rotation: {
      previousFingerprintSha256: "cd".repeat(32),
      rotatedAt: "2026-07-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function deps(overrides: Partial<TlsLifecycleDeps> = {}): TlsLifecycleDeps {
  return {
    status: async () => snapshot(),
    reload: async () => snapshot(),
    renew: async () => ({ ok: true, fingerprintSha256: "ef".repeat(32), snapshot: snapshot() }),
    ...overrides,
  };
}

const lines: string[] = [];
const print = (line: string) => {
  lines.push(line);
};
const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
  lines.push(args.join(" "));
});
afterEach(() => {
  lines.length = 0;
});

describe("renderTlsStatus", () => {
  test("names the hosts a trusted reverse proxy serves instead of this certificate", () => {
    renderTlsStatus(snapshot({ proxiedHosts: ["omnesis.example.com"] }), print);
    expect(lines.join("\n")).toContain("via proxy");
    expect(lines.join("\n")).toContain("omnesis.example.com");
    lines.length = 0;
    renderTlsStatus(snapshot(), print);
    expect(lines.join("\n")).not.toContain("via proxy");
  });

  test("says what is served, when it expires, what it misses, how it renews and what the last attempt did", () => {
    renderTlsStatus(snapshot(), print);
    const text = lines.join("\n");
    expect(text).toContain("expiring");
    expect(text).toContain("Tailscale, minted by Omnesis");
    expect(text).toContain("15 days remaining");
    expect(text).toContain("not covered");
    expect(text).toContain("omnesis.local");
    expect(text).toContain("automatic, 30 days before expiry");
    expect(text).toContain("HTTPS is not enabled");
    expect(text).toContain("previously sha256:" + "cd".repeat(32));
    expect(text).toContain("omnesis devices repair");
  });

  test("an expired operator-managed certificate names its own renewal path", () => {
    renderTlsStatus(
      snapshot({
        ownership: "external",
        served: { ...snapshot().served, state: "expired", daysRemaining: -3, uncoveredHosts: [] },
        renewal: { ...snapshot().renewal, mode: "external", lastError: null },
        rotation: null,
        pendingReplacement: {
          fingerprintSha256: null,
          error: "The private key does not belong to the certificate.",
        },
      }),
      print,
    );
    const text = lines.join("\n");
    expect(text).toContain("expired 3 days ago");
    expect(text).toContain("by the tool that issued it");
    expect(text).toContain("a replacement was not activated: The private key does not belong");
    expect(text).not.toContain("not covered");
  });
});

describe("commands", () => {
  test("status prints the snapshot as JSON when asked", async () => {
    await runTlsStatus(deps(), true);
    expect(JSON.parse(lines[0]!)).toEqual(snapshot());
  });

  test("status exits non-zero for anything but valid or expiring", async () => {
    await expect(runTlsStatus(deps(), false)).resolves.toBeUndefined();
    await expect(
      runTlsStatus(
        deps({
          status: async () => snapshot({ served: { ...snapshot().served, state: "expired" } }),
        }),
        false,
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  test("renew passes force through and fails when the gateway refused", async () => {
    const forces: boolean[] = [];
    await runTlsRenew(
      deps({
        renew: async (force) => {
          forces.push(force);
          return { ok: true, fingerprintSha256: "ef".repeat(32), snapshot: snapshot() };
        },
      }),
      true,
      false,
    );
    expect(forces).toEqual([true]);
    expect(lines.join("\n")).toContain("Renewed and activated");

    await expect(
      runTlsRenew(
        deps({
          renew: async () => ({ ok: false, reason: "operator-managed", snapshot: snapshot() }),
        }),
        false,
        false,
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(lines.join("\n")).toContain("Not renewed: operator-managed");
  });

  test("reload reports what is served, or why the replacement stayed on disk", async () => {
    await runTlsReload(deps(), false);
    expect(lines.join("\n")).toContain("Serving the material at /srv/omnesis/tls/tailscale.crt");
    await expect(
      runTlsReload(
        deps({
          reload: async () =>
            snapshot({
              pendingReplacement: {
                fingerprintSha256: "12".repeat(32),
                error: "it expired on 2026-01-01",
              },
            }),
        }),
        false,
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(lines.join("\n")).toContain("Not activated: it expired on 2026-01-01");
  });

  test("trust refuses on the gateway host and on a plain http URL, and otherwise re-trusts", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-tls-trust-"));
    try {
      const retrust = vi.fn(async () => ({
        fingerprint: "ab".repeat(32),
        previousFingerprint: "cd".repeat(32),
        certPath: join(configDir, "tls", "cert.pem"),
      }));
      await expect(
        runTlsTrust({ gatewayUrl: "http://localhost:7600", configDir }, retrust, false),
      ).rejects.toThrow(/not https/u);

      await runTlsTrust(
        { gatewayUrl: "https://gw.example:7600", configDir, fingerprint: "ab".repeat(32) },
        retrust,
        false,
      );
      expect(retrust).toHaveBeenCalledWith({
        gatewayUrl: "https://gw.example:7600",
        configDir,
        expectedFingerprint: "ab".repeat(32),
      });
      expect(lines.join("\n")).toContain("replacing sha256:" + "cd".repeat(32));

      mkdirSync(join(configDir, "tls"), { recursive: true });
      writeFileSync(join(configDir, "tls", "tailscale.key"), "the gateway's own key");
      await expect(
        runTlsTrust({ gatewayUrl: "https://gw.example:7600", configDir }, retrust, false),
      ).rejects.toThrow(/holds the gateway's own certificate/u);
      expect(retrust).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("activateProvisionedMaterial", () => {
  test("activated when the gateway reloaded and serves the written path; otherwise the reason", async () => {
    const path = "/srv/omnesis/tls/tailscale.crt";
    expect(await activateProvisionedMaterial(path, { reload: async () => snapshot() })).toEqual({
      activated: true,
      fingerprintSha256: "ab".repeat(32),
    });
    expect(
      await activateProvisionedMaterial(path, {
        reload: async () => snapshot({ certPath: "/srv/omnesis/tls/cert.pem" }),
      }),
    ).toEqual({ activated: false, reason: "the gateway is serving /srv/omnesis/tls/cert.pem" });
    expect(
      await activateProvisionedMaterial(path, {
        reload: async () =>
          snapshot({ pendingReplacement: { fingerprintSha256: null, error: "no key" } }),
      }),
    ).toEqual({ activated: false, reason: "no key" });
    expect(
      await activateProvisionedMaterial(path, {
        reload: async () => {
          throw new Error("Gateway 404 /admin/tls/reload");
        },
      }),
    ).toEqual({ activated: false, reason: "Gateway 404 /admin/tls/reload" });
  });
});

afterEach(() => logSpy.mockClear());

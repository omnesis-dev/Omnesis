// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { PairingQrService } from "./PairingQrService.js";
import type { NetworkIdentity } from "@omnesis/core";
import type { DeviceKind } from "@omnesis/types";

const IDENTITIES: NetworkIdentity[] = [
  { address: "192.168.1.20", label: "LAN (en0)", kind: "lan", offLan: false },
  { address: "studio-northstar.local", label: "mDNS (.local)", kind: "mdns", offLan: false },
  {
    address: "studio.tail-example.ts.net",
    label: "Tailscale (MagicDNS)",
    kind: "tailscale-magicdns",
    offLan: true,
  },
  { address: "100.101.102.103", label: "Tailscale", kind: "tailscale", offLan: true },
];

/** A service whose every pending code belongs to `kind` (Android: no platform refusals). */
function qr(
  tlsFingerprint?: string | (() => string),
  systemTrustOrigins?: readonly string[] | (() => readonly string[]),
  kind: DeviceKind | null = "android",
  extra: {
    identities?: NetworkIdentity[];
    publiclyTrustedHosts?: string[];
    listenPort?: number;
    advertisedLocalName?: string | null;
    certificateRenewsAt?: Date | null;
  } = {},
): PairingQrService {
  return new PairingQrService({
    tlsFingerprint,
    systemTrustOrigins,
    pairingKind: () => kind,
    discoverIdentities: async () => extra.identities ?? IDENTITIES,
    publiclyTrustedHosts: extra.publiclyTrustedHosts
      ? () => extra.publiclyTrustedHosts!
      : undefined,
    listenPort: extra.listenPort,
    advertisedLocalName: () => extra.advertisedLocalName ?? null,
    certificateRenewsAt: () => extra.certificateRenewsAt ?? null,
  });
}

describe("PairingQrService", () => {
  it("reads the served fingerprint at encode time; system trust carries none", () => {
    let served = "ab12cd34".repeat(8);
    const service = qr(() => served, ["https://public-gateway.example.com"]);
    const payload = (gatewayUrl: string) =>
      JSON.parse(service.encode({ pairingCode: "ABCDEF0123", gatewayUrl, trustMode: "auto" })) as {
        v: number;
        fingerprint?: string;
        tls?: unknown;
      };
    expect(payload("https://192.0.2.10:7600")).toMatchObject({ v: 3, fingerprint: served });
    served = "ef56ab78".repeat(8);
    expect(payload("https://192.0.2.10:7600")).toMatchObject({ v: 3, fingerprint: served });
    expect(payload("https://public-gateway.example.com")).toMatchObject({
      v: 4,
      tls: { mode: "system" },
    });
  });

  it("lists network identities with the platform-trusted ones first", async () => {
    const service = qr(undefined, ["https://studio.tail-example.ts.net:7600"]);
    expect((await service.networkIdentities()).map((i) => i.address)).toEqual([
      "studio.tail-example.ts.net",
      "192.168.1.20",
      "studio-northstar.local",
      "100.101.102.103",
    ]);
  });

  const fingerprint = "ab12cd34".repeat(8);

  it("emits system-trusted V4 only for an exact allowlisted HTTPS origin", () => {
    const service = qr(fingerprint, ["https://public-gateway.example.com"]);
    expect(
      JSON.parse(
        service.encode({
          pairingCode: "ABCDEF0123",
          gatewayUrl: "https://public-gateway.example.com",
          trustMode: "system",
        }),
      ),
    ).toEqual({
      v: 4,
      gatewayUrl: "https://public-gateway.example.com",
      pairingCode: "ABCDEF0123",
      tls: { mode: "system" },
    });
    for (const gatewayUrl of [
      "http://public-gateway.example.com",
      "https://public-gateway.example.com.attacker.invalid",
      "https://attacker.invalid@public-gateway.example.com",
      "https://public-gateway.example.com/path",
      "https://other.example.com",
    ]) {
      expect(() =>
        service.encode({ pairingCode: "ABCDEF0123", gatewayUrl, trustMode: "system" }),
      ).toThrow();
    }
  });

  it("emits pinned-leaf V4 only when the gateway has a fingerprint", () => {
    const encoded = qr(fingerprint).encode({
      pairingCode: "ABCDEF0123",
      gatewayUrl: "https://gateway.example.com",
      trustMode: "pinned-leaf",
    });
    expect(JSON.parse(encoded).tls).toEqual({ mode: "pinned-leaf", fingerprint });
    expect(() =>
      qr().encode({
        pairingCode: "ABCDEF0123",
        gatewayUrl: "https://gateway.example.com",
        trustMode: "pinned-leaf",
      }),
    ).toThrow();
  });

  it("automatically prefers stable system trust for an exact allowlisted origin", () => {
    const first = qr(fingerprint, ["https://public-gateway.example.com"]);
    const renewed = qr("cd34ef56".repeat(8), ["https://public-gateway.example.com"]);
    const input = {
      pairingCode: "ABCDEF0123",
      gatewayUrl: "https://public-gateway.example.com",
      trustMode: "auto" as const,
    };
    expect(first.encode(input)).toBe(renewed.encode(input));
    expect(JSON.parse(first.encode(input))).toEqual({
      v: 4,
      gatewayUrl: "https://public-gateway.example.com",
      pairingCode: "ABCDEF0123",
      tls: { mode: "system" },
    });
  });

  it("automatically falls back to leaf pinning outside the exact allowlist", () => {
    const service = qr(fingerprint, ["https://public-gateway.example.com"]);
    const payload = JSON.parse(
      service.encode({
        pairingCode: "ABCDEF0123",
        gatewayUrl: "https://private-gateway.example.com",
        trustMode: "auto",
      }),
    );
    expect(payload).toMatchObject({
      v: 3,
      gatewayUrl: "https://private-gateway.example.com",
      fingerprint,
    });
  });

  it("refuses a plain HTTP address, which no phone app accepts", () => {
    expect(() =>
      qr().encode({
        pairingCode: "ABCDEF0123",
        gatewayUrl: "http://localhost:7600",
        trustMode: "auto",
      }),
    ).toThrow(/HTTPS/);
  });

  it("preserves the rollout-safe V3/V2 defaults when trustMode is omitted", () => {
    expect(
      JSON.parse(
        qr(fingerprint).encode({
          pairingCode: "ABCDEF0123",
          gatewayUrl: "https://gateway.example.com",
        }),
      ).v,
    ).toBe(3);
    expect(
      JSON.parse(
        qr().encode({
          pairingCode: "ABCDEF0123",
          gatewayUrl: "https://localhost:7600",
        }),
      ).v,
    ).toBe(2);
  });

  it("does not crash construction for a legacy base URL that is not an origin", () => {
    const service = qr(fingerprint, ["https://gateway.example.com/base"]);
    expect(() =>
      service.encode({
        pairingCode: "ABCDEF0123",
        gatewayUrl: "https://gateway.example.com",
        trustMode: "system",
      }),
    ).toThrow(/not allowed/);
  });

  it("reads the allowlist live so a config edit applies without restart", () => {
    let origins: string[] = [];
    const service = qr(fingerprint, () => origins);
    const input = {
      pairingCode: "ABCDEF0123",
      gatewayUrl: "https://public-gateway.example.com:7600",
      trustMode: "auto" as const,
    };
    expect(JSON.parse(service.encode(input)).v).toBe(3);
    origins = ["https://public-gateway.example.com:7600"];
    expect(JSON.parse(service.encode(input)).tls).toEqual({ mode: "system" });
  });

  describe("per-phone refusals", () => {
    const tailnetIp = "https://100.101.102.103:7600";

    it("refuses an iPhone a Tailscale IP in every trust mode, even when allowlisted", () => {
      const service = qr(fingerprint, [tailnetIp], "ios");
      for (const trustMode of ["auto", "pinned-leaf", "system", undefined] as const) {
        expect(() =>
          service.encode({ pairingCode: "ABCDEF0123", gatewayUrl: tailnetIp, trustMode }),
        ).toThrow(/Tailscale IP address/);
      }
      const android = qr(fingerprint, [], "android").encode({
        pairingCode: "ABCDEF0123",
        gatewayUrl: tailnetIp,
        trustMode: "auto",
      });
      expect(JSON.parse(android).v).toBe(3);
    });

    it("gives an iPhone a trusted Tailscale name with system trust", () => {
      const name = "https://studio.tail-example.ts.net:7600";
      const encoded = qr(fingerprint, [name], "ios").encode({
        pairingCode: "ABCDEF0123",
        gatewayUrl: name,
        trustMode: "auto",
      });
      expect(JSON.parse(encoded)).toMatchObject({ v: 4, tls: { mode: "system" } });
    });

    it("trusts a publicly certified host at any port a phone reaches it on", () => {
      const service = qr(fingerprint, [], "ios", {
        publiclyTrustedHosts: ["studio.tail-example.ts.net"],
      });
      for (const port of ["7600", "17600"]) {
        const encoded = service.encode({
          pairingCode: "ABCDEF0123",
          gatewayUrl: `https://studio.tail-example.ts.net:${port}`,
          trustMode: "auto",
        });
        expect(JSON.parse(encoded)).toMatchObject({ v: 4, tls: { mode: "system" } });
      }
    });

    it("pins a local address even when an allowlist entry names it", () => {
      const local = "https://studio-northstar.local:7600";
      const encoded = qr(fingerprint, [local], "ios").encode({
        pairingCode: "ABCDEF0123",
        gatewayUrl: local,
        trustMode: "auto",
      });
      expect(JSON.parse(encoded)).toMatchObject({ v: 3, fingerprint });
    });

    it("refuses a code that is not pending", () => {
      expect(() =>
        qr(fingerprint, [], null).encode({
          pairingCode: "ABCDEF0123",
          gatewayUrl: "https://192.168.1.20:7600",
          trustMode: "auto",
        }),
      ).toThrow(/expired or was already used/);
    });
  });

  describe("pairingAddresses", () => {
    const plan = (
      kind: DeviceKind,
      origins: string[] = [],
      extra: Parameters<typeof qr>[3] = {},
      request = { requestHost: "localhost", requestPort: "7600" },
    ) =>
      qr(fingerprint, origins, kind, extra).pairingAddresses({
        pairingCode: "ABCDEF0123",
        ...request,
      });

    it("offers an iPhone only local addresses when no certificate is trusted, and says why", async () => {
      const result = await plan("ios", [], { advertisedLocalName: "omnesis.local" });
      expect(result.platform).toBe("ios");
      expect(result.recommendedUrl).toBe("https://192.168.1.20:7600");
      expect(result.addresses.filter((a) => a.usable).map((a) => a.gatewayUrl)).toEqual([
        "https://192.168.1.20:7600",
        "https://omnesis.local:7600",
      ]);
      expect(result.addresses.filter((a) => !a.usable).map((a) => a.label)).toEqual([
        "Tailscale name",
        "Tailscale IP",
      ]);
      expect(result.awayFromHome).toEqual({
        onTailnet: true,
        tailscaleName: "studio.tail-example.ts.net",
      });
    });

    it("offers the .local name the gateway advertises, never the host's own", async () => {
      const without = await plan("android");
      expect(without.addresses.some((a) => a.host.endsWith(".local"))).toBe(false);
      const withName = await plan("android", [], { advertisedLocalName: "omnesis.local" });
      expect(
        withName.addresses.filter((a) => a.host.endsWith(".local")).map((a) => [a.host, a.label]),
      ).toEqual([["omnesis.local", "Local name"]]);
    });

    it("points a refused Tailscale IP at the trusted Tailscale name once there is one", async () => {
      const untrusted = await plan("ios");
      const trusted = await plan("ios", [], {
        publiclyTrustedHosts: ["studio.tail-example.ts.net"],
      });
      const reason = (result: typeof untrusted) =>
        result.addresses.find((a) => a.label === "Tailscale IP" && !a.usable);
      expect(reason(untrusted)).toMatchObject({
        reason: expect.stringMatching(/Give the gateway a Tailscale certificate/),
      });
      expect(reason(trusted)).toMatchObject({
        reason: expect.stringContaining("covers the name studio.tail-example.ts.net"),
      });
    });

    it("warns that a pinned address stops working when the certificate renews", async () => {
      const result = await plan("android", [], {
        publiclyTrustedHosts: ["studio.tail-example.ts.net"],
        certificateRenewsAt: new Date("2026-11-24T12:00:00Z"),
      });
      const byLabel = (label: string) => result.addresses.find((a) => a.label === label);
      expect(byLabel("Tailscale name")).toMatchObject({ systemTrust: true });
      expect(JSON.stringify(byLabel("Tailscale name"))).not.toContain("renews");
      for (const label of ["Local network", "Tailscale IP"]) {
        expect(byLabel(label)).toMatchObject({
          usable: true,
          summary: expect.stringContaining(
            "around 24 November 2026, when the gateway renews its certificate",
          ),
        });
      }
    });

    it("leaves out the host's own .local name even when the caller reached the gateway by it", async () => {
      const result = await plan(
        "android",
        [],
        { advertisedLocalName: "omnesis.local" },
        { requestHost: "studio-northstar.local", requestPort: "7600" },
      );
      expect(result.addresses.map((a) => a.host)).not.toContain("studio-northstar.local");
      expect(result.addresses.map((a) => a.host)).toContain("omnesis.local");
    });

    it("never offers the loopback address the caller reached the gateway by", async () => {
      const result = await plan("android");
      expect(result.addresses.some((a) => a.host === "localhost")).toBe(false);
    });

    it("recommends the trusted Tailscale name for an iPhone once it has a certificate", async () => {
      const result = await plan("ios", [], {
        publiclyTrustedHosts: ["studio.tail-example.ts.net"],
      });
      expect(result.recommendedUrl).toBe("https://studio.tail-example.ts.net:7600");
      expect(result.addresses[0]).toMatchObject({
        label: "Tailscale name",
        usable: true,
        reach: "tailnet",
        systemTrust: true,
      });
      expect(result.awayFromHome).toBeNull();
    });

    it("recommends a tailnet address for Android and offers every address", async () => {
      const result = await plan("android");
      expect(result.recommendedUrl).toBe("https://studio.tail-example.ts.net:7600");
      expect(result.addresses.every((a) => a.usable)).toBe(true);
      expect(result.awayFromHome).toBeNull();
    });

    it("adds a trusted public origin the host did not discover, without duplicating one it did", async () => {
      const result = await plan("ios", [
        "https://omnesis.example.com",
        "https://studio.tail-example.ts.net:7600",
      ]);
      const urls = result.addresses.map((a) => a.gatewayUrl);
      expect(urls.slice(0, 2)).toEqual([
        "https://omnesis.example.com",
        "https://studio.tail-example.ts.net:7600",
      ]);
      expect(urls.filter((u) => u === "https://studio.tail-example.ts.net:7600")).toHaveLength(1);
      expect(result.addresses[0]).toMatchObject({ label: "Public address", reach: "anywhere" });
    });

    it("builds discovered addresses on the listen port and the caller's on the port it used", async () => {
      const result = await plan(
        "android",
        [],
        { identities: IDENTITIES.slice(0, 1), listenPort: 7600 },
        { requestHost: "gateway.example.com", requestPort: "17600" },
      );
      expect(result.addresses.map((a) => [a.gatewayUrl, a.label])).toEqual([
        ["https://gateway.example.com:17600", "The address you're using now"],
        ["https://192.168.1.20:7600", "Local network"],
      ]);
    });

    it("tells a host off any tailnet that it has no way to reach phones away from home", async () => {
      const result = await plan("ios", [], { identities: IDENTITIES.slice(0, 2) });
      expect(result.awayFromHome).toEqual({ onTailnet: false, tailscaleName: null });
    });

    it("tells a host on a tailnet without a Tailscale name so", async () => {
      const result = await plan("ios", [], {
        identities: [IDENTITIES[0]!, IDENTITIES[3]!],
      });
      expect(result.awayFromHome).toEqual({ onTailnet: true, tailscaleName: null });
    });

    it("has no recommendation when the phone can use none of the addresses", async () => {
      const result = await plan("ios", [], { identities: IDENTITIES.slice(3) });
      expect(result.recommendedUrl).toBeNull();
      expect(result.addresses.every((a) => !a.usable)).toBe(true);
    });

    it("omits the port for a gateway reached on the default HTTPS port", async () => {
      const result = await plan(
        "android",
        [],
        { identities: [] },
        { requestHost: "192.168.1.20", requestPort: "" },
      );
      expect(result.recommendedUrl).toBe("https://192.168.1.20");
    });
  });
});

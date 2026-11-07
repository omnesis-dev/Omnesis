// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { hostNetworkFromText, type HostNetwork, type NetworkIdentity } from "@omnesis/core";
import { PairingQrService } from "./PairingQrService.js";
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
    hostNames?: string[];
    inContainer?: boolean;
    hostNetwork?: HostNetwork | null;
    strictPinOrigins?: readonly string[];
    tlsSpkiFingerprint?: string | (() => string);
    strictPinSpkiFingerprint?: () => string | undefined;
  } = {},
): PairingQrService {
  return new PairingQrService({
    tlsFingerprint,
    strictPinOrigins: extra.strictPinOrigins,
    tlsSpkiFingerprint: extra.tlsSpkiFingerprint,
    strictPinSpkiFingerprint: extra.strictPinSpkiFingerprint,
    systemTrustOrigins,
    pairingKind: () => kind,
    discoverIdentities: async () => extra.identities ?? IDENTITIES,
    publiclyTrustedHosts: extra.publiclyTrustedHosts
      ? () => extra.publiclyTrustedHosts!
      : undefined,
    listenPort: extra.listenPort,
    advertisedLocalName: () => extra.advertisedLocalName ?? null,
    certificateRenewsAt: () => extra.certificateRenewsAt ?? null,
    hostNames: extra.hostNames ? () => extra.hostNames! : undefined,
    inContainer: extra.inContainer,
    hostNetwork: () => extra.hostNetwork ?? null,
  });
}

describe("PairingQrService", () => {
  it("relay QR pairing canonicalizes origins and preserves strict pins even on a publicly trusted hostname", () => {
    const fingerprint = "ab".repeat(32),
      gatewayUrl = "https://gateway.example.test";
    const service = qr(fingerprint, [gatewayUrl], "ios", {
      strictPinOrigins: ["https://GATEWAY.example.test:443/"],
    });
    for (const trustMode of [undefined, "auto", "pinned-leaf", "pinned-leaf-strict"] as const)
      expect(
        JSON.parse(service.encode({ gatewayUrl, pairingCode: "ABCDEF0123", trustMode })).tls,
      ).toEqual({ mode: "pinned-leaf-strict", fingerprint });
    expect(() =>
      service.encode({ gatewayUrl, pairingCode: "ABCDEF0123", trustMode: "system" }),
    ).toThrow("certificate pin");
    expect(() =>
      qr(undefined, [gatewayUrl], "ios", { strictPinOrigins: [gatewayUrl] }).encode({
        gatewayUrl,
        pairingCode: "ABCDEF0123",
      }),
    ).toThrow("fingerprint");
    expect(
      JSON.parse(
        qr(fingerprint, [gatewayUrl], "ios", {
          strictPinOrigins: ["https://different.example.test"],
        }).encode({ gatewayUrl, pairingCode: "ABCDEF0123" }),
      ).tls,
    ).toEqual({ mode: "system" });
  });
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

  it("treats an omitted trustMode as auto", () => {
    expect(
      JSON.parse(
        qr(fingerprint, ["https://gateway.example.com"]).encode({
          pairingCode: "ABCDEF0123",
          gatewayUrl: "https://gateway.example.com",
        }),
      ),
    ).toMatchObject({ v: 4, tls: { mode: "system" } });
    expect(
      JSON.parse(
        qr(fingerprint, [], "android", {
          publiclyTrustedHosts: ["studio.tail-example.ts.net"],
        }).encode({
          pairingCode: "ABCDEF0123",
          gatewayUrl: "https://studio.tail-example.ts.net:7600",
        }),
      ),
    ).toMatchObject({ v: 4, tls: { mode: "system" } });
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

    describe("a gateway in a container on a Docker bridge network", () => {
      // What the gateway sees from inside the container: its own bridge
      // address and container hostname, never the host's.
      const CONTAINER: NetworkIdentity[] = [
        { address: "172.20.0.5", label: "LAN (eth0)", kind: "lan", offLan: false },
        { address: "gateway.local", label: "mDNS (.local)", kind: "mdns", offLan: false },
      ];
      // What the Docker installer hands it in OMNESIS_TLS_EXTRA_NAMES.
      const HOST_NAMES = [
        "studio",
        "studio.local",
        "192.168.1.20",
        "100.101.102.103",
        "2001:db8::40",
      ];
      const bridged = (overrides: Parameters<typeof qr>[3] = {}) => ({
        identities: CONTAINER,
        advertisedLocalName: "omnesis.local",
        hostNames: HOST_NAMES,
        inContainer: true,
        listenPort: 7600,
        ...overrides,
      });

      it("recommends the host's LAN address to an iPhone, and refuses the container's", async () => {
        const result = await plan("ios", [], bridged());
        expect(result.recommendedUrl).toBe("https://192.168.1.20:7600");
        expect(
          result.addresses.filter((a) => a.usable).map((a) => [a.gatewayUrl, a.label]),
        ).toEqual([
          ["https://192.168.1.20:7600", "Local network"],
          ["https://studio:7600", "Host name"],
        ]);
        // The existing iPhone rule still holds for a Tailscale IP the host
        // names; the container's address and name are refused, with why.
        expect(
          result.addresses.filter((a) => !a.usable).map((a) => [a.gatewayUrl, a.label]),
        ).toEqual([
          ["https://100.101.102.103:7600", "Tailscale IP"],
          ["https://172.20.0.5:7600", "Docker container address"],
          ["https://omnesis.local:7600", "Docker container name"],
        ]);
        expect(result.addresses.find((a) => a.host === "172.20.0.5")).toMatchObject({
          usable: false,
          reason: expect.stringContaining("exists only inside Docker"),
        });
        expect(result.awayFromHome).toEqual({ onTailnet: true, tailscaleName: null });
      });

      it("recommends the host's Tailscale IP to Android, as it would natively", async () => {
        const result = await plan("android", [], bridged());
        expect(result.addresses.map((a) => a.gatewayUrl)).toEqual([
          "https://100.101.102.103:7600",
          "https://192.168.1.20:7600",
          "https://studio:7600",
          "https://172.20.0.5:7600",
          "https://omnesis.local:7600",
        ]);
        expect(result.addresses[0]).toMatchObject({ label: "Tailscale IP", reach: "tailnet" });
        expect(result.awayFromHome).toBeNull();
      });

      it("never offers the host's own .local name or an IPv6 address it was given", async () => {
        const hosts = (await plan("android", [], bridged())).addresses.map((a) => a.host);
        expect(hosts).not.toContain("studio.local");
        expect(hosts).not.toContain("2001:db8::40");
      });

      it("keeps a trusted name ahead of the host names", async () => {
        const result = await plan(
          "ios",
          [],
          bridged({
            hostNames: [...HOST_NAMES, "studio.tail-example.ts.net"],
            publiclyTrustedHosts: ["studio.tail-example.ts.net"],
          }),
        );
        expect(result.recommendedUrl).toBe("https://studio.tail-example.ts.net:7600");
        expect(result.addresses[0]).toMatchObject({ label: "Tailscale name", systemTrust: true });
      });

      it("treats addresses as the host's when it shares the host's network", async () => {
        const result = await plan(
          "ios",
          [],
          bridged({
            identities: [
              { address: "192.168.1.20", label: "LAN (eth0)", kind: "lan", offLan: false },
            ],
          }),
        );
        expect(result.addresses.map((a) => [a.gatewayUrl, a.label])).toEqual([
          ["https://192.168.1.20:7600", "Local network"],
          ["https://studio:7600", "Host name"],
          ["https://omnesis.local:7600", "Local name"],
          ["https://100.101.102.103:7600", "Tailscale IP"],
        ]);
      });

      it("keeps the container's address when it was given no host names", async () => {
        const result = await plan("ios", [], bridged({ hostNames: [] }));
        expect(result.recommendedUrl).toBe("https://172.20.0.5:7600");
        expect(result.addresses[0]).toMatchObject({ label: "Local network" });
      });

      it("offers host names outside a container without demoting what it discovers", async () => {
        const result = await plan(
          "ios",
          [],
          bridged({ inContainer: false, hostNames: ["192.168.1.20"] }),
        );
        expect(result.addresses.map((a) => [a.gatewayUrl, a.label])).toEqual([
          ["https://192.168.1.20:7600", "Local network"],
          ["https://172.20.0.5:7600", "Local network"],
          ["https://omnesis.local:7600", "Local name"],
        ]);
      });
    });

    describe("a gateway in a container whose host's launcher recorded the host's network", () => {
      // What the gateway sees from inside the container on Docker's bridge.
      const CONTAINER: NetworkIdentity[] = [
        { address: "172.20.0.5", label: "LAN (eth0)", kind: "lan", offLan: false },
        { address: "gateway.local", label: "mDNS (.local)", kind: "mdns", offLan: false },
      ];
      // What the launcher on a Mac host records: Wi-Fi, a VM bridge, a VPN
      // tunnel and the Tailscale interface, with the gateway published on 8443.
      const HOST = hostNetworkFromText(
        [
          "# written by the launcher",
          "port 8443",
          "local-name studio-northstar.local",
          "interface lo0 127.0.0.1",
          "interface en0 192.168.1.81",
          "interface bridge100 198.51.100.1",
          "interface utun2 10.1.2.3",
          "interface utun4 100.64.0.7",
        ].join("\n"),
      );
      const recorded = (overrides: Parameters<typeof qr>[3] = {}) => ({
        identities: CONTAINER,
        advertisedLocalName: "omnesis.local",
        inContainer: true,
        listenPort: 7600,
        hostNetwork: HOST,
        ...overrides,
      });

      it("offers an iPhone the host's LAN address and .local name at the published port", async () => {
        const result = await plan("ios", [], recorded());
        expect(result.recommendedUrl).toBe("https://192.168.1.81:8443");
        expect(
          result.addresses.filter((a) => a.usable).map((a) => [a.gatewayUrl, a.label]),
        ).toEqual([
          ["https://192.168.1.81:8443", "Local network"],
          ["https://studio-northstar.local:8443", "Local name"],
        ]);
        expect(result.addresses.find((a) => a.host === "192.168.1.81")).toMatchObject({
          reach: "local-network",
          summary: expect.stringContaining("same network as the gateway"),
        });
        expect(
          result.addresses.filter((a) => !a.usable).map((a) => [a.gatewayUrl, a.label]),
        ).toEqual([
          ["https://100.64.0.7:8443", "Tailscale IP"],
          ["https://172.20.0.5:8443", "Docker container address"],
          ["https://omnesis.local:8443", "Docker container name"],
        ]);
        expect(result.awayFromHome).toEqual({ onTailnet: true, tailscaleName: null });
      });

      it("never offers a container address, a VM bridge or a VPN tunnel as usable", async () => {
        for (const kind of ["ios", "android"] as const) {
          const usable = (await plan(kind, [], recorded())).addresses
            .filter((a) => a.usable)
            .map((a) => a.host);
          for (const host of ["172.20.0.5", "omnesis.local", "gateway.local", "198.51.100.1"]) {
            expect(usable).not.toContain(host);
          }
          expect(usable).not.toContain("10.1.2.3");
          expect(usable).not.toContain("127.0.0.1");
        }
      });

      it("recommends the host's Tailscale IP to Android", async () => {
        const result = await plan("android", [], recorded());
        expect(result.addresses.filter((a) => a.usable).map((a) => a.gatewayUrl)).toEqual([
          "https://100.64.0.7:8443",
          "https://192.168.1.81:8443",
          "https://studio-northstar.local:8443",
        ]);
        expect(result.awayFromHome).toBeNull();
      });

      it("recommends the host's Tailscale name to an iPhone once its certificate covers it", async () => {
        const result = await plan("ios", ["https://studio.tail-example.ts.net:8443"], recorded());
        expect(result.recommendedUrl).toBe("https://studio.tail-example.ts.net:8443");
        expect(result.addresses[0]).toMatchObject({ label: "Tailscale name", systemTrust: true });
        expect(result.addresses.find((a) => a.host === "100.64.0.7")).toMatchObject({
          usable: false,
          reason: expect.stringContaining("studio.tail-example.ts.net"),
        });
      });

      it("leaves out a host's .local name it did not record as answering mDNS", async () => {
        const result = await plan(
          "ios",
          [],
          recorded({
            hostNetwork: hostNetworkFromText("port 7600\ninterface en0 192.168.1.81"),
          }),
        );
        expect(result.addresses.filter((a) => a.usable).map((a) => a.gatewayUrl)).toEqual([
          "https://192.168.1.81:7600",
        ]);
      });

      it("offers only what the record says now, not an address the installer wrote earlier", async () => {
        const result = await plan(
          "ios",
          [],
          recorded({ hostNames: ["studio-northstar", "192.168.1.50"] }),
        );
        const hosts = result.addresses.map((a) => a.host);
        expect(hosts).not.toContain("192.168.1.50");
        expect(result.addresses.filter((a) => a.usable).map((a) => a.gatewayUrl)).toEqual([
          "https://192.168.1.81:8443",
          "https://studio-northstar.local:8443",
          "https://studio-northstar:8443",
        ]);
      });

      it("skips the address a caller inside Docker used, and keeps one from the host", async () => {
        const fromCli = await plan("ios", [], recorded(), {
          requestHost: "studio.tail-example.ts.net",
          requestPort: "7600",
        });
        expect(fromCli.addresses.map((a) => a.host)).not.toContain("studio.tail-example.ts.net");
        const fromContainer = await plan("android", [], recorded(), {
          requestHost: "gateway",
          requestPort: "8443",
        });
        expect(fromContainer.addresses.map((a) => a.host)).not.toContain("gateway");
        const fromBrowser = await plan("android", [], recorded(), {
          requestHost: "studio.example.com",
          requestPort: "8443",
        });
        expect(fromBrowser.addresses.map((a) => a.gatewayUrl)).toContain(
          "https://studio.example.com:8443",
        );
      });

      it("lists the host's identities, not the container's, for other devices", async () => {
        const identities = await qr(fingerprint, [], "android", recorded()).networkIdentities();
        expect(identities.map((i) => i.address)).toEqual([
          "192.168.1.81",
          "studio-northstar.local",
          "100.64.0.7",
        ]);
      });

      it("ignores a record outside a container: a native gateway discovers its own network", async () => {
        const result = await plan("ios", [], recorded({ inContainer: false }));
        expect(result.addresses.filter((a) => a.usable).map((a) => a.gatewayUrl)).toEqual([
          "https://172.20.0.5:7600",
          "https://omnesis.local:7600",
        ]);
      });
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

describe("stable key trust", () => {
  it("strict relay QRs bind the served SPKI at encode time", () => {
    const gatewayUrl = "https://public-gateway.example.com";
    let spki = "a".repeat(64);
    const service = qr("b".repeat(64), [gatewayUrl], "ios", {
      strictPinOrigins: [gatewayUrl],
      tlsSpkiFingerprint: () => spki,
    });
    const encode = () => JSON.parse(service.encode({ gatewayUrl, pairingCode: "ABCDEF0123" }));
    expect(encode().tls).toEqual({ mode: "pinned-key-strict", spkiFingerprint: spki });
    spki = "c".repeat(64);
    expect(encode().tls.spkiFingerprint).toBe(spki);
  });
  it("explicit key pinning requires a well formed SPKI, separate from a leaf fingerprint", () => {
    const gatewayUrl = "https://public-gateway.example.com";
    for (const spki of [undefined, "invalid"]) {
      expect(() =>
        qr("b".repeat(64), [gatewayUrl], "ios", { tlsSpkiFingerprint: spki }).encode({
          gatewayUrl,
          pairingCode: "ABCDEF0123",
          trustMode: "pinned-key-strict",
        }),
      ).toThrow("SPKI");
    }
    expect(
      JSON.parse(
        qr(undefined, [gatewayUrl], "ios", { tlsSpkiFingerprint: "a".repeat(64) }).encode({
          gatewayUrl,
          pairingCode: "ABCDEF0123",
          trustMode: "pinned-key-strict",
        }),
      ).tls,
    ).toEqual({ mode: "pinned-key-strict", spkiFingerprint: "a".repeat(64) });
  });
});

describe("duplicate and invalid route metadata", () => {
  it("offers each recorded host once when configured names and container advertisements overlap", async () => {
    const service = qr("a".repeat(64), ["https://192.168.1.20"], "android", {
      inContainer: true,
      hostNames: ["192.168.1.20"],
      identities: IDENTITIES,
      hostNetwork: hostNetworkFromText(
        "port 443\nlocal-name studio.local\ninterface en0 192.168.1.20",
      ),
      advertisedLocalName: "studio.local",
    });
    const plan = await service.pairingAddresses({
      pairingCode: "fictional",
      requestHost: "192.168.1.20",
      requestPort: "443",
    });
    const urls = plan.addresses.map((a) => a.gatewayUrl);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.filter((url) => url === "https://192.168.1.20")).toHaveLength(1);
    expect(urls.filter((url) => url === "https://studio.local")).toHaveLength(1);
    const withoutAdvertisement = qr("a".repeat(64), [], "android", {
      inContainer: true,
      hostNames: ["192.168.1.20"],
      advertisedLocalName: null,
      identities: [{ kind: "lan", address: "172.20.0.5", label: "Container", offLan: false }],
    });
    expect(
      (
        await withoutAdvertisement.pairingAddresses({
          pairingCode: "fictional",
          requestHost: "gateway",
          requestPort: "443",
        })
      ).addresses.some((a) => a.host === "192.168.1.20"),
    ).toBe(true);
  });
  it("fails closed for a malformed strict-origin configuration and an unsupported internal policy", () => {
    const gatewayUrl = "https://public-gateway.example.com";
    expect(() =>
      qr("a".repeat(64), [gatewayUrl], "ios", { strictPinOrigins: ["bad"] }).encode({
        gatewayUrl,
        pairingCode: "fictional",
      }),
    ).toThrow("absolute HTTPS origin");
    expect(() =>
      qr("a".repeat(64), [gatewayUrl], "ios").encode({
        gatewayUrl,
        pairingCode: "fictional",
        trustMode: "unsupported" as never,
      }),
    ).toThrow();
  });
});

it("deduplicates an allowlisted host repeated by configuration and the local advertiser", async () => {
  const service = qr(
    "a".repeat(64),
    ["https://studio.local", "https://gateway.example.test"],
    "android",
    {
      hostNames: ["gateway.example.test"],
      advertisedLocalName: "studio.local",
      identities: [],
      listenPort: 443,
    },
  );
  const plan = await service.pairingAddresses({
    pairingCode: "fictional",
    requestHost: "gateway.example.test",
    requestPort: "443",
  });
  expect(plan.addresses.map((a) => a.gatewayUrl).sort()).toEqual([
    "https://gateway.example.test",
    "https://studio.local",
  ]);
});

it("keeps direct and Tailscale pairings unchanged beside relay key-pinned pairings on one gateway", () => {
  const relayOrigin = "https://relay-gateway.example.test";
  const tailscaleOrigin = "https://studio.tail-example.ts.net";
  const fingerprint = "a".repeat(64);
  const spkiFingerprint = "b".repeat(64);
  const service = qr(fingerprint, [relayOrigin, tailscaleOrigin], "ios", {
    strictPinOrigins: [relayOrigin],
    tlsSpkiFingerprint: spkiFingerprint,
  });
  const encode = (gatewayUrl: string) =>
    JSON.parse(service.encode({ gatewayUrl, pairingCode: "fictional" }));
  expect(encode(relayOrigin).tls).toEqual({ mode: "pinned-key-strict", spkiFingerprint });
  expect(encode(tailscaleOrigin).tls).toEqual({ mode: "system" });
  expect(encode("https://192.168.1.20:7600")).toMatchObject({ v: 3, fingerprint });
  const directOnly = qr(fingerprint, [tailscaleOrigin], "ios", {
    tlsSpkiFingerprint: spkiFingerprint,
  });
  expect(
    JSON.parse(directOnly.encode({ gatewayUrl: tailscaleOrigin, pairingCode: "fictional" })).tls,
  ).toEqual({ mode: "system" });
  expect(
    JSON.parse(
      directOnly.encode({ gatewayUrl: "https://192.168.1.20:7600", pairingCode: "fictional" }),
    ),
  ).toMatchObject({ v: 3, fingerprint });
});

it("keeps public SNI and direct key pins separate and refuses uninitialized public trust", () => {
  const publicOrigin = "https://public-gateway.example.com";
  const directOrigin = "https://studio.tail-example.ts.net";
  let publicKey: string | undefined = "c".repeat(64);
  const service = qr("a".repeat(64), [publicOrigin, directOrigin], "ios", {
    strictPinOrigins: [publicOrigin],
    tlsSpkiFingerprint: "b".repeat(64),
    strictPinSpkiFingerprint: () => publicKey,
  });
  const encode = (gatewayUrl: string) =>
    JSON.parse(
      service.encode({ gatewayUrl, pairingCode: "fictional", trustMode: "pinned-key-strict" }),
    );
  expect(encode(publicOrigin).tls).toEqual({
    mode: "pinned-key-strict",
    spkiFingerprint: publicKey,
  });
  expect(encode(directOrigin).tls).toEqual({
    mode: "pinned-key-strict",
    spkiFingerprint: "b".repeat(64),
  });
  publicKey = undefined;
  expect(() => encode(publicOrigin)).toThrow("not ready");
  expect(encode(directOrigin).tls.spkiFingerprint).toBe("b".repeat(64));
});

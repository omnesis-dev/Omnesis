// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  judgePairingAddress,
  pairingPlatformForKind,
  pairingReachRank,
  type PairingAddressContext,
  type PairingPlatform,
} from "./pairing-address.js";

const TRUSTED = "https://studio.tail-example.ts.net:7600";

function context(platform: PairingPlatform | null, trusted: string[] = []): PairingAddressContext {
  return { platform, isSystemTrusted: (origin) => trusted.includes(origin) };
}

describe("judgePairingAddress", () => {
  test.each([
    ["https://192.168.1.20:7600", "private LAN IPv4"],
    ["https://10.1.2.3:7600", "10/8"],
    ["https://172.20.0.5:7600", "172.16/12"],
    ["https://studio-northstar.local:7600", ".local name"],
    ["https://omnesis:7600", "single-label name"],
  ])("%s (%s) works on the local network for both phones", (url) => {
    for (const platform of ["ios", "android"] as const) {
      const verdict = judgePairingAddress(url, context(platform));
      expect(verdict).toMatchObject({ usable: true, reach: "local-network", systemTrust: false });
    }
  });

  test("a Tailscale IP is refused for an iPhone and reaches the tailnet on Android", () => {
    const url = "https://100.101.102.103:7600";
    const ios = judgePairingAddress(url, context("ios"));
    expect(ios.usable).toBe(false);
    if (!ios.usable) expect(ios.reason).toMatch(/Tailscale IP address/);
    expect(judgePairingAddress(url, context("android"))).toMatchObject({
      usable: true,
      reach: "tailnet",
      systemTrust: false,
    });
  });

  test("a Tailscale IPv6 address is treated like a Tailscale IP", () => {
    const url = "https://[fd7a:115c:a1e0::aa12:3456]:7600";
    expect(judgePairingAddress(url, context("ios")).usable).toBe(false);
    expect(judgePairingAddress(url, context("android"))).toMatchObject({ reach: "tailnet" });
  });

  test("a Tailscale name needs a trusted certificate on an iPhone", () => {
    const untrusted = judgePairingAddress(TRUSTED, context("ios"));
    expect(untrusted.usable).toBe(false);
    if (!untrusted.usable) expect(untrusted.reason).toMatch(/Tailscale certificate/);

    expect(judgePairingAddress(TRUSTED, context("ios", [TRUSTED]))).toMatchObject({
      usable: true,
      reach: "tailnet",
      systemTrust: true,
    });
    expect(judgePairingAddress(TRUSTED, context("android"))).toMatchObject({
      usable: true,
      reach: "tailnet",
      systemTrust: false,
    });
  });

  test("a trust entry is not honored for a host no public certificate can cover", () => {
    for (const url of [
      "https://100.101.102.103:7600",
      "https://192.168.1.20:7600",
      "https://studio-northstar.local:7600",
      "https://localhost:7600",
    ]) {
      const verdict = judgePairingAddress(url, context("android", [url]));
      expect(verdict).toMatchObject({ usable: true, systemTrust: false });
    }
    expect(
      judgePairingAddress(
        "https://100.101.102.103:7600",
        context("ios", ["https://100.101.102.103:7600"]),
      ).usable,
    ).toBe(false);
  });

  test("the trust check is given the host as well as the origin", () => {
    const verdict = judgePairingAddress("https://Studio.Tail-Example.ts.net.:8443", {
      platform: "ios",
      isSystemTrusted: (_origin, host) => host === "studio.tail-example.ts.net",
    });
    expect(verdict).toMatchObject({ usable: true, systemTrust: true, reach: "tailnet" });
  });

  test("system trust is matched on the exact origin, port included", () => {
    const otherPort = "https://studio.tail-example.ts.net:8443";
    expect(judgePairingAddress(otherPort, context("ios", [TRUSTED])).usable).toBe(false);
  });

  test("a public name reaches anywhere when trusted and is refused on an iPhone otherwise", () => {
    const url = "https://omnesis.example.com";
    expect(judgePairingAddress(url, context("ios", ["https://omnesis.example.com"]))).toMatchObject(
      {
        usable: true,
        reach: "anywhere",
        systemTrust: true,
      },
    );
    const ios = judgePairingAddress(url, context("ios"));
    expect(ios.usable).toBe(false);
    if (!ios.usable) expect(ios.reason).toContain("omnesis.example.com");
    expect(judgePairingAddress(url, context("android"))).toMatchObject({
      usable: true,
      reach: "anywhere",
    });
  });

  test("a public IP address is refused on an iPhone", () => {
    expect(judgePairingAddress("https://203.0.113.7:7600", context("ios")).usable).toBe(false);
    expect(judgePairingAddress("https://203.0.113.7:7600", context("android")).usable).toBe(true);
  });

  test.each(["https://localhost:7600", "https://127.0.0.1:7600", "https://[::1]:7600"])(
    "%s works only for a simulator on the gateway computer",
    (url) => {
      for (const platform of ["ios", "android", null] as const) {
        expect(judgePairingAddress(url, context(platform))).toMatchObject({
          usable: true,
          reach: "this-computer",
        });
      }
    },
  );

  test("plain HTTP and malformed URLs are refused", () => {
    expect(judgePairingAddress("http://192.168.1.20:7600", context("android")).usable).toBe(false);
    expect(judgePairingAddress("not a url", context("android")).usable).toBe(false);
  });

  test("a trailing dot on a name does not change its class", () => {
    expect(
      judgePairingAddress("https://studio.tail-example.ts.net.:7600", context("ios")).usable,
    ).toBe(false);
  });

  test("a local IP address says to pair again if it changes; a local name does not", () => {
    const ip = judgePairingAddress("https://192.168.1.20:7600", context("android"));
    const name = judgePairingAddress("https://omnesis.local:7600", context("android"));
    if (!ip.usable || !name.usable) throw new Error("expected usable verdicts");
    expect(ip.summary).toMatch(/Pair again if the router gives the gateway a new address\.$/);
    expect(name.summary).not.toMatch(/new address/);
  });

  test("a pinned address gives the renewal date in one pair-again sentence; a trusted one does not", () => {
    const pinned = { ...context("android", [TRUSTED]), pinnedUntil: "24 November 2026" };
    const ip = judgePairingAddress("https://192.168.1.20:7600", pinned);
    const tailnetIp = judgePairingAddress("https://100.101.102.103:7600", pinned);
    const trusted = judgePairingAddress(TRUSTED, pinned);
    if (!ip.usable || !tailnetIp.usable || !trusted.usable) throw new Error("expected usable");
    expect(ip.summary).toMatch(
      /Pair again if the router gives the gateway a new address, and around 24 November 2026, when the gateway renews its certificate\.$/,
    );
    expect(tailnetIp.summary).toMatch(
      /Pair again around 24 November 2026, when the gateway renews/,
    );
    expect(trusted.summary).not.toMatch(/Pair again/);
  });

  test("a refused Tailscale IP names the trusted Tailscale name when there is one", () => {
    const verdict = judgePairingAddress("https://100.101.102.103:7600", {
      ...context("ios"),
      trustedTailnetName: "studio.tail-example.ts.net",
    });
    expect(verdict).toMatchObject({
      usable: false,
      reason: expect.stringContaining("covers the name studio.tail-example.ts.net"),
    });
  });

  test("summaries say where the phone works in plain words", () => {
    const local = judgePairingAddress("https://192.168.1.20:7600", context("ios"));
    const tailnet = judgePairingAddress(TRUSTED, context("ios", [TRUSTED]));
    if (!local.usable || !tailnet.usable) throw new Error("expected usable verdicts");
    expect(local.summary).toMatch(/same network as the gateway/);
    expect(tailnet.summary).toMatch(/Tailscale is connected on the phone/);
  });
});

describe("pairingReachRank", () => {
  test("orders trusted, then wider reach, then the local network, this computer, refusals", () => {
    const ctx = context("android", [TRUSTED]);
    const ranks = [
      TRUSTED,
      "https://100.101.102.103:7600",
      "https://192.168.1.20:7600",
      "https://localhost:7600",
      "http://192.168.1.20:7600",
    ].map((url) => pairingReachRank(judgePairingAddress(url, ctx)));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(5);
  });
});

describe("pairingPlatformForKind", () => {
  test("maps phone kinds and nothing else", () => {
    expect(pairingPlatformForKind("ios")).toBe("ios");
    expect(pairingPlatformForKind("android")).toBe("android");
    expect(pairingPlatformForKind("collector")).toBeNull();
  });
});

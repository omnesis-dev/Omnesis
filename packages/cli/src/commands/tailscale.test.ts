// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { describeState, gatewayOrigin, type TailscaleState } from "./tailscale.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const base: TailscaleState = {
  enabled: true,
  deviceName: "omnesis",
  joinPolicy: "ask",
  helper: { state: "running" },
  connection: "connected",
  signInUrl: null,
  url: "https://omnesis.example-net.ts.net",
  owner: { login: "maya@example.com", displayName: "Maya Reeves" },
  certificate: { source: "tailscale" },
  public: { wanted: false, state: "off" },
  node: { dnsName: "omnesis.example-net.ts.net", ips: ["100.64.0.1"] },
  joinRequests: [],
};

describe("--gateway", () => {
  test("takes a Tailscale name, an address or an https URL, as an https origin", () => {
    expect(gatewayOrigin("omnesis.example-net.ts.net")).toBe("https://omnesis.example-net.ts.net");
    expect(gatewayOrigin("https://omnesis.example-net.ts.net/")).toBe(
      "https://omnesis.example-net.ts.net",
    );
    expect(gatewayOrigin("100.64.0.1:7600")).toBe("https://100.64.0.1:7600");
  });

  test("refuses plain http, other schemes and anything beyond the address", () => {
    for (const raw of [
      "http://omnesis.example-net.ts.net",
      "ftp://omnesis.example-net.ts.net",
      "https://omnesis.example-net.ts.net/portal",
      "https://user:pass@omnesis.example-net.ts.net",
    ]) {
      expect(() => gatewayOrigin(raw), raw).toThrow(/--gateway/);
    }
  });
});

describe("the command exists only with the opt-in", () => {
  test("absent without the flag, present with it", async () => {
    vi.stubEnv("OMNESIS_TAILSCALE_EMBED_ENABLED", "");
    const off = (await import("../subcommands.js")).SUB_COMMANDS;
    expect(off).not.toHaveProperty("tailscale");
    vi.resetModules();
    vi.stubEnv("OMNESIS_TAILSCALE_EMBED_ENABLED", "1");
    const on = (await import("../subcommands.js")).SUB_COMMANDS;
    expect(on).toHaveProperty("tailscale");
    expect(Object.keys(on).filter((k) => k !== "tailscale")).toEqual(Object.keys(off));
  });
});

describe("describeState", () => {
  test("off and unavailable say what to do", () => {
    expect(describeState({ ...base, enabled: false })).toEqual([
      "Tailscale: off. Turn it on with `omnesis tailscale on`.",
    ]);
    expect(
      describeState({ ...base, helper: { state: "unavailable", reason: "Build it." } }),
    ).toEqual(["Tailscale: can't start. Build it."]);
  });

  test("connected, with the public address and a waiting request", () => {
    const lines = describeState({
      ...base,
      public: { wanted: true, state: "on", url: "https://omnesis.example-net.ts.net" },
      joinRequests: [
        {
          id: "r1",
          name: "maya-laptop",
          machine: "maya-laptop",
          login: "maya@example.com",
          requestedAt: "",
        },
      ],
    });
    expect(lines).toEqual([
      "Tailscale: connected as https://omnesis.example-net.ts.net",
      "Account: Maya Reeves (maya@example.com)",
      "Certificate: trusted",
      "Public address for cloud agents: on — https://omnesis.example-net.ts.net/mcp",
      "Your devices joining through Tailscale: ask first",
      "Waiting: maya-laptop on maya-laptop (maya@example.com) — omnesis tailscale approve r1",
    ]);
  });

  test("sign-in, approval, missing HTTPS certificates and a public address that needs allowing", () => {
    expect(
      describeState({
        ...base,
        connection: "needs-sign-in",
        signInUrl: "https://login.tailscale.com/a/x",
      }),
    ).toContain("Sign in at https://login.tailscale.com/a/x");
    expect(describeState({ ...base, connection: "needs-approval" })[0]).toMatch(
      /approve "omnesis"/,
    );
    expect(
      describeState({ ...base, certificate: { source: "gateway", reason: "https-disabled" } }),
    ).toContain(
      "Certificate: HTTPS certificates are off in your Tailscale network; the gateway uses its own certificate. Turn them on at https://login.tailscale.com/admin/dns",
    );
    expect(
      describeState({
        ...base,
        public: {
          wanted: true,
          state: "needs-enable",
          enableUrl: "https://login.tailscale.com/f/funnel",
        },
      }),
    ).toContain(
      "Public address for cloud agents: allow it in Tailscale first at https://login.tailscale.com/f/funnel",
    );
  });
});

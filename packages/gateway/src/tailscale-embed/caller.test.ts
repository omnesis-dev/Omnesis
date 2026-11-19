// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  decodeTailnetCaller,
  PUBLIC_PATHS,
  publicPathAllowed,
  recordTailnetCaller,
  tailnetCallerAddress,
  tailnetCallerOf,
  type TailnetCaller,
} from "./caller.js";
import type { IncomingMessage } from "node:http";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const owner: TailnetCaller = {
  via: "tailnet",
  client: "100.64.0.2:51000",
  peer: {
    nodeId: "nMaya",
    nodeName: "maya-laptop.example-net.ts.net",
    os: "macOS",
    userId: "7",
    login: "maya@example.com",
    userName: "Maya Reeves",
    sameOwner: true,
  },
};

describe("decodeTailnetCaller", () => {
  test("round-trips what the helper sends, non-ASCII names included", () => {
    const withAccent = { ...owner, peer: { ...owner.peer!, userName: "Maya Rëeves" } };
    expect(decodeTailnetCaller(encode(withAccent))).toEqual(withAccent);
    expect(decodeTailnetCaller(encode({ via: "public", client: "198.51.100.4:61000" }))).toEqual({
      via: "public",
      client: "198.51.100.4:61000",
    });
  });

  test("refuses anything malformed", () => {
    const bad = [
      undefined,
      "",
      "not base64!",
      encode({ via: "tailnet" }),
      encode({ via: "elsewhere", client: "x" }),
      encode({ ...owner, extra: true }),
      encode({ ...owner, peer: { ...owner.peer, sameOwner: "yes" } }),
      // A public request can never carry a tailnet device.
      encode({ ...owner, via: "public" }),
      "A".repeat(9000),
    ];
    for (const value of bad)
      expect(decodeTailnetCaller(value), String(value).slice(0, 40)).toBeNull();
  });
});

describe("caller registry", () => {
  test("only a recorded request has a caller", () => {
    const recorded = {} as IncomingMessage;
    const other = {} as IncomingMessage;
    recordTailnetCaller(recorded, owner);
    expect(tailnetCallerOf(recorded)).toBe(owner);
    expect(tailnetCallerOf(other)).toBeNull();
    expect(tailnetCallerOf(undefined)).toBeNull();
  });
});

describe("tailnetCallerAddress", () => {
  test("drops the port from IPv4 and bracketed IPv6", () => {
    expect(tailnetCallerAddress({ via: "tailnet", client: "100.64.0.2:51000" })).toBe("100.64.0.2");
    expect(tailnetCallerAddress({ via: "tailnet", client: "[fd7a:115c:a1e0::2]:443" })).toBe(
      "fd7a:115c:a1e0::2",
    );
    expect(tailnetCallerAddress({ via: "public", client: "fd7a:115c:a1e0::2" })).toBe(
      "fd7a:115c:a1e0::2",
    );
  });
});

describe("publicPathAllowed", () => {
  test("allows startup progress without exposing neighboring discovery paths", () => {
    expect(publicPathAllowed("/.well-known/omnesis-startup")).toBe(true);
    for (const path of [
      "/.well-known/omnesis-startup/",
      "/.well-known/omnesis-startup/details",
      "/.well-known/omnesis-startup-private",
      "/.well-known/private",
    ]) {
      expect(publicPathAllowed(path), path).toBe(false);
    }
  });

  test("allows exactly what agents need to connect and sign in", () => {
    for (const path of [
      "/mcp",
      "/mcp/",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/token",
      "/oauth/authorize",
      "/oauth/consent",
      "/oauth/callback",
      "/portal/css/style.css",
      "/portal/vendor/preact.js",
      "/portal/js/oauth-consent-controller.js",
    ]) {
      expect(publicPathAllowed(path), path).toBe(true);
    }
  });

  test("refuses the portal, admin, pairing and any spelling that steps outside", () => {
    for (const path of [
      "/",
      "/portal/",
      "/portal/settings/tailscale",
      "/portal/js/app.js",
      "/portal/api/session",
      "/admin/tailscale",
      "/devices/pair",
      "/tailscale/join",
      "/status",
      "/health",
      "/device/ws",
      "/MCP",
      "/mcpx",
      "/oauth/tokenx",
      "/oauth",
      "/portal/vendor/../api/session",
      "/portal/vendor/./x.js",
      "/portal//vendor/x.js",
      "/portal/vendor/x%2Fy.js",
      "/portal/css/%2e%2e/%2e%2e/admin/tailscale",
      "/portal/css/%2E%2E/api/session",
      "/m%63p",
      "/portal/vendor\\x.js",
      "mcp",
    ]) {
      expect(publicPathAllowed(path), path).toBe(false);
    }
  });

  test("every prefix entry ends at a path boundary", () => {
    for (const entry of PUBLIC_PATHS) expect(entry.startsWith("/"), entry).toBe(true);
  });
});

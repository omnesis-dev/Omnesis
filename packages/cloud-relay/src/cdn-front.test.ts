// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  acceptProxiedRequest,
  cdnFront,
  clientAddressHeader,
  forwardedClientAddress,
  parseTrustedProxies,
  watchTrustedProxies,
} from "./cdn-front.js";
import { admissionClientKey } from "./admission.js";

afterEach(() => vi.useRealTimers());

const front = {
  proxies: parseTrustedProxies("198.51.100.0/24, 2001:db8:c::/48"),
  clientAddressHeader: "cf-connecting-ip",
};

function request(peer: string, ...headers: [string, string][]) {
  return {
    socket: { remoteAddress: peer, remotePort: 40000, localAddress: "192.0.2.1", localPort: 443 },
    rawHeaders: headers.flat(),
    headers: Object.fromEntries(headers.map(([name, value]) => [name.toLowerCase(), value])),
  };
}

test("a proxy list is addresses and ranges; anything else is a configuration error", () => {
  expect(front.proxies.has("198.51.100.20")).toBe(true);
  expect(front.proxies.has("::ffff:198.51.100.20")).toBe(true);
  expect(front.proxies.has("2001:db8:c:1::5")).toBe(true);
  expect(front.proxies.has("203.0.113.1")).toBe(false);
  expect(front.proxies.has(undefined)).toBe(false);
  for (const bad of ["", "edge.example.test", "198.51.100.0/0", "198.51.100.0/24,"])
    expect(() => parseTrustedProxies(bad)).toThrow("Invalid trusted proxy list");
});

test("the header names the client only on a request from a trusted proxy", () => {
  const proxied = request("198.51.100.20", ["CF-Connecting-IP", "203.0.113.7"]);
  expect(acceptProxiedRequest(proxied, front)).toBe(true);
  expect(forwardedClientAddress(proxied)).toBe("203.0.113.7");
  expect(admissionClientKey(proxied)).toBe("203.0.113.7");

  const overSix = request("2001:db8:c::9", ["cf-connecting-ip", " 2001:db8:9:8:7::1 "]);
  expect(acceptProxiedRequest(overSix, front)).toBe(true);
  expect(admissionClientKey(overSix)).toBe("2001:db8:9:8::/64");

  // Anyone can send the header; from anyone else it is never read.
  const spoofed = request("203.0.113.50", ["cf-connecting-ip", "203.0.113.7"]);
  expect(acceptProxiedRequest(spoofed, front)).toBe(false);
  expect(forwardedClientAddress(spoofed)).toBeUndefined();
  expect(admissionClientKey(spoofed)).toBe("203.0.113.50");
  expect(forwardedClientAddress(undefined)).toBeUndefined();
});

test("a proxy's missing, repeated or malformed header names nobody", () => {
  const cases = [
    request("198.51.100.20"),
    request("198.51.100.20", ["cf-connecting-ip", "203.0.113.7"], ["CF-Connecting-IP", "x"]),
    request("198.51.100.20", ["cf-connecting-ip", "203.0.113.7, 203.0.113.8"]),
    request("198.51.100.20", ["cf-connecting-ip", "client.example.test"]),
  ];
  for (const req of cases) {
    expect(acceptProxiedRequest(req, front)).toBe(true);
    expect(forwardedClientAddress(req)).toBeUndefined();
    // The proxy's own address stands, so its clients share one bucket.
    expect(admissionClientKey(req)).toBe("198.51.100.20");
  }
  // Node joins repeated headers into one string or an array; neither is an address.
  const joined = request("198.51.100.20", ["cf-connecting-ip", "203.0.113.7"]);
  (joined.headers as Record<string, unknown>)["cf-connecting-ip"] = ["203.0.113.7"];
  expect(acceptProxiedRequest(joined, front)).toBe(true);
  expect(forwardedClientAddress(joined)).toBeUndefined();
});

test("another proxy's header name is configurable and validated", () => {
  expect(clientAddressHeader(undefined)).toBe("cf-connecting-ip");
  expect(clientAddressHeader("X-Real-IP")).toBe("x-real-ip");
  for (const bad of ["", "x real", "x:real", "a".repeat(65)])
    expect(() => clientAddressHeader(bad)).toThrow("Invalid client address header name");
  const custom = { proxies: front.proxies, clientAddressHeader: "x-real-ip" };
  const req = request(
    "198.51.100.20",
    ["cf-connecting-ip", "203.0.113.7"],
    ["X-Real-IP", "203.0.113.8"],
  );
  expect(acceptProxiedRequest(req, custom)).toBe(true);
  expect(forwardedClientAddress(req)).toBe("203.0.113.8");
});

test("a file of ranges is read again without a restart and survives a bad rewrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-cdn-front-"));
  const file = join(directory, "proxies");
  await writeFile(file, "# published ranges\n198.51.100.0/24\n\n2001:db8:c::/48 # v6\n");
  vi.useFakeTimers();
  const proxies = watchTrustedProxies(file, 1000);
  try {
    expect(proxies.has("198.51.100.1")).toBe(true);
    expect(proxies.has("2001:db8:c::1")).toBe(true);
    expect(proxies.has("203.0.113.1")).toBe(false);
    await writeFile(file, "203.0.113.0/24\n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(proxies.has("203.0.113.1")).toBe(true);
    expect(proxies.has("198.51.100.1")).toBe(false);
    // An invalid or empty rewrite, or a missing file, keeps the last good list.
    await writeFile(file, "not-an-address\n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(proxies.has("203.0.113.1")).toBe(true);
    await rm(file);
    await vi.advanceTimersByTimeAsync(1000);
    expect(proxies.has("203.0.113.1")).toBe(true);
    proxies.close!();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => watchTrustedProxies(file)).toThrow();
    await writeFile(file, "# nothing\n");
    expect(() => watchTrustedProxies(file)).toThrow("Invalid trusted proxy list");
  } finally {
    proxies.close!();
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon settings: no proxy ranges means no proxy, and nothing else may be set", async () => {
  expect(cdnFront({})).toBeUndefined();
  expect(cdnFront({ directRoutes: undefined })).toBeUndefined();
  for (const alone of [
    { clientAddressHeader: "x-real-ip" },
    { tunnelOrigin: "https://tunnel.example.test" },
    { directRoutes: "tunnel" as const },
    { directRoutes: "all" as const },
  ])
    expect(() => cdnFront(alone)).toThrow("require the trusted proxy ranges");
  expect(() =>
    cdnFront({ trustedProxies: "198.51.100.0/24", trustedProxiesFile: "/nonexistent" }),
  ).toThrow("not both");

  const listed = cdnFront({ trustedProxies: "198.51.100.0/24" })!;
  expect(listed.clientAddressHeader).toBe("cf-connecting-ip");
  expect(listed.tunnelOrigin).toBeUndefined();
  expect(listed.directRoutes).toBeUndefined();
  expect(listed.proxies.has("198.51.100.9")).toBe(true);
  expect(listed.proxies.close).toBeUndefined();

  expect(() =>
    cdnFront({ trustedProxies: "198.51.100.0/24", tunnelOrigin: "http://tunnel.example.test" }),
  ).toThrow("HTTPS");
  expect(() =>
    cdnFront({ trustedProxies: "198.51.100.0/24", clientAddressHeader: "bad name" }),
  ).toThrow("header name");

  const directory = await mkdtemp(join(tmpdir(), "omnesis-cdn-front-"));
  const file = join(directory, "proxies");
  await writeFile(file, "203.0.113.0/24\n");
  const watched = cdnFront({
    trustedProxiesFile: file,
    clientAddressHeader: "X-Real-IP",
    tunnelOrigin: "https://tunnel.example.test/",
    directRoutes: "tunnel",
  })!;
  try {
    expect(watched).toMatchObject({
      clientAddressHeader: "x-real-ip",
      tunnelOrigin: "https://tunnel.example.test",
      directRoutes: "tunnel",
    });
    expect(watched.proxies.has("203.0.113.4")).toBe(true);
  } finally {
    watched.proxies.close!();
    await rm(directory, { recursive: true, force: true });
  }
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { isLoopbackIp, isLoopbackRequest } from "./internals.js";
import type { Context } from "hono";

/** Minimal Context stub carrying a raw socket peer address + optional XFF. */
function ctxWith(peer: string | undefined, xff?: string): Context {
  return {
    env: { incoming: { socket: { remoteAddress: peer } } },
    req: { header: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? xff : undefined) },
  } as unknown as Context;
}

describe("isLoopbackIp", () => {
  test("matches IPv4 loopback (127.0.0.0/8)", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("127.1.2.3")).toBe(true);
  });

  test("matches IPv6 loopback and the localhost literal", () => {
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("localhost")).toBe(true);
  });

  test("matches IPv4-mapped IPv6 loopback", () => {
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects non-loopback addresses", () => {
    // All from reserved documentation ranges (TEST-NET-1/2/3).
    expect(isLoopbackIp("198.51.100.10")).toBe(false);
    expect(isLoopbackIp("192.0.2.1")).toBe(false);
    expect(isLoopbackIp("203.0.113.10")).toBe(false);
    expect(isLoopbackIp("::ffff:198.51.100.10")).toBe(false);
    expect(isLoopbackIp("unknown")).toBe(false);
    expect(isLoopbackIp("")).toBe(false);
  });

  test("does not treat lookalike prefixes as loopback", () => {
    expect(isLoopbackIp("128.0.0.1")).toBe(false);
    expect(isLoopbackIp("12.7.0.1")).toBe(false);
  });
});

describe("isLoopbackRequest", () => {
  test("true for a request over a loopback socket", () => {
    expect(isLoopbackRequest(ctxWith("127.0.0.1"))).toBe(true);
    expect(isLoopbackRequest(ctxWith("::1"))).toBe(true);
  });

  test("false for a remote socket — a spoofed X-Forwarded-For cannot fake loopback", () => {
    // Remote peer, but the attacker sets XFF to a loopback address. The raw
    // socket is what counts, so the request is still treated as remote.
    expect(isLoopbackRequest(ctxWith("203.0.113.10", "127.0.0.1"))).toBe(false);
  });

  test("false when the peer address is absent", () => {
    expect(isLoopbackRequest(ctxWith(undefined))).toBe(false);
  });
});

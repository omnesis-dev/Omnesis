// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import { clientAddress, forwardedClientAddress, isLoopbackClient } from "./client-ip.js";

function headers(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name.toLowerCase()];
}

function peer(address: string | undefined): unknown {
  return { incoming: { socket: { remoteAddress: address } } };
}

const previous = process.env.OMNESIS_TRUST_PROXY;
afterEach(() => {
  if (previous === undefined) delete process.env.OMNESIS_TRUST_PROXY;
  else process.env.OMNESIS_TRUST_PROXY = previous;
});

describe("without a trusted proxy", () => {
  test("forwarded headers are ignored and the socket peer is the client", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    const h = headers({ "x-forwarded-for": "203.0.113.10", "x-real-ip": "203.0.113.11" });
    expect(forwardedClientAddress(h)).toBeUndefined();
    expect(clientAddress(h, peer("198.51.100.7"))).toBe("198.51.100.7");
    expect(clientAddress(h, peer(undefined))).toBe("unknown");
  });

  test("a loopback socket is a loopback client whatever the headers say", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    expect(
      isLoopbackClient(headers({ "x-forwarded-for": "203.0.113.10" }), peer("127.0.0.1")),
    ).toBe(true);
    expect(
      isLoopbackClient(headers({ "x-forwarded-for": "127.0.0.1" }), peer("203.0.113.10")),
    ).toBe(false);
  });
});

describe("with OMNESIS_TRUST_PROXY=true", () => {
  test("the flag reads 1, true, yes and on; anything else leaves the headers ignored", () => {
    const h = headers({ "x-forwarded-for": "203.0.113.10" });
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
      process.env.OMNESIS_TRUST_PROXY = value;
      expect(forwardedClientAddress(h)).toBe("203.0.113.10");
    }
    for (const value of ["0", "false", "", "proxy"]) {
      process.env.OMNESIS_TRUST_PROXY = value;
      expect(forwardedClientAddress(h)).toBeUndefined();
    }
  });

  test("the last X-Forwarded-For entry is the client: the proxy appended it", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    const h = headers({ "x-forwarded-for": "127.0.0.1, 198.51.100.9 , 203.0.113.10" });
    expect(forwardedClientAddress(h)).toBe("203.0.113.10");
    expect(clientAddress(h, peer("127.0.0.1"))).toBe("203.0.113.10");
  });

  test("a trailing entry keeps its whitespace off, IPv6 included, and X-Forwarded-For wins over X-Real-IP", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(
      forwardedClientAddress(headers({ "x-forwarded-for": "203.0.113.10, 2001:db8::7 " })),
    ).toBe("2001:db8::7");
    expect(
      forwardedClientAddress(
        headers({ "x-forwarded-for": "203.0.113.10", "x-real-ip": "203.0.113.12" }),
      ),
    ).toBe("203.0.113.10");
  });

  test("the socket peer is read from the request itself when the runtime exposes it there", () => {
    delete process.env.OMNESIS_TRUST_PROXY;
    expect(clientAddress(headers({}), { incoming: { remoteAddress: "198.51.100.7" } })).toBe(
      "198.51.100.7",
    );
  });

  test("X-Real-IP stands in when X-Forwarded-For is absent or empty", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(forwardedClientAddress(headers({ "x-real-ip": "203.0.113.12" }))).toBe("203.0.113.12");
    expect(
      forwardedClientAddress(headers({ "x-forwarded-for": " , ", "x-real-ip": "203.0.113.12" })),
    ).toBe("203.0.113.12");
    expect(forwardedClientAddress(headers({ "x-real-ip": "  " }))).toBeUndefined();
  });

  test("a request without forwarded headers came straight from its socket peer", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(clientAddress(headers({}), peer("127.0.0.1"))).toBe("127.0.0.1");
    expect(isLoopbackClient(headers({}), peer("127.0.0.1"))).toBe(true);
  });

  test("a remote client behind a loopback proxy is not a loopback client", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(
      isLoopbackClient(headers({ "x-forwarded-for": "203.0.113.10" }), peer("127.0.0.1")),
    ).toBe(false);
    expect(isLoopbackClient(headers({ "x-real-ip": "203.0.113.10" }), peer("::1"))).toBe(false);
  });

  test("a client cannot claim loopback with its own X-Forwarded-For entry", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    const spoofed = headers({ "x-forwarded-for": "127.0.0.1, 203.0.113.10" });
    expect(isLoopbackClient(spoofed, peer("127.0.0.1"))).toBe(false);
    expect(clientAddress(spoofed, peer("127.0.0.1"))).toBe("203.0.113.10");
  });

  test("a same-host client through the proxy stays loopback", () => {
    process.env.OMNESIS_TRUST_PROXY = "true";
    expect(isLoopbackClient(headers({ "x-forwarded-for": "127.0.0.1" }), peer("127.0.0.1"))).toBe(
      true,
    );
    expect(
      isLoopbackClient(headers({ "x-forwarded-for": "127.0.0.1" }), peer("203.0.113.10")),
    ).toBe(false);
  });
});

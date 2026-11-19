// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { base64url } from "./dns-broker-contract.js";
import { BrokerTickets, brokerNetworkBucket } from "./dns-broker-tickets.js";

const SECRET = base64url(new Uint8Array(32).fill(7));
const PURPOSE = "enrollment:https://dns.example.test";
const valueSchema = z.object({ gateway: z.string() }).strict();

afterEach(() => vi.restoreAllMocks());

describe("independent DNS ticket authentication", () => {
  test("rejects an undersized or noncanonical signing secret", () => {
    expect(() => new BrokerTickets(base64url(new Uint8Array(31)))).toThrow("256-bit");
    expect(() => new BrokerTickets(`${SECRET}=`)).toThrow("base64url");
  });

  test("authenticates the payload, purpose, origin, and independent key", async () => {
    const tickets = new BrokerTickets(SECRET);
    const token = await tickets.seal(PURPOSE, { gateway: "fictional-gateway" });
    expect(await tickets.open(PURPOSE, token, valueSchema)).toEqual({
      gateway: "fictional-gateway",
    });
    for (const purpose of [
      "operation:https://dns.example.test",
      "enrollment:https://other.example.test",
    ])
      await expect(tickets.open(purpose, token, valueSchema)).rejects.toThrow("Invalid");
    const differentKey = new BrokerTickets(base64url(new Uint8Array(32).fill(8)));
    await expect(differentKey.open(PURPOSE, token, valueSchema)).rejects.toThrow("Invalid");
    const [, signature] = token.split(".");
    const substituted = base64url(new TextEncoder().encode('{"gateway":"substituted"}'));
    await expect(tickets.open(PURPOSE, `${substituted}.${signature}`, valueSchema)).rejects.toThrow(
      "Invalid",
    );
  });

  test.each([
    ["empty", ""],
    ["missing signature", "body"],
    ["missing body", ".signature"],
    ["empty signature", "body."],
    ["extra segment", "body.signature.extra"],
    ["oversized", `${"a".repeat(8190)}.AA`],
  ])("rejects malformed or oversized ticket: %s", async (_label, token) => {
    const verify = vi.spyOn(crypto.subtle, "verify");
    await expect(new BrokerTickets(SECRET).open(PURPOSE, token, z.unknown())).rejects.toThrow(
      "Invalid DNS admission ticket",
    );
    expect(verify).not.toHaveBeenCalled();
  });

  test("rejects invalid signature encoding and authenticated schema mismatches", async () => {
    const tickets = new BrokerTickets(SECRET);
    const token = await tickets.seal(PURPOSE, { gateway: "fictional-gateway" });
    const [body] = token.split(".");
    await expect(tickets.open(PURPOSE, `${body}.!`, valueSchema)).rejects.toThrow("base64url");
    const wrongShape = await tickets.seal(PURPOSE, { gateway: 7 });
    await expect(tickets.open(PURPOSE, wrongShape, valueSchema)).rejects.toBeInstanceOf(z.ZodError);
  });

  test("fingerprints are keyed and separated by the quota window without exposing the address", async () => {
    const tickets = new BrokerTickets(SECRET);
    const first = await tickets.fingerprint("network:hour:1", "192.0.2.12");
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain("192.0.2.12");
    expect(await tickets.fingerprint("network:hour:1", "192.0.2.12")).toBe(first);
    expect(await tickets.fingerprint("network:hour:2", "192.0.2.12")).not.toBe(first);
    expect(await tickets.fingerprint("network:hour:1", "192.0.2.13")).not.toBe(first);
    expect(
      await new BrokerTickets(base64url(new Uint8Array(32).fill(8))).fingerprint(
        "network:hour:1",
        "192.0.2.12",
      ),
    ).not.toBe(first);
  });
});

describe("trusted DNS client network buckets", () => {
  test.each([
    ["192.000.002.009", "192.0.2.9"],
    ["192.0.2.9", "192.0.2.9"],
    ["2001:0DB8:0001:0002:0003:0004:0005:0006", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::9", "2001:db8:1:2::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["0:0:0:0:0:0:0:1", "0:0:0:0::/64"],
    ["::ffff:192.0.2.9", "192.0.2.9"],
    ["0:0:0:0:0:ffff:c000:209", "192.0.2.9"],
  ])("normalizes %s to %s", (address, expected) => {
    expect(brokerNetworkBucket(address)).toBe(expected);
  });

  test("separates distinct IPv6 subscribers and distinct IPv4-mapped clients", () => {
    expect(brokerNetworkBucket("2001:db8:1:2::9")).not.toBe(brokerNetworkBucket("2001:db8:1:3::9"));
    expect(brokerNetworkBucket("::ffff:192.0.2.9")).not.toBe(
      brokerNetworkBucket("::ffff:192.0.2.10"),
    );
  });

  test.each(["", "not-an-address", "256.0.2.1", "192.0.2.1, 198.51.100.1", "fe80::1%lo", "[::1]"])(
    "rejects an invalid trusted address %s",
    (address) => {
      expect(() => brokerNetworkBucket(address)).toThrow("A trusted client address is required");
    },
  );

  test.each(["[1:2:3]", "[1:2:3:4:5:6:7:zz]"])(
    "fails closed if the URL platform returns an invalid IPv6 hostname %s",
    (hostname) => {
      // Dependency fault injection: a changed Worker URL implementation must not create a bucket.
      vi.spyOn(globalThis, "URL").mockImplementation(function () {
        return { hostname } as URL;
      });
      expect(() => brokerNetworkBucket("2001:db8::1")).toThrow(
        "A trusted client address is required",
      );
    },
  );
});

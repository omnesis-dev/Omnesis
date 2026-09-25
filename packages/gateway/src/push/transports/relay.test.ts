// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";

import { RelayPushClient } from "./relay.js";

describe("RelayPushClient", () => {
  test("can route delivery through a server-side origin without changing the relay credential", async () => {
    let request: { url: string; authorization: string | null } | undefined;
    const client = new RelayPushClient({
      deliveryUrl: "http://10.42.0.7:8080/push",
      fetchFn: async (input, init) => {
        const headers = new Headers(init?.headers);
        request = { url: String(input), authorization: headers.get("authorization") };
        return new Response("", { status: 202 });
      },
    });
    const result = await client.wake({
      relayUrl: "https://push.example.test",
      relayCredential: "cred_fictional",
    });
    expect(result).toEqual({ ok: true, statusCode: 202 });
    expect(request).toEqual({
      url: "http://10.42.0.7:8080/push/v1/wake",
      authorization: "Bearer cred_fictional",
    });
  });

  test.each([
    "http://relay.example.com/push",
    "http://relay-forwarder.internal/push",
    "https://user:password@relay.example.com/push",
    "https://relay.example.com/push?destination=elsewhere",
    "file:///tmp/relay",
  ])("rejects an unsafe server-side delivery URL: %s", (deliveryUrl) => {
    expect(() => new RelayPushClient({ deliveryUrl })).toThrow(/push relay delivery URL/u);
  });

  test("posts an authenticated wake with no body or content metadata", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL, _init?: RequestInit) => new Response(null, { status: 202 }),
    );
    const client = new RelayPushClient({ fetchFn });

    await expect(
      client.wake({ relayUrl: "https://push.example.test", relayCredential: "cred_fictional" }),
    ).resolves.toEqual({ ok: true, statusCode: 202 });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://push.example.test/v1/wake");
    expect(init?.method).toBe("POST");
    expect(init).not.toHaveProperty("body");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cred_fictional");
    expect(JSON.stringify(init)).not.toMatch(/title|body|kind|collapse|notification/i);
  });

  test("surfaces a bounded relay rejection", async () => {
    const client = new RelayPushClient({
      fetchFn: async () => new Response("rate limit", { status: 429 }),
    });
    await expect(
      client.wake({ relayUrl: "https://push.example.test", relayCredential: "cred_fictional" }),
    ).resolves.toEqual({ ok: false, statusCode: 429, reason: "rate limit" });
  });

  test("preserves a bounded retry-after from relay rate limiting", async () => {
    const client = new RelayPushClient({
      fetchFn: async () =>
        new Response("rate limit", { status: 429, headers: { "retry-after": "3600" } }),
    });
    await expect(
      client.wake({ relayUrl: "https://push.example.test", relayCredential: "cred_fictional" }),
    ).resolves.toEqual({
      ok: false,
      statusCode: 429,
      reason: "rate limit",
      retryAfterMs: 3_600_000,
    });
  });

  test("rejects oversized relay responses", async () => {
    const client = new RelayPushClient({
      fetchFn: async () =>
        new Response("too large", { headers: { "content-length": String(16 * 1024 + 1) } }),
    });
    await expect(
      client.wake({ relayUrl: "https://push.example.test", relayCredential: "cred_fictional" }),
    ).rejects.toThrow("maximum size");
  });
});

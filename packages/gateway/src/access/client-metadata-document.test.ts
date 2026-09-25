// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";

import {
  ClientMetadataDocumentResolver,
  type ClientMetadataDocumentDependencies,
  type MetadataResponse,
  pinnedLookup,
} from "./client-metadata-document.js";

const CLIENT_ID = "https://client.example.com/oauth/client.json";

function response(
  document: Record<string, unknown> = {},
  overrides: Partial<MetadataResponse> = {},
): MetadataResponse {
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=3600",
    body: Buffer.from(
      JSON.stringify({
        client_id: CLIENT_ID,
        client_name: "example assistant",
        redirect_uris: ["https://client.example.com/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...document,
      }),
    ),
    ...overrides,
  };
}

function dependencies(overrides: Partial<ClientMetadataDocumentDependencies> = {}) {
  let now = 1_000;
  const fetch = vi.fn(async () => response());
  const value: ClientMetadataDocumentDependencies & { advance(ms: number): void } = {
    now: () => now,
    resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
    fetch,
    advance: (ms) => {
      now += ms;
    },
    ...overrides,
  };
  return value;
}

describe("ClientMetadataDocumentResolver", () => {
  test("validates a document, pins the vetted DNS answer, and bounds positive caching", async () => {
    const deps = dependencies();
    const resolver = new ClientMetadataDocumentResolver(deps);

    await expect(resolver.resolve(CLIENT_ID)).resolves.toMatchObject({
      clientId: CLIENT_ID,
      clientName: "example assistant",
      tokenEndpointAuthMethod: "none",
    });
    expect(deps.fetch).toHaveBeenCalledWith(new URL(CLIENT_ID), {
      address: "93.184.216.34",
      family: 4,
    });
    await resolver.resolve(CLIENT_ID);
    expect(deps.fetch).toHaveBeenCalledTimes(1);

    deps.advance(5 * 60_000 + 1);
    await resolver.resolve(CLIENT_ID);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  test("preserves the client identifier's exact string identity", async () => {
    const clientId = "https://client.example.com:443/oauth/client.json";
    const deps = dependencies({
      fetch: vi.fn(async () => response({ client_id: clientId })),
    });
    await expect(new ClientMetadataDocumentResolver(deps).resolve(clientId)).resolves.toMatchObject(
      {
        clientId,
      },
    );
  });

  test("requires the client identifier URL to contain a path component", async () => {
    const deps = dependencies();
    await expect(
      new ClientMetadataDocumentResolver(deps).resolve("https://client.example.com"),
    ).rejects.toThrow(/not permitted/u);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  test.each([
    [[{ address: "127.0.0.1", family: 4 as const }]],
    [[{ address: "10.0.0.8", family: 4 as const }]],
    [[{ address: "169.254.169.254", family: 4 as const }]],
    [[{ address: "::1", family: 6 as const }]],
    [[{ address: "fe80::1", family: 6 as const }]],
    [
      [
        { address: "93.184.216.34", family: 4 as const },
        { address: "192.168.1.2", family: 4 as const },
      ],
    ],
  ])("refuses special-use or mixed DNS answers before fetching", async (addresses) => {
    const deps = dependencies({ resolve: vi.fn(async () => addresses) });
    await expect(new ClientMetadataDocumentResolver(deps).resolve(CLIENT_ID)).rejects.toThrow(
      /not publicly routable/u,
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["redirect", response({}, { status: 302 })],
    ["wrong content type", response({}, { contentType: "text/html" })],
    ["oversized", response({}, { body: Buffer.alloc(5 * 1_024 + 1) })],
    ["malformed", response({}, { body: Buffer.from("{") })],
    ["identity mismatch", response({ client_id: "https://other.example.com/client.json" })],
    ["invalid redirect", response({ redirect_uris: ["http://metadata.internal/callback"] })],
    ["invalid client URI", response({ client_uri: "https://user@client.example.com/" })],
    ["shared secret", response({ client_secret: "not-permitted" })],
    ["unsupported authentication", response({ token_endpoint_auth_method: "client_secret_basic" })],
  ])("does not accept or cache a %s response", async (_label, invalid) => {
    const deps = dependencies({ fetch: vi.fn(async () => invalid) });
    const resolver = new ClientMetadataDocumentResolver(deps);
    await expect(resolver.resolve(CLIENT_ID)).rejects.toThrow();
    await expect(resolver.resolve(CLIENT_ID)).rejects.toThrow();
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  test("honours no-store and times out a stalled fetch", async () => {
    const noStoreDeps = dependencies({
      fetch: vi.fn(async () => response({}, { cacheControl: "no-store" })),
    });
    const resolver = new ClientMetadataDocumentResolver(noStoreDeps);
    await resolver.resolve(CLIENT_ID);
    await resolver.resolve(CLIENT_ID);
    expect(noStoreDeps.fetch).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    try {
      const stalled = dependencies({ fetch: vi.fn(() => new Promise<never>(() => undefined)) });
      const pending = new ClientMetadataDocumentResolver(stalled).resolve(CLIENT_ID);
      const rejected = expect(pending).rejects.toThrow(/timed out/u);
      await vi.advanceTimersByTimeAsync(3_001);
      await rejected;

      const stalledDns = dependencies({
        resolve: vi.fn(() => new Promise<never>(() => undefined)),
      });
      const pendingDns = new ClientMetadataDocumentResolver(stalledDns).resolve(CLIENT_ID);
      const dnsRejected = expect(pendingDns).rejects.toThrow(/timed out/u);
      await vi.advanceTimersByTimeAsync(3_001);
      await dnsRejected;
      expect(stalledDns.fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    "http://client.example.com/client.json",
    "https://user@client.example.com/client.json",
    "https://client.example.com/client.json#fragment",
    "https://client.example.com/a/../client.json",
  ])("rejects an invalid client identifier URL: %s", async (clientId) => {
    const deps = dependencies();
    const result = new ClientMetadataDocumentResolver(deps).resolve(clientId);
    if (clientId.startsWith("http://")) await expect(result).resolves.toBeNull();
    else await expect(result).rejects.toThrow();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe("pinnedLookup", () => {
  const resolved = { address: "203.0.113.7", family: 4 } as const;

  test.each([true, false])(
    "connects to the pinned address with autoSelectFamily=%s",
    async (autoSelectFamily) => {
      const server = createServer((socket) => socket.end());
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const socket = createConnection({
        host: "client.example.com",
        port: (server.address() as AddressInfo).port,
        autoSelectFamily,
        lookup: pinnedLookup({ address: "127.0.0.1", family: 4 }),
      });
      try {
        await once(socket, "connect");
        expect(socket.remoteAddress).toBe("127.0.0.1");
      } finally {
        socket.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  test("answers the happy-eyeballs form with an address array", () => {
    // Node's autoSelectFamily connect path calls a custom lookup with
    // `all: true` and reads an array back. Answering positionally there makes
    // it read `undefined` as the address and throw ERR_INVALID_IP_ADDRESS.
    const callback = vi.fn();
    pinnedLookup(resolved)("client.example.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "203.0.113.7", family: 4 }]);
  });

  test("answers the single-address form positionally", () => {
    const callback = vi.fn();
    pinnedLookup(resolved)("client.example.com", { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, "203.0.113.7", 4);
  });

  test("pins every answer to the pre-validated address, ignoring the hostname", () => {
    const callback = vi.fn();
    pinnedLookup(resolved)("attacker.example.net", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "203.0.113.7", family: 4 }]);
  });
});

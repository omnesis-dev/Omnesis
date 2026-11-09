// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { GatewayUnregistered } from "./gateway-key-client.js";
import { gatewayReleaseSchema, releaseGateway } from "./gateway-release.js";

afterEach(() => vi.unstubAllGlobals());
const record = gatewayReleaseSchema.parse({
  version: 1,
  relayUrl: "https://relay.example.test",
  gatewayId: "26435b2c-768a-4ce8-ae85-72ade9c2d529",
  publicOrigin: "https://gateway.example.test",
  sessionFile: "/synthetic/session.json",
  ownerKeyFile: "/synthetic/owner.key",
  certificateFile: "/synthetic/public.pem",
  privateKeyFile: "/synthetic/public.key",
  createdAt: 1,
});
const session = { token: "owner-session", accountId: "a".repeat(64), expiresAt: 4000000000 };

test("a disconnected gateway proves its keys and asks the relay to drop it", async () => {
  const register = vi.fn(async () => session),
    transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true })),
    signal = new AbortController().signal;
  await releaseGateway(record, { register, fetch: transport, signal });
  expect(register).toHaveBeenCalledExactlyOnceWith({
    relayUrl: record.relayUrl,
    gatewayId: record.gatewayId,
    publicOrigin: record.publicOrigin,
    sessionFile: record.sessionFile,
    ownerKeyFile: record.ownerKeyFile,
    certificateFile: record.certificateFile,
    privateKeyFile: record.privateKeyFile,
    fetch: transport,
    signal,
  });
  const [url, init] = transport.mock.calls[0]!;
  expect(String(url)).toBe("https://relay.example.test/_relay/v3/account-browser/unlink");
  expect(init).toMatchObject({
    method: "POST",
    redirect: "error",
    body: "{}",
    headers: { "content-type": "application/json", authorization: "Bearer owner-session" },
  });
  // Without a transport of its own it uses the platform's.
  const platform = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", platform);
  await releaseGateway(record, { register, signal });
  expect(platform).toHaveBeenCalledOnce();
});

test("a relay that already forgot the gateway has nothing left to drop; any other failure is tried again", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
    signal = new AbortController().signal;
  await releaseGateway(record, {
    register: async () => {
      throw new GatewayUnregistered();
    },
    fetch: transport,
    signal,
  });
  expect(transport).not.toHaveBeenCalled();
  await expect(
    releaseGateway(record, {
      register: async () => {
        throw new Error("fetch failed");
      },
      fetch: transport,
      signal,
    }),
  ).rejects.toThrow("fetch failed");
  expect(transport).not.toHaveBeenCalled();
  await expect(
    releaseGateway(record, { register: async () => session, fetch: transport, signal }),
  ).rejects.toThrow("The relay did not release this gateway");
});

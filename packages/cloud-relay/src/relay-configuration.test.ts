// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { HostedNameTaken, relayPublicConfiguration } from "./relay-configuration.js";
afterEach(() => vi.unstubAllGlobals());
test("bounded public routing discovery validates exact identity and transport without credentials", async () => {
  const gatewayId = randomUUID(),
    transport = vi.fn<typeof fetch>(async () =>
      Response.json({
        protocol: 2,
        gatewayId,
        publicOrigin: "https://g.example.test",
        managedDomain: "example.test",
        invitationRequired: true,
        dnsChallenges: true,
      }),
    );
  const signal = new AbortController().signal;
  expect(
    (
      await relayPublicConfiguration(
        "https://relay.example.test",
        gatewayId.toUpperCase(),
        signal,
        transport,
      )
    ).gatewayId,
  ).toBe(gatewayId);
  const [url, options] = transport.mock.calls[0];
  expect(String(url)).toContain(`gatewayId=${gatewayId.toUpperCase()}`);
  expect(options).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  expect(options).not.toHaveProperty("headers");
  vi.stubGlobal("fetch", transport);
  await relayPublicConfiguration("https://relay.example.test", gatewayId, signal);
  for (const value of [
    { protocol: 2, gatewayId: randomUUID(), invitationRequired: true, dnsChallenges: false },
    {
      protocol: 2,
      gatewayId,
      publicOrigin: "http://public.test",
      invitationRequired: true,
      dnsChallenges: false,
    },
  ]) {
    transport.mockResolvedValueOnce(Response.json(value));
    await expect(
      relayPublicConfiguration("https://relay.test", gatewayId, signal, transport),
    ).rejects.toThrow();
  }
  transport.mockResolvedValueOnce(new Response("", { status: 409 }));
  await expect(
    relayPublicConfiguration("https://relay.test", gatewayId, signal, transport),
  ).rejects.toBeInstanceOf(HostedNameTaken);
  transport.mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(
    relayPublicConfiguration("https://relay.test", gatewayId, signal, transport),
  ).rejects.toThrow("unavailable");
  transport.mockResolvedValueOnce(
    Response.json({ protocol: 2, gatewayId, invitationRequired: false, dnsChallenges: false }),
  );
  expect(
    (await relayPublicConfiguration("https://relay.test", gatewayId, signal, transport))
      .publicOrigin,
  ).toBeUndefined();
});

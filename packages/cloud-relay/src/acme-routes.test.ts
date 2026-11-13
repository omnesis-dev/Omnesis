// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { listen, tlsFiles } from "../test/support.js";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { createCloudRelay } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions } from "./identity.js";
import { registerGatewayKey } from "./gateway-key-client.js";

test("relay DNS cooperation accepts only a raw owner and the current registered hostname, never arbitrary names or Google aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-acme-route-"));
  const accounts = new RelayAccounts(":memory:"),
    sessions = new RelaySessions(randomBytes(32));
  const create = vi.fn(async () => {}),
    remove = vi.fn(async () => {});
  const dns = await AcmeDnsChallenges.open({
    file: join(directory, "dns.json"),
    suffix: "example.test",
    provider: { create, remove },
  });
  const relay = createCloudRelay({
    accounts,
    sessions,
    acmeDns: dns,
    allowLoopbackEnrollment: true,
    hostnameProof: async () => true,
  });
  const url = await listen(relay.server),
    tls = tlsFiles(directory, "gateway.example.test");
  const owner = await registerGatewayKey({
    relayUrl: url,
    sessionFile: join(directory, "session"),
    gatewayId: randomUUID(),
    publicOrigin: "https://gateway.example.test",
    certificateFile: tls.certFile,
    privateKeyFile: tls.keyFile,
  });
  const request = (method: string, body?: unknown, token = owner.token) =>
    fetch(`${url}/_relay/v2/acme/challenge`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    expect((await fetch(`${url}/_relay/v2/acme/challenge`, { method: "POST" })).status).toBe(401);
    expect((await request("GET")).status).toBe(405);
    expect((await request("POST")).status).toBe(415);
    expect(
      (await request("POST", { value: "a".repeat(43), hostname: "victim.example.test" })).status,
    ).toBe(400);
    expect((await request("POST", { value: "x".repeat(513) })).status).toBe(413);
    expect((await request("DELETE", {})).status).toBe(400);
    const malformed = await fetch(`${url}/_relay/v2/acme/challenge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const identity = {
      issuer: "https://accounts.google.com",
      subject: "fictional-client",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const google = await sessions.issue(identity);
    accounts.linkGoogleAccount(google.accountId, owner.accountId);
    expect((await request("POST", { value: "a".repeat(43) }, google.token)).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    const response = await request("POST", { value: "a".repeat(43) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const lease = (await response.json()) as { id: string };
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "gateway.example.test", accountId: owner.accountId }),
      expect.any(AbortSignal),
    );
    expect((await request("POST", { value: "b".repeat(43) })).status).toBe(429);
    expect((await request("DELETE", { id: lease.id })).status).toBe(204);
    expect(remove).toHaveBeenCalledOnce();
  } finally {
    await relay.close();
    accounts.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("relay shutdown closes its listeners even when durable DNS cleanup must be retried later", async () => {
  const accounts = new RelayAccounts(":memory:"),
    close = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
  const relay = createCloudRelay({
    accounts,
    sessions: new RelaySessions(randomBytes(32)),
    acmeDns: { close } as unknown as AcmeDnsChallenges,
  });
  await listen(relay.server);
  await relay.close();
  accounts.close();
  expect(close).toHaveBeenCalledOnce();
  expect(relay.server.listening).toBe(false);
});

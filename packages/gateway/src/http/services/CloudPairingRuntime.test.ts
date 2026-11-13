// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { CloudPairingRuntime } from "./CloudPairingRuntime.js";
import type { CloudPairingIdentity } from "./CloudPairingConfiguration.js";

test("approval and browser state is isolated by verified owner and fixed web origin", () => {
  let identity: CloudPairingIdentity | undefined;
  let origin: string | undefined = undefined;
  let web = false;
  const webConfiguration = vi.fn((base: string | undefined) =>
    web
      ? {
          clientId: "fictional-web-client",
          clientSecret: "fictional-backend-secret",
          publicBaseUrl: base!,
        }
      : undefined,
  );
  const runtime = new CloudPairingRuntime({
    identity: () => identity,
    publicOrigin: () => origin,
    webConfiguration,
    fingerprint: () => "a".repeat(64),
    createPairing: async () => ({ pairingCode: "fictional-code", expiresAt: Date.now() + 1000 }),
  });
  expect(runtime.resolve()).toBeUndefined();
  expect(webConfiguration).not.toHaveBeenCalled();
  identity = {
    identity: {
      verify: async () => ({ issuer: "fixture", subject: "fixture", expiresAt: 4_000_000_000 }),
    },
    ownerAccountId: "a".repeat(64),
  };
  const first = runtime.resolve()!;
  expect(first.web).toBeUndefined();
  expect(runtime.resolve()).toBe(first);
  origin = "https://gateway.example.test";
  web = true;
  const browser = runtime.resolve()!;
  expect(browser).not.toBe(first);
  expect(browser.web).toBeDefined();
  expect(browser.webOrigin).toBe(origin);
  expect(runtime.resolve()).toBe(browser);
  identity = { ...identity, ownerAccountId: "b".repeat(64) };
  expect(runtime.resolve()).not.toBe(browser);
  identity = undefined;
  expect(runtime.resolve()).toBeUndefined();
});

test("an unavailable public certificate fails discovery closed and renewal retains live approval fingerprint checks", async () => {
  const { createHash } = await import("node:crypto");
  const identity = { issuer: "fixture-issuer", subject: "fixture-owner", expiresAt: 4_000_000_000 };
  let fingerprint = "";
  const runtime = new CloudPairingRuntime({
    identity: () => ({
      ownerAccountId: createHash("sha256")
        .update(JSON.stringify([identity.issuer, identity.subject]))
        .digest("hex"),
      identity: { verify: async () => identity },
    }),
    publicOrigin: () => "https://gateway.example.test",
    webConfiguration: () => undefined,
    fingerprint: () => fingerprint,
    createPairing: async () => ({ pairingCode: "fixture-code", expiresAt: Date.now() + 1000 }),
  });
  expect(runtime.resolve()).toBeUndefined();
  fingerprint = "a".repeat(64);
  const active = runtime.resolve()!;
  const requestId = "26435b2c-768a-4ce8-ae85-72ade9c2d529";
  await active.pairing.start({
    requestId,
    kind: "ios",
    name: "Fictional phone",
    secret: "b".repeat(64),
    identityToken: "fictional-token",
    challenge: active.pairing.issueChallenge().challenge,
  });
  fingerprint = "c".repeat(64);
  expect(runtime.resolve()).toBe(active);
  await expect(active.pairing.decide(requestId, true)).rejects.toThrow("certificate changed");
  fingerprint = "";
  expect(runtime.resolve()).toBeUndefined();
  fingerprint = "a".repeat(64);
  expect(runtime.resolve()).not.toBe(active);
});

test("managed browser operations are canceled on authority, audience, public-origin and certificate-readiness changes", async () => {
  const { randomUUID } = await import("node:crypto");
  const base: CloudPairingIdentity = {
    ownerAccountId: "a".repeat(64),
    configurationKey: "first",
    identity: {
      verify: async () => ({ issuer: "fixture", subject: "owner", expiresAt: 4_000_000_000 }),
    },
  };
  let current: CloudPairingIdentity | undefined = base,
    origin = "https://cloud.example.test",
    fingerprint = "a".repeat(64),
    client: string | undefined = "managed-client";
  let release!: () => void;
  const broker: import("@omnesis/cloud-relay").GoogleBrowserPort = {
    clientId: () => client,
    deviceIdentity: () => undefined,
    callbackUrl: async (value) => `${value}/devices/google/callback`,
    begin: vi.fn(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ...input,
        operationId: randomUUID(),
        authorizeUrl: "https://relay.example.test",
        clientId: "managed-client",
        issuedAt: 1,
        expiresAt: 4_000_000_000,
        redemptionSecret: "backend-only",
      };
    }),
    redeem: async () => {
      throw new Error("Unused redemption");
    },
  };
  const runtime = new CloudPairingRuntime({
    identity: () => current,
    broker: () => broker,
    publicOrigin: () => origin,
    webConfiguration: () => undefined,
    fingerprint: () => fingerprint,
    createPairing: async () => ({ pairingCode: "code", expiresAt: Date.now() + 60_000 }),
  });
  const initial = runtime.resolve()!;
  expect(initial.web).toBeDefined();
  expect(initial.webOrigin).toBeUndefined();
  expect(runtime.resolve()).toBe(initial);
  const mutations = [
    () => {
      current = { ...base, configurationKey: "second" };
    },
    () => {
      origin = "https://second.example.test";
    },
    () => {
      fingerprint = "";
    },
    () => {
      current = undefined;
    },
    () => {
      client = undefined;
    },
  ];
  for (const mutate of mutations) {
    current = base;
    origin = "https://cloud.example.test";
    fingerprint = "a".repeat(64);
    client = "managed-client";
    const active = runtime.resolve()!;
    const starting = active.web!.begin(
      { requestId: randomUUID(), name: "Fictional browser", secret: "a".repeat(64) },
      "https://direct.example.test",
    );
    await Promise.resolve();
    await Promise.resolve();
    mutate();
    const changed = runtime.resolve();
    expect(changed).not.toBe(active);
    release();
    await expect(starting).rejects.toThrow();
  }
});

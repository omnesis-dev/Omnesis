// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { brokerCall, brokerHarness, ownerFrom } from "../test/dns-broker-owner.js";
import {
  DnsBrokerNameTaken,
  brokerOrRelayPresenter,
  dnsBrokerClient,
  dnsBrokerSelection,
} from "./dns-broker-client.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import type { AcmeDnsPresenter } from "./acme-client.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-dns-broker-client-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const signal = () => AbortSignal.timeout(10_000);
const VALUE = "a".repeat(43);

async function gateway(options: Parameters<typeof brokerHarness>[0] = {}) {
  const harness = await brokerHarness(options);
  const keys = generateKeyPairSync("ed25519");
  const gatewayId = randomUUID();
  const client = dnsBrokerClient({
    brokerUrl: harness.origin,
    relayUrl: "https://relay.example.test",
    gatewayId: gatewayId.toUpperCase(),
    owner: async () => keys.privateKey,
    fetch: harness.fetch,
  });
  const owner = ownerFrom(keys.privateKey, keys.publicKey, "relay.example.test", gatewayId);
  return { ...harness, client, owner, gatewayId };
}

test("only local configuration selects a broker: the official relay's compiled one, or the operator's", () => {
  expect(dnsBrokerSelection({}, "https://relay.omnesis.app")).toEqual({
    url: "https://dns.omnesis.app",
    required: false,
  });
  expect(
    dnsBrokerSelection({ OMNESIS_ACME_DNS_PROVIDER: "auto" }, "https://relay.omnesis.app:443/"),
  ).toEqual({ url: "https://dns.omnesis.app", required: false });
  expect(dnsBrokerSelection({}, "https://relay.example.test")).toBeUndefined();
  for (const provider of ["relay", "cloudflare", "independent"])
    expect(
      dnsBrokerSelection({ OMNESIS_ACME_DNS_PROVIDER: provider }, "https://relay.omnesis.app"),
    ).toBeUndefined();
  expect(
    dnsBrokerSelection(
      {
        OMNESIS_ACME_DNS_PROVIDER: "broker",
        OMNESIS_ACME_DNS_BROKER_URL: "https://dns.example.test/",
      },
      "https://relay.example.test",
    ),
  ).toEqual({ url: "https://dns.example.test", required: true });
  expect(() =>
    dnsBrokerSelection({ OMNESIS_ACME_DNS_PROVIDER: "broker" }, "https://relay.example.test"),
  ).toThrow("requires a broker URL");
});

test("a gateway claims its hosted name and leases, publishes and releases through the broker", async () => {
  const g = await gateway();
  expect(g.client.hostname).toBe(hostedGatewayHostname(g.gatewayId, "relay.example.test"));
  expect(await g.client.health(signal())).toMatchObject({ relayDomain: "relay.example.test" });
  await g.client.claim(signal());
  await g.client.claim(signal());
  const presenter = g.client.presenter();
  const lease = await presenter.create(VALUE, signal());
  expect(g.cloudflare.records.filter((record) => record.type === "TXT")).toHaveLength(1);
  await presenter.remove(lease.id, signal());
  expect(g.cloudflare.records.filter((record) => record.type === "TXT")).toHaveLength(0);
  await g.client.publishCaa("https://acme-v02.api.letsencrypt.org/acme/acct/42", signal());
  expect(g.cloudflare.records.filter((record) => record.type === "CAA")).toHaveLength(1);
  await g.client.release(signal());
  expect(g.cloudflare.records.filter((record) => record.name === g.client.hostname)).toEqual([]);
  // The health answer is kept for a while.
  await g.client.health(signal());
  expect(g.calls.filter((path) => path === "/_dns/v2/health")).toHaveLength(1);
});

test("a name another key holds is reported as taken, and other refusals as failures", async () => {
  const g = await gateway();
  const keys = generateKeyPairSync("ed25519");
  const squatter = ownerFrom(keys.privateKey, keys.publicKey, "relay.example.test", g.gatewayId);
  await brokerCall((request) => g.broker.handle(request), squatter, { type: "claim" });
  await expect(g.client.claim(signal())).rejects.toBeInstanceOf(DnsBrokerNameTaken);
  await expect(g.client.presenter().create(VALUE, signal())).rejects.toThrow(
    "refused the gateway operation",
  );
});

test("a challenge for another broker, another request or out of time is never signed", async () => {
  const g = await gateway();
  const tampered = (change: Record<string, unknown>) =>
    dnsBrokerClient({
      brokerUrl: g.origin,
      relayUrl: "https://relay.example.test",
      gatewayId: g.gatewayId,
      owner: async () => g.owner.privateKey,
      fetch: async (input, init) => {
        const response = await g.fetch(input, init);
        if (!String(input).endsWith("/challenge")) return response;
        return Response.json({ ...(await response.json()), ...change });
      },
    });
  for (const change of [
    { brokerOrigin: "https://elsewhere.example.test" },
    { requestDigest: "0".repeat(64) },
    { expiresAt: Date.now() + 3_600_000 },
  ])
    await expect(tampered(change).claim(signal())).rejects.toThrow("does not match");
  expect(g.calls.filter((path) => path === "/_dns/v2/complete")).toEqual([]);
});

test("a broker that is unreachable, failing or for another relay domain is not used", async () => {
  const g = await gateway({ relayDomain: "relay.other.test" });
  expect(await g.client.health(signal())).toBeUndefined();
  const unreachable = dnsBrokerClient({
    brokerUrl: "https://dns.unreachable.test",
    relayUrl: "https://relay.example.test",
    gatewayId: randomUUID(),
    owner: async () => g.owner.privateKey,
    fetch: g.fetch,
  });
  expect(await unreachable.health(signal())).toBeUndefined();
  const failing = dnsBrokerClient({
    brokerUrl: g.origin,
    relayUrl: "https://relay.example.test",
    gatewayId: randomUUID(),
    owner: async () => g.owner.privateKey,
    fetch: async () => new Response("<html>", { status: 404 }),
  });
  expect(await failing.health(signal())).toBeUndefined();
  const aborted = new AbortController();
  aborted.abort();
  await expect(unreachable.health(aborted.signal)).rejects.toThrow();
});

function relayPresenter(): AcmeDnsPresenter & { leases: string[] } {
  const leases: string[] = [];
  return {
    leases,
    create: vi.fn(async (value: string) => {
      leases.push(value);
      return { id: randomUUID() };
    }),
    remove: vi.fn(async () => {}),
  };
}

test("until the broker serves the gateway, DNS-01 goes through the relay as before", async () => {
  const relay = relayPresenter();
  const unreachable = dnsBrokerClient({
    brokerUrl: "https://dns.omnesis.app",
    relayUrl: "https://relay.omnesis.app",
    gatewayId: randomUUID(),
    owner: async () => generateKeyPairSync("ed25519").privateKey,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const markerFile = join(directory, "broker.json");
  const presenter = brokerOrRelayPresenter({
    broker: unreachable,
    required: false,
    relay,
    markerFile,
  });
  const lease = await presenter.create(VALUE, signal());
  await presenter.remove(lease.id, signal());
  expect(relay.leases).toEqual([VALUE]);
  expect(relay.remove).toHaveBeenCalledWith(lease.id, expect.anything());
  expect(existsSync(markerFile)).toBe(false);
  // Required by the operator, or with no relay to fall back to: no issuance.
  for (const options of [
    { required: true, relay },
    { required: false, relay: undefined },
  ])
    await expect(
      brokerOrRelayPresenter({ broker: unreachable, markerFile, ...options }).create(
        VALUE,
        signal(),
      ),
    ).rejects.toThrow("broker is unavailable");
});

test("once a gateway has used the broker it never goes back to the relay", async () => {
  const g = await gateway();
  const relay = relayPresenter();
  const markerFile = join(directory, "broker.json");
  const presenter = brokerOrRelayPresenter({
    broker: g.client,
    required: false,
    relay,
    markerFile,
  });
  const lease = await presenter.create(VALUE, signal());
  expect(existsSync(markerFile)).toBe(true);
  expect(g.cloudflare.records.filter((record) => record.type === "TXT")).toHaveLength(1);
  await presenter.remove(lease.id, signal());
  expect(g.cloudflare.records.filter((record) => record.type === "TXT")).toHaveLength(0);
  // Later renewals keep using it.
  await presenter.remove((await presenter.create(VALUE, signal())).id, signal());
  // A lease the presenter didn't create is the broker's to remove.
  await presenter.remove(randomUUID(), signal());
  expect(relay.create).not.toHaveBeenCalled();
  expect(relay.remove).not.toHaveBeenCalled();
  // The broker goes away: renewal fails rather than handing the challenge to the relay.
  const later = brokerOrRelayPresenter({
    broker: dnsBrokerClient({
      brokerUrl: g.origin,
      relayUrl: "https://relay.example.test",
      gatewayId: g.gatewayId,
      owner: async () => g.owner.privateKey,
      fetch: async () => new Response(null, { status: 503 }),
    }),
    required: false,
    relay,
    markerFile,
  });
  await expect(later.create(VALUE, signal())).rejects.toThrow("broker is unavailable");
  expect(relay.create).not.toHaveBeenCalled();
});

test("the platform fetch is used when none is given", async () => {
  const g = await gateway();
  vi.stubGlobal("fetch", g.fetch);
  try {
    const client = dnsBrokerClient({
      brokerUrl: g.origin,
      relayUrl: "https://relay.example.test",
      gatewayId: g.gatewayId,
      owner: async () => g.owner.privateKey,
    });
    expect(await client.health(signal())).toBeDefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

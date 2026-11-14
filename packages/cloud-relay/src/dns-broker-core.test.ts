// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import {
  brokerCall,
  brokerOwner,
  memoryStore,
  type BrokerOwner,
} from "../test/dns-broker-owner.js";
import { fakeCloudflare } from "../test/fake-cloudflare.js";
import { BrokerError, DnsBroker, type DnsBrokerOptions } from "./dns-broker-core.js";
import { cloudflareBrokerZone, type BrokerZone } from "./dns-broker-zone.js";
import type { BrokerChallenge, BrokerOperation } from "./dns-broker-contract.js";

const ORIGIN = "https://dns.example.test";
const ACCOUNT = "https://acme-v02.api.letsencrypt.org/acme/acct/123456";
const VALUE = "a".repeat(43);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(options: Partial<DnsBrokerOptions> = {}) {
  const cloudflare = fakeCloudflare();
  cloudflare.add({ type: "A", name: "*.relay.example.test", content: "192.0.2.10" });
  cloudflare.add({ type: "AAAA", name: "*.relay.example.test", content: "2001:db8::10" });
  const store = memoryStore();
  const zone = cloudflareBrokerZone({
    zoneId: cloudflare.zoneId,
    zoneName: "example.test",
    relayDomain: "relay.example.test",
    token: cloudflare.token,
    fetch: cloudflare.fetch,
  });
  const broker = new DnsBroker({
    origin: ORIGIN,
    relayDomain: "relay.example.test",
    store,
    zone,
    ...options,
  });
  const call = (owner: BrokerOwner, operation: BrokerOperation) =>
    brokerCall((request) => broker.handle(request), owner, operation);
  return { broker, store, cloudflare, call };
}

const post = (broker: DnsBroker, path: string, body: unknown, headers: HeadersInit = {}) =>
  broker.handle(
    new Request(new URL(path, ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

test("a gateway claims its name, leases its challenge record and removes it", async () => {
  const { call, cloudflare, store } = setup();
  const owner = brokerOwner();
  expect(await call(owner, { type: "claim" })).toEqual({ status: 200, body: { claimed: true } });
  // A second claim by the same key is a no-op.
  expect(await call(owner, { type: "claim" })).toEqual({ status: 200, body: { claimed: true } });
  expect(store.values.get("meta:names")).toBe(1);
  const lease = await call(owner, { type: "txt-create", value: VALUE });
  expect(lease.status).toBe(200);
  const { id } = lease.body as { id: string };
  expect(
    cloudflare.records.filter((record) => record.name === `_acme-challenge.${owner.hostname}`),
  ).toMatchObject([{ type: "TXT", content: VALUE }]);
  expect(await call(owner, { type: "txt-remove", leaseId: id })).toEqual({
    status: 200,
    body: { removed: true },
  });
  expect(cloudflare.records.filter((record) => record.type === "TXT")).toEqual([]);
  expect([...store.values.keys()].filter((key) => key.startsWith("lease:"))).toEqual([]);
  // Removing a lease that is already gone is not an error.
  expect((await call(owner, { type: "txt-remove", leaseId: id })).status).toBe(200);
});

test("F3: the broker refuses a challenge lease for a name bound to a different owner key", async () => {
  const { call, cloudflare } = setup();
  const gateway = brokerOwner();
  expect((await call(gateway, { type: "claim" })).status).toBe(200);
  // A relay that learned the gateway's id and name, with a key of its own.
  const relay = brokerOwner("relay.example.test", gateway.gatewayId);
  cloudflare.writes.length = 0;
  for (const operation of [
    { type: "txt-create", value: VALUE },
    { type: "caa", accountUri: "https://acme-v02.api.letsencrypt.org/acme/acct/666" },
    { type: "release" },
  ] as const)
    expect(await call(relay, operation)).toEqual({
      status: 403,
      body: { error: "name-owned-by-another-key" },
    });
  expect(await call(relay, { type: "claim" })).toEqual({
    status: 409,
    body: { error: "name-taken" },
  });
  expect(cloudflare.writes).toEqual([]);
});

test("F3: a relay that knows a gateway's id cannot take a name the gateway already claimed", async () => {
  const { call } = setup();
  const gateway = brokerOwner();
  await call(gateway, { type: "claim" });
  const relay = brokerOwner("relay.example.test", gateway.gatewayId);
  expect((await call(relay, { type: "claim" })).status).toBe(409);
  // The rightful gateway keeps working.
  expect((await call(gateway, { type: "txt-create", value: VALUE })).status).toBe(200);
});

test("only a gateway's own derived name is brokered", async () => {
  const { broker } = setup();
  const owner = brokerOwner();
  const other = brokerOwner();
  const response = await post(broker, "/_dns/v2/challenge", {
    ...owner.request({ type: "claim" }),
    hostname: other.hostname,
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "name-not-derived" });
  const outside = brokerOwner("elsewhere.example.test");
  expect(
    (await post(broker, "/_dns/v2/challenge", outside.request({ type: "claim" }))).status,
  ).toBe(403);
});

test("a completion is one use, bound to its challenge and its owner key", async () => {
  const { broker, call } = setup();
  const owner = brokerOwner();
  await call(owner, { type: "claim" });
  const challenge = (await (
    await post(broker, "/_dns/v2/challenge", owner.request({ type: "txt-create", value: VALUE }))
  ).json()) as BrokerChallenge;
  const completion = { challengeId: challenge.challengeId, ownerSignature: owner.sign(challenge) };
  expect((await post(broker, "/_dns/v2/complete", completion)).status).toBe(200);
  // Replayed.
  expect(await (await post(broker, "/_dns/v2/complete", completion)).json()).toEqual({
    error: "challenge-unknown",
  });
  // A signature over another challenge, or by another key, is refused and spends the challenge.
  const second = (await (
    await post(broker, "/_dns/v2/challenge", owner.request({ type: "release" }))
  ).json()) as BrokerChallenge;
  const stranger = brokerOwner();
  const refused = await post(broker, "/_dns/v2/complete", {
    challengeId: second.challengeId,
    ownerSignature: stranger.sign(second),
  });
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({ error: "signature-refused" });
  expect(
    (
      await post(broker, "/_dns/v2/complete", {
        challengeId: second.challengeId,
        ownerSignature: owner.sign(second),
      })
    ).status,
  ).toBe(401);
});

test("an expired challenge is refused", async () => {
  let now = 1_800_000_000_000;
  const { broker } = setup({ now: () => now });
  const owner = brokerOwner();
  const challenge = (await (
    await post(broker, "/_dns/v2/challenge", owner.request({ type: "claim" }))
  ).json()) as BrokerChallenge;
  now += 60_000;
  const response = await post(broker, "/_dns/v2/complete", {
    challengeId: challenge.challengeId,
    ownerSignature: owner.sign(challenge),
  });
  expect(response.status).toBe(401);
});

test("pending challenges are capped and expired or unreadable ones pruned", async () => {
  let now = 1_800_000_000_000;
  const { broker, store } = setup({ now: () => now, maxChallenges: 2 });
  const owner = brokerOwner();
  store.values.set("challenge:corrupt", { nonsense: true });
  for (let count = 0; count < 2; count++)
    expect(
      (await post(broker, "/_dns/v2/challenge", owner.request({ type: "claim" }))).status,
    ).toBe(200);
  expect(store.values.has("challenge:corrupt")).toBe(false);
  const full = await post(broker, "/_dns/v2/challenge", owner.request({ type: "claim" }));
  expect(full.status).toBe(429);
  now += 60_001;
  expect((await post(broker, "/_dns/v2/challenge", owner.request({ type: "claim" }))).status).toBe(
    200,
  );
});

test("a name must be claimed before anything else", async () => {
  const { call } = setup();
  expect(await call(brokerOwner(), { type: "txt-create", value: VALUE })).toEqual({
    status: 404,
    body: { error: "name-not-claimed" },
  });
});

test("CAA binds the name to one ACME account and the relay's own addresses", async () => {
  const { call, cloudflare, store } = setup();
  const owner = brokerOwner();
  await call(owner, { type: "claim" });
  expect(await call(owner, { type: "caa", accountUri: ACCOUNT })).toEqual({
    status: 200,
    body: { caa: true },
  });
  expect(cloudflare.records.filter((record) => record.name === owner.hostname)).toMatchObject([
    { type: "A", content: "192.0.2.10", proxied: false },
    { type: "AAAA", content: "2001:db8::10", proxied: false },
    {
      type: "CAA",
      data: {
        flags: 0,
        tag: "issue",
        value: `letsencrypt.org; validationmethods=dns-01; accounturi=${ACCOUNT}`,
      },
    },
  ]);
  expect(store.values.get(`name:${owner.hostname}`)).toMatchObject({ accountUri: ACCOUNT });
  // A rotated account replaces the record; the old account can no longer issue.
  const rotated = "https://acme-v02.api.letsencrypt.org/acme/acct/987654";
  await call(owner, { type: "caa", accountUri: rotated });
  expect(
    cloudflare.records
      .filter((record) => record.type === "CAA")
      .map((record) => record.data?.value),
  ).toEqual([`letsencrypt.org; validationmethods=dns-01; accounturi=${rotated}`]);
});

test("CAA names only accounts of the configured CA, with no room for other parameters", async () => {
  const { call, broker, cloudflare } = setup();
  const owner = brokerOwner();
  await call(owner, { type: "claim" });
  cloudflare.writes.length = 0;
  for (const accountUri of [
    "https://acme-staging-v02.api.letsencrypt.org/acme/acct/1",
    "https://acme-v02.api.letsencrypt.org/acme/acct/",
  ])
    expect(await call(owner, { type: "caa", accountUri })).toEqual({
      status: 400,
      body: { error: "account-not-accepted" },
    });
  const injected = await post(
    broker,
    "/_dns/v2/challenge",
    owner.request({ type: "caa", accountUri: `${ACCOUNT}; validationmethods=http-01` }),
  );
  expect(injected.status).toBe(400);
  expect(cloudflare.writes).toEqual([]);
  expect(broker.health()).toEqual({
    protocol: "omnesis-dns-broker-v2",
    relayDomain: "relay.example.test",
    caa: {
      issuer: "letsencrypt.org",
      accountUriPrefix: "https://acme-v02.api.letsencrypt.org/acme/acct/",
    },
  });
});

test("a failed CAA publication leaves the registry as it was", async () => {
  const { call, cloudflare, store } = setup();
  const owner = brokerOwner();
  await call(owner, { type: "claim" });
  cloudflare.fail.add("create:CAA");
  expect(await call(owner, { type: "caa", accountUri: ACCOUNT })).toEqual({
    status: 502,
    body: { error: "dns-publication-failed" },
  });
  expect(store.values.get(`name:${owner.hostname}`)).not.toHaveProperty("accountUri");
});

test("release removes the name's records, keeps it bound, and a claim by its owner restores it", async () => {
  const { call, cloudflare, store } = setup();
  const owner = brokerOwner();
  await call(owner, { type: "claim" });
  await call(owner, { type: "caa", accountUri: ACCOUNT });
  await call(owner, { type: "txt-create", value: VALUE });
  expect(await call(owner, { type: "release" })).toEqual({
    status: 200,
    body: { released: true },
  });
  expect(cloudflare.records.filter((record) => record.name.endsWith(owner.hostname))).toEqual([]);
  expect(store.values.get(`name:${owner.hostname}`)).toMatchObject({ released: true });
  expect(store.values.get(`name:${owner.hostname}`)).not.toHaveProperty("accountUri");
  for (const operation of [
    { type: "txt-create", value: VALUE },
    { type: "caa", accountUri: ACCOUNT },
  ] as const)
    expect(await call(owner, operation)).toEqual({ status: 409, body: { error: "name-released" } });
  // Released is not free: another key still can't have it.
  expect(
    (await call(brokerOwner("relay.example.test", owner.gatewayId), { type: "claim" })).status,
  ).toBe(409);
  expect((await call(owner, { type: "claim" })).status).toBe(200);
  expect(store.values.get(`name:${owner.hostname}`)).not.toHaveProperty("released");
  expect((await call(owner, { type: "txt-create", value: VALUE })).status).toBe(200);
  cloudflare.fail.add("delete");
  expect(await call(owner, { type: "release" })).toEqual({
    status: 502,
    body: { error: "dns-removal-failed" },
  });
});

test("leases are one per name and capped overall", async () => {
  const { call } = setup({ maxLeases: 1 });
  const first = brokerOwner(),
    second = brokerOwner();
  await call(first, { type: "claim" });
  await call(second, { type: "claim" });
  expect((await call(first, { type: "txt-create", value: VALUE })).status).toBe(200);
  expect(await call(first, { type: "txt-create", value: VALUE })).toEqual({
    status: 429,
    body: { error: "lease-capacity" },
  });
  expect((await call(second, { type: "txt-create", value: VALUE })).status).toBe(429);
});

test("a lease belongs to its name", async () => {
  const { call } = setup();
  const first = brokerOwner(),
    second = brokerOwner();
  await call(first, { type: "claim" });
  await call(second, { type: "claim" });
  const { id } = (await call(first, { type: "txt-create", value: VALUE })).body as { id: string };
  expect(await call(second, { type: "txt-remove", leaseId: id })).toEqual({
    status: 403,
    body: { error: "lease-of-another-name" },
  });
});

test("the lease journal outlives failed publications and removals until expiry", async () => {
  let now = 1_800_000_000_000;
  const { call, cloudflare, store, broker } = setup({ now: () => now });
  const owner = brokerOwner();
  await call(owner, { type: "claim" });
  // Publication fails and its cleanup succeeds: nothing is left.
  cloudflare.fail.add("create:TXT");
  expect(await call(owner, { type: "txt-create", value: VALUE })).toEqual({
    status: 502,
    body: { error: "dns-publication-failed" },
  });
  expect([...store.values.keys()].filter((key) => key.startsWith("lease:"))).toEqual([]);
  // Publication and cleanup both fail: the intent stays journaled.
  cloudflare.fail.add("list");
  await call(owner, { type: "txt-create", value: VALUE });
  expect([...store.values.keys()].filter((key) => key.startsWith("lease:"))).toHaveLength(1);
  cloudflare.fail.clear();
  expect(await broker.expire()).toBe(now + 600_000);
  // A removal that fails is reported, and the lease is kept for expiry.
  const [key] = [...store.values.keys()].filter((name) => name.startsWith("lease:"));
  cloudflare.fail.add("list");
  expect(await call(owner, { type: "txt-remove", leaseId: key!.slice("lease:".length) })).toEqual({
    status: 502,
    body: { error: "dns-removal-failed" },
  });
  now += 600_000;
  // Expired, and its removal still fails: retried in a minute, and it still holds the name.
  expect(await broker.expire()).toBe(now + 60_000);
  expect((await call(owner, { type: "txt-create", value: VALUE })).status).toBe(429);
  cloudflare.fail.clear();
  expect(await broker.expire()).toBeUndefined();
  expect([...store.values.keys()].filter((name) => name.startsWith("lease:"))).toEqual([]);
});

test("expiry removes stale challenges and leases", async () => {
  let now = 1_800_000_000_000;
  const { call, broker, store, cloudflare } = setup({ now: () => now });
  const owner = brokerOwner();
  await call(owner, { type: "claim" });
  await call(owner, { type: "txt-create", value: VALUE });
  await post(broker, "/_dns/v2/challenge", owner.request({ type: "release" }));
  store.values.set("challenge:corrupt", 1);
  now += 600_001;
  expect(await broker.expire()).toBeUndefined();
  expect([...store.values.keys()].sort()).toEqual(["meta:names", `name:${owner.hostname}`]);
  expect(cloudflare.records.filter((record) => record.type === "TXT")).toEqual([]);
});

test("routes answer with fixed codes and never echo their input", async () => {
  const { broker, store } = setup();
  const get = (path: string) => broker.handle(new Request(new URL(path, ORIGIN)));
  expect(await (await get("/_dns/v2/health")).json()).toMatchObject({
    protocol: "omnesis-dns-broker-v2",
  });
  expect((await post(broker, "/_dns/v2/health", {})).status).toBe(405);
  expect((await get("/_dns/v2/challenge")).status).toBe(405);
  expect((await get("/elsewhere")).status).toBe(404);
  // No import route without an import token.
  expect((await post(broker, "/_dns/v2/import", { entries: [] })).status).toBe(404);
  const plain = await broker.handle(
    new Request(new URL("/_dns/v2/challenge", ORIGIN), { method: "POST", body: "{}" }),
  );
  expect(plain.status).toBe(415);
  expect((await post(broker, "/_dns/v2/challenge", "x".repeat(20_000))).status).toBe(413);
  expect(await (await post(broker, "/_dns/v2/challenge", "{not json")).json()).toEqual({
    error: "invalid-json",
  });
  const empty = await broker.handle(
    new Request(new URL("/_dns/v2/complete", ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
  expect(empty.status).toBe(400);
  const secret = "secret-input-value";
  const invalid = await post(broker, "/_dns/v2/challenge", { hostname: secret });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain(secret);
  expect(invalid.headers.get("cache-control")).toBe("no-store");
  // An unreadable registry entry is a broker failure, not a decision.
  const owner = brokerOwner();
  store.values.set(`name:${owner.hostname}`, { gatewayId: "not-a-uuid" });
  expect(await brokerCall((request) => broker.handle(request), owner, { type: "claim" })).toEqual({
    status: 500,
    body: { error: "broker-failure" },
  });
});

test("the registry has a size limit", async () => {
  const { call, store } = setup({ maxNames: 1 });
  expect((await call(brokerOwner(), { type: "claim" })).status).toBe(200);
  expect(await call(brokerOwner(), { type: "claim" })).toEqual({
    status: 507,
    body: { error: "registry-full" },
  });
  // An unreadable count counts from zero.
  store.values.set("meta:names", "garbage");
  expect((await call(brokerOwner(), { type: "claim" })).status).toBe(200);
});

test("the import seeds names and never replaces a binding", async () => {
  const token = "i".repeat(40);
  const { broker, call, store } = setup({ importToken: token });
  const claimed = brokerOwner(),
    fresh = brokerOwner();
  await call(claimed, { type: "claim" });
  const relay = brokerOwner("relay.example.test", claimed.gatewayId);
  const entry = (owner: BrokerOwner) => ({
    hostname: owner.hostname,
    gatewayId: owner.gatewayId,
    ownerPublicKey: owner.ownerPublicKey,
  });
  const body = {
    entries: [
      entry(fresh),
      entry(claimed),
      entry(relay),
      { ...entry(fresh), hostname: brokerOwner().hostname },
    ],
  };
  expect((await post(broker, "/_dns/v2/import", body)).status).toBe(401);
  expect(
    (await post(broker, "/_dns/v2/import", body, { authorization: `Bearer ${"x".repeat(40)}` }))
      .status,
  ).toBe(401);
  const response = await post(broker, "/_dns/v2/import", body, {
    authorization: `Bearer ${token}`,
  });
  expect(await response.json()).toEqual({ imported: 1, existing: 1, conflicts: 1, invalid: 1 });
  expect(store.values.get(`name:${fresh.hostname}`)).toMatchObject({ source: "import" });
  expect(store.values.get(`name:${claimed.hostname}`)).toMatchObject({
    ownerPublicKey: claimed.ownerPublicKey,
    source: "claim",
  });
  // The imported gateway goes on as if it had claimed.
  expect((await call(fresh, { type: "claim" })).status).toBe(200);
  expect((await call(fresh, { type: "txt-create", value: VALUE })).status).toBe(200);
});

test("configuration is validated", () => {
  const { store } = setup();
  const zone = {} as BrokerZone;
  const base = { origin: ORIGIN, relayDomain: "relay.example.test", store, zone };
  for (const origin of [
    "http://dns.example.test",
    "https://dns.example.test/path",
    "https://u@x.test",
  ])
    expect(() => new DnsBroker({ ...base, origin })).toThrow("HTTPS origin");
  expect(new DnsBroker({ ...base, origin: "http://127.0.0.1:8789" }).health().relayDomain).toBe(
    "relay.example.test",
  );
  for (const limits of [
    { leaseTtlMs: 0 },
    { challengeTtlMs: 60_001 },
    { maxChallenges: 1.5 },
    { maxLeases: 65 },
    { maxNames: 2_000_000 },
  ])
    expect(() => new DnsBroker({ ...base, ...limits })).toThrow("limits");
  expect(() => new DnsBroker({ ...base, importToken: "short" })).toThrow("too short");
  expect(
    new DnsBroker({
      ...base,
      caa: { issuer: "ca.example.test", accountUriPrefix: "https://ca.example.test/acct/" },
    }).health().caa,
  ).toEqual({ issuer: "ca.example.test", accountUriPrefix: "https://ca.example.test/acct/" });
  expect(new BrokerError(418, "teapot").message).toBe("teapot");
});

test("expiry keeps live challenges and answers the earliest lease; release touches only its own", async () => {
  let now = 1_800_000_000_000;
  const { call, broker, store, cloudflare } = setup({ now: () => now });
  const first = brokerOwner(),
    second = brokerOwner();
  await call(first, { type: "claim" });
  await call(second, { type: "claim" });
  await call(first, { type: "txt-create", value: VALUE });
  now += 1000;
  await call(second, { type: "txt-create", value: VALUE });
  await post(broker, "/_dns/v2/challenge", first.request({ type: "release" }));
  expect(await broker.expire()).toBe(now - 1000 + 600_000);
  expect([...store.values.keys()].filter((key) => key.startsWith("challenge:"))).toHaveLength(1);
  await call(second, { type: "release" });
  expect(
    cloudflare.records.filter((record) => record.type === "TXT").map((record) => record.name),
  ).toEqual([`_acme-challenge.${first.hostname}`]);
});

test("a store that fails is a broker failure", async () => {
  const { broker, store } = setup();
  vi.spyOn(store, "list").mockRejectedValue(new Error("storage unavailable"));
  const response = await post(
    broker,
    "/_dns/v2/challenge",
    brokerOwner().request({ type: "claim" }),
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "broker-failure" });
});

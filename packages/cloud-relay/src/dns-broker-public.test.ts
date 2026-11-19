// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sign } from "node:crypto";
import { expect, test, vi } from "vitest";
import { brokerOwner, memoryStore, type BrokerOwner } from "../test/dns-broker-owner.js";
import { fakeCloudflare } from "../test/fake-cloudflare.js";
import { DnsBroker, type DnsBrokerOptions } from "./dns-broker-core.js";
import {
  brokerChallengeAdmissionTranscript,
  brokerRequestDigest,
  type BrokerChallenge,
  type BrokerOperation,
} from "./dns-broker-contract.js";
import { cloudflareBrokerZone } from "./dns-broker-zone.js";
import { boundedAdmissionJson, turnstileVerifier } from "./dns-broker-public-admission.js";
import { BrokerTickets, brokerNetworkBucket } from "./dns-broker-tickets.js";

const ORIGIN = "https://dns.example.test";
const ACCOUNT = "https://acme-v02.api.letsencrypt.org/acme/acct/123456";
const SECRET = Buffer.alloc(32, 7).toString("base64url");

function fixture(
  options: {
    quota?: number;
    limits?: NonNullable<DnsBrokerOptions["publicAdmission"]>["limits"];
  } = {},
) {
  const clock = { now: Date.now() };
  const store = memoryStore();
  const cloudflare = fakeCloudflare({ quota: options.quota });
  cloudflare.add({ type: "A", name: "*.relay.example.test", content: "192.0.2.10" });
  cloudflare.add({ type: "AAAA", name: "*.relay.example.test", content: "2001:db8::10" });
  const zone = cloudflareBrokerZone({
    zoneId: cloudflare.zoneId,
    zoneName: "example.test",
    relayDomain: "relay.example.test",
    token: cloudflare.token,
    fetch: cloudflare.fetch,
  });
  const verify = vi.fn(async ({ token }: { token: string }) => token === "accepted");
  const createBroker = () =>
    new DnsBroker({
      origin: ORIGIN,
      relayDomain: "relay.example.test",
      now: () => clock.now,
      store,
      zone,
      publicAdmission: {
        secret: SECRET,
        siteKey: "fixture-site-key",
        verify,
        limits: options.limits,
      },
    });
  let broker = createBroker();
  const post = (path: string, body: unknown, address = "192.0.2.20", origin?: string) =>
    broker.handle(
      new Request(new URL(path, ORIGIN), {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      }),
      { clientAddress: address },
    );
  const start = async (
    owner: BrokerOwner,
    operation: BrokerOperation = { type: "claim" },
    address?: string,
  ) => {
    const request = owner.request(operation);
    const expiresAt = clock.now + 30_000;
    return post(
      "/_dns/v2/challenge",
      {
        ...request,
        proof: {
          expiresAt,
          signature: sign(
            null,
            brokerChallengeAdmissionTranscript(
              ORIGIN,
              await brokerRequestDigest(request),
              expiresAt,
            ),
            owner.privateKey,
          ).toString("base64url"),
        },
      },
      address,
    );
  };
  const enrollment = async (owner: BrokerOwner, address?: string) => {
    const response = await start(owner, { type: "claim" }, address);
    expect(response.status).toBe(428);
    const body = (await response.json()) as { verification: { url: string; expiresAt: number } };
    const ticket = new URL(body.verification.url).searchParams.get("ticket")!;
    return { ...body.verification, ticket };
  };
  const accept = (ticket: string, token = "accepted", origin = ORIGIN) =>
    post("/_dns/v2/enroll/verify", { ticket, token }, undefined, origin);
  const enroll = async (owner: BrokerOwner, address?: string) =>
    accept((await enrollment(owner, address)).ticket);
  const call = async (owner: BrokerOwner, operation: BrokerOperation) => {
    const first = await start(owner, operation);
    if (!first.ok) return first;
    const challenge = (await first.json()) as BrokerChallenge;
    return post("/_dns/v2/complete", {
      challengeId: challenge.challengeId,
      ownerSignature: owner.sign(challenge),
      ticket: challenge.ticket,
    });
  };
  return {
    get broker() {
      return broker;
    },
    restart: () => {
      broker = createBroker();
    },
    clock,
    cloudflare,
    store,
    verify,
    post,
    start,
    enrollment,
    accept,
    enroll,
    call,
    zone,
  };
}

test("public signup requires independent browser proof, not relay approval or self-created keys, without a pending pool", async () => {
  const f = fixture();
  for (let index = 0; index < 80; index++) {
    const owner = brokerOwner();
    expect((await f.post("/_dns/v2/challenge", owner.request({ type: "claim" }))).status).toBe(401);
    expect((await f.start(owner)).status).toBe(428);
  }
  expect([...f.store.values.keys()]).toEqual(["meta:public-allocation-index"]);
  const owner = brokerOwner();
  const pending = await f.enrollment(owner);
  const page = await f.broker.handle(new Request(pending.url));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await page.text()).toContain("gateway-enrollment");
  expect((await f.accept(pending.ticket, "relay-says-approved")).status).toBe(403);
  expect((await f.accept(pending.ticket, "accepted", "https://relay.example.test")).status).toBe(
    403,
  );
  expect([...f.store.values.keys()]).toEqual(["meta:public-allocation-index"]);
  expect((await f.accept(pending.ticket)).status).toBe(200);
  expect((await f.call(owner, { type: "claim" })).status).toBe(200);
});

test("concurrent successful CAPTCHA retries reserve one name and charge one allocation", async () => {
  const f = fixture();
  const owner = brokerOwner();
  const { ticket } = await f.enrollment(owner);
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.accept(ticket)));
  expect(replies.map((r) => r.status)).toEqual(Array(12).fill(200));
  expect(f.store.values.get("meta:names")).toBe(1);
  const counters = [...f.store.values].filter(([key]) => key.startsWith("budget:"));
  expect(counters).toHaveLength(4);
  expect(counters.every(([, value]) => (value as { count: number }).count === 1)).toBe(true);
  expect(JSON.stringify(counters)).not.toContain("192.0.2.20");
});

test("concurrent new names cannot overbook real DNS capacity and active renewals retain their TXT slots", async () => {
  const f = fixture({ quota: 41, limits: { networkPerHour: 20 } });
  const first = brokerOwner(),
    second = brokerOwner();
  const tickets = await Promise.all([f.enrollment(first), f.enrollment(second)]);
  const replies = await Promise.all(tickets.map(({ ticket }) => f.accept(ticket)));
  expect(replies.map((r) => r.status).sort()).toEqual([200, 507]);
  const admitted = replies[0]!.ok ? first : second;
  expect((await f.call(admitted, { type: "caa", accountUri: ACCOUNT })).status).toBe(200);
  expect((await f.call(admitted, { type: "txt-create", value: "a".repeat(43) })).status).toBe(200);
  expect(f.cloudflare.records.filter((r) => r.type === "TXT")).toHaveLength(1);
  expect(f.verify).toHaveBeenCalledTimes(2);
});

test("network and owner allocation limits survive broker restarts and CAPTCHA does not override them", async () => {
  const f = fixture({ limits: { networkPerHour: 1 } });
  const first = brokerOwner();
  expect((await f.enroll(first, "2001:db8:1234:5678::1")).status).toBe(200);
  f.restart();
  expect((await f.enroll(brokerOwner(), "2001:db8:1234:5678::abcd")).status).toBe(429);
  expect((await f.enroll(brokerOwner(), "2001:db8:1234:5679::1")).status).toBe(200);
  f.clock.now += 25 * 3_600_000;
  await f.broker.expire();
  expect([...f.store.values.keys()].some((key) => key.startsWith("budget:"))).toBe(false);
  expect((await f.enroll(brokerOwner(), "2001:db8:1234:5678::2")).status).toBe(200);
});

test("stateless operations are owner-bound, expire, and simultaneous replays execute once", async () => {
  const f = fixture();
  const owner = brokerOwner();
  await f.enroll(owner);
  const response = await f.start(owner, { type: "caa", accountUri: ACCOUNT });
  const challenge = (await response.json()) as BrokerChallenge;
  expect(challenge.ticket).toBeTruthy();
  expect([...f.store.values.keys()].filter((key) => key.startsWith("challenge:"))).toHaveLength(0);
  const complete = {
    challengeId: challenge.challengeId,
    ownerSignature: owner.sign(challenge),
    ticket: challenge.ticket,
  };
  const forged = { ...complete, ownerSignature: brokerOwner().sign(challenge) };
  expect((await f.post("/_dns/v2/complete", forged)).status).toBe(401);
  const replies = await Promise.all([
    f.post("/_dns/v2/complete", complete),
    f.post("/_dns/v2/complete", complete),
  ]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 401]);
  expect(f.cloudflare.records.filter((r) => r.type === "CAA")).toHaveLength(1);
  f.clock.now += 60_001;
  await f.broker.expire();
  expect([...f.store.values.keys()].some((key) => key.startsWith("used:"))).toBe(false);
  expect((await f.post("/_dns/v2/complete", complete)).status).toBe(401);
});

test("release preserves identity but reactivation needs a new automated admission and physical capacity", async () => {
  const f = fixture({ quota: 41, limits: { networkPerHour: 20 } });
  const owner = brokerOwner();
  await f.enroll(owner);
  await f.call(owner, { type: "caa", accountUri: ACCOUNT });
  expect((await f.call(owner, { type: "release" })).status).toBe(200);
  const next = brokerOwner();
  expect((await f.enroll(next)).status).toBe(200);
  expect((await f.start(owner)).status).toBe(428);
  expect((await f.enroll(owner)).status).toBe(507);
  expect((await f.call(owner, { type: "caa", accountUri: ACCOUNT })).status).toBe(403);
  expect((await f.start(brokerOwner("relay.example.test", owner.gatewayId))).status).toBe(409);
});

test("abandoned new-name reservations expire without reassigning ownership", async () => {
  const f = fixture({ quota: 41, limits: { networkPerHour: 20 } });
  const owner = brokerOwner();
  await f.enroll(owner);
  f.clock.now += 15 * 60_000 + 1;
  await f.broker.expire();
  expect((await f.call(owner, { type: "caa", accountUri: ACCOUNT })).status).toBe(403);
  expect((await f.enroll(brokerOwner())).status).toBe(200);
  expect(f.store.values.has(`name:${owner.hostname}`)).toBe(true);
});

test("provider usage failures close only new allocations and unchanged active owners keep renewing", async () => {
  const f = fixture();
  const owner = brokerOwner();
  await f.enroll(owner);
  await f.call(owner, { type: "caa", accountUri: ACCOUNT });
  f.cloudflare.fail.add("usage");
  f.clock.now += 60_001;
  expect((await f.enroll(brokerOwner())).status).toBe(503);
  expect((await f.call(owner, { type: "txt-create", value: "b".repeat(43) })).status).toBe(200);
});

test("Turnstile verifier binds exact origin, action, cData and freshness and rejects redirects", async () => {
  const now = Date.now();
  const response = {
    success: true,
    hostname: "dns.example.test",
    action: "gateway-enrollment",
    cdata: "a".repeat(64),
    challenge_ts: new Date(now).toISOString(),
  };
  const transport = vi.fn(async () => new Response(JSON.stringify(response))) as typeof fetch;
  const verify = turnstileVerifier("fixture-server-secret", transport);
  const request = {
    token: "fixture-token",
    cData: "a".repeat(64),
    hostname: "dns.example.test",
    now,
  };
  expect(await verify(request)).toBe(true);
  expect(await verify({ ...request, cData: "b".repeat(64) })).toBe(false);
  response.action = "different-action";
  expect(await verify(request)).toBe(false);
  response.action = "gateway-enrollment";
  response.hostname = "relay.example.test";
  expect(await verify(request)).toBe(false);
  response.hostname = "dns.example.test";
  response.challenge_ts = new Date(now + 30_001).toISOString();
  expect(await verify(request)).toBe(false);
  response.challenge_ts = new Date(now - 300_001).toISOString();
  expect(await verify(request)).toBe(false);
  expect(transport).toHaveBeenCalledWith(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    expect.objectContaining({ redirect: "manual" }),
  );
  const redirected = turnstileVerifier(
    "fixture-server-secret",
    vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://foreign.example.test" } }),
    ) as typeof fetch,
  );
  expect(await redirected(request)).toBe(false);
});

test("broker ticket keys are independent and address buckets group IPv6 siblings and IPv4 mapped forms", async () => {
  const tickets = new BrokerTickets(SECRET);
  const token = await tickets.seal("enroll", { value: "fixture" });
  const { z } = await import("zod");
  expect(await tickets.open("enroll", token, z.object({ value: z.string() }))).toEqual({
    value: "fixture",
  });
  await expect(tickets.open("operation", token, z.unknown())).rejects.toThrow();
  expect(brokerNetworkBucket("2001:db8:1:2::1")).toBe(
    brokerNetworkBucket("2001:0db8:0001:0002::9"),
  );
  expect(brokerNetworkBucket("::ffff:192.0.2.2")).toBe("192.0.2.2");
});

test("one stalled name and repeated CAA requests cannot block another owner's renewal", async () => {
  const f = fixture();
  const first = brokerOwner(),
    second = brokerOwner();
  await f.enroll(first);
  await f.enroll(second);
  await f.call(second, { type: "caa", accountUri: ACCOUNT });
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = f.zone.publishName.bind(f.zone);
  const publication = vi.spyOn(f.zone, "publishName").mockImplementationOnce(async (...args) => {
    entered();
    await blocked;
    await original(...args);
  });
  const firstCall = f.call(first, { type: "caa", accountUri: ACCOUNT });
  await started;
  const duplicates = Array.from({ length: 10 }, () =>
    f.call(first, { type: "caa", accountUri: ACCOUNT }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const renewal = await Promise.race([
      f.call(second, { type: "txt-create", value: "a".repeat(43) }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1000);
      }),
    ]);
    expect(renewal?.status).toBe(200);
    expect(publication).toHaveBeenCalledTimes(1);
  } finally {
    clearTimeout(timer);
    release();
  }
  expect((await firstCall).status).toBe(200);
  expect((await Promise.all(duplicates)).every((r) => r.status === 200)).toBe(true);
  for (let index = 0; index < 8; index++)
    expect((await f.call(first, { type: "caa", accountUri: ACCOUNT })).status).toBe(200);
  expect(publication).toHaveBeenCalledTimes(1);
  expect((await f.call(first, { type: "caa", accountUri: `${ACCOUNT}7` })).status).toBe(429);
  f.clock.now += 3_600_001;
  expect((await f.call(first, { type: "caa", accountUri: ACCOUNT })).status).toBe(200);
  expect(publication).toHaveBeenCalledTimes(2);
});

test("partial publication keeps conservative capacity despite lagging provider usage", async () => {
  const f = fixture({ quota: 43, limits: { networkPerHour: 20 } });
  const owner = brokerOwner();
  await f.enroll(owner);
  vi.spyOn(f.zone, "publishName").mockImplementationOnce(async (hostname) => {
    f.cloudflare.add({
      type: "A",
      name: hostname,
      content: "192.0.2.10",
      comment: "omnesis-dns-broker-v2",
    });
    throw new Error("fixture failure after one permanent record");
  });
  expect((await f.call(owner, { type: "caa", accountUri: ACCOUNT })).status).toBe(502);
  f.cloudflare.capacity.usage = 2;
  f.clock.now += 120_001;
  expect((await f.enroll(brokerOwner())).status).toBe(507);
  expect(f.store.values.has(`allocation:${owner.hostname}`)).toBe(true);
});

test("a completed publication followed by another name's release does not retain phantom capacity", async () => {
  const f = fixture({ quota: 44, limits: { networkPerHour: 20 } });
  const previous = brokerOwner(),
    current = brokerOwner();
  expect((await f.enroll(previous)).status).toBe(200);
  expect((await f.call(previous, { type: "caa", accountUri: ACCOUNT })).status).toBe(200);
  expect((await f.enroll(current)).status).toBe(200);
  expect((await f.call(current, { type: "caa", accountUri: ACCOUNT })).status).toBe(200);
  expect((await f.call(previous, { type: "release" })).status).toBe(200);
  // The provider usage endpoint may lag behind; the same full inventory counts both total
  // physical records and the managed records which satisfy active entitlements.
  f.cloudflare.capacity.usage = 2;
  expect((await f.enroll(brokerOwner())).status).toBe(200);
});

test("a DNS inventory started before a publication cannot clear its newer reservation", async () => {
  const f = fixture({ quota: 43, limits: { networkPerHour: 20 } });
  const owner = brokerOwner();
  await f.enroll(owner);
  f.clock.now += 15_001;
  const pending = await f.enrollment(brokerOwner());
  let finish!: () => void, entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = f.zone.capacity!;
  vi.spyOn(f.zone, "capacity").mockImplementationOnce(async (signal) => {
    const old = await original(signal);
    entered();
    await paused;
    return old;
  });
  const accepting = f.accept(pending.ticket);
  await started;
  expect((await f.call(owner, { type: "caa", accountUri: ACCOUNT })).status).toBe(200);
  finish();
  expect((await accepting).status).toBe(507);
});

test("dormant ownership history is not scanned in the admission transaction", async () => {
  const f = fixture();
  await f.broker.handle(new Request(`${ORIGIN}/_dns/v2/health`));
  for (let index = 0; index < 2000; index++)
    f.store.values.set(`name:historical-${index}.relay.example.test`, {
      gatewayId: "unused",
      ownerPublicKey: "unused",
      claimedAt: 0,
      source: "claim",
      released: true,
    });
  const reads = vi.spyOn(f.store, "list");
  expect((await f.enroll(brokerOwner())).status).toBe(200);
  expect(reads.mock.calls.some(([prefix]) => prefix === "name:")).toBe(false);
});

test("malformed and oversized browser submissions are bounded client errors", async () => {
  const f = fixture();
  for (const [body, expected] of [
    ["{", 400],
    ["x".repeat(20_000), 413],
  ] as const) {
    const reply = await f.broker.handle(
      new Request(`${ORIGIN}/_dns/v2/enroll/verify`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body,
      }),
    );
    expect(reply.status).toBe(expected);
  }
});

test("a stalled request body has a fixed deadline without occupying shared broker state", async () => {
  vi.useFakeTimers();
  try {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const pending = boundedAdmissionJson(new Response(body));
    const rejected = expect(pending).rejects.toMatchObject({
      status: 408,
      code: "request-timeout",
    });
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

test("an imported identity without a broker publication does not silently gain active DNS capacity", async () => {
  const f = fixture();
  await f.broker.handle(new Request(`${ORIGIN}/_dns/v2/health`));
  const owner = brokerOwner();
  f.store.values.set(`name:${owner.hostname}`, {
    gatewayId: owner.gatewayId,
    ownerPublicKey: owner.ownerPublicKey,
    claimedAt: Math.floor(f.clock.now / 1000),
    source: "import",
  });
  f.store.values.set("meta:names", 1);
  expect((await f.start(owner)).status).toBe(428);
  expect((await f.enroll(owner)).status).toBe(200);
  expect(f.store.values.get("meta:names")).toBe(1);
});

test("tickets cannot cross broker origins even if an operator reuses a signing key", async () => {
  const f = fixture();
  const owner = brokerOwner();
  const enrollment = await f.enrollment(owner);
  const origin = "https://other-dns.example.test";
  const verify = vi.fn(async () => true);
  const other = new DnsBroker({
    origin,
    relayDomain: "relay.example.test",
    store: memoryStore(),
    zone: f.zone,
    now: () => f.clock.now,
    publicAdmission: { secret: SECRET, siteKey: "fixture-site-key", verify },
  });
  const accepted = await other.handle(
    new Request(`${origin}/_dns/v2/enroll/verify`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ ticket: enrollment.ticket, token: "accepted" }),
    }),
  );
  expect(accepted.status).toBe(401);
  expect(verify).not.toHaveBeenCalled();
  await f.accept(enrollment.ticket);
  const challenge = (await (await f.start(owner)).json()) as BrokerChallenge;
  const completed = await other.handle(
    new Request(`${origin}/_dns/v2/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        ticket: challenge.ticket,
        ownerSignature: owner.sign(challenge),
      }),
    }),
  );
  expect(completed.status).toBe(401);
});

test("public completion requires a matching signed ticket and cannot be rebound to another owner", async () => {
  const f = fixture();
  const owner = brokerOwner();
  await f.enroll(owner);
  const challenge = (await (await f.start(owner)).json()) as BrokerChallenge;
  expect(
    (
      await f.post("/_dns/v2/complete", {
        challengeId: challenge.challengeId,
        ownerSignature: owner.sign(challenge),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.post("/_dns/v2/complete", {
        challengeId: crypto.randomUUID(),
        ownerSignature: owner.sign(challenge),
        ticket: challenge.ticket,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.post("/_dns/v2/complete", {
        challengeId: challenge.challengeId,
        ownerSignature: brokerOwner().sign(challenge),
        ticket: challenge.ticket,
      })
    ).status,
  ).toBe(401);
  // The verifier may await the provider while another trusted import commits this name.
  const waiting = brokerOwner();
  const pending = await f.enrollment(waiting);
  f.verify.mockImplementationOnce(async () => {
    await f.store.put(`name:${waiting.hostname}`, {
      gatewayId: waiting.gatewayId,
      ownerPublicKey: brokerOwner().ownerPublicKey,
      source: "import",
      claimedAt: f.clock.now,
    });
    return true;
  });
  expect((await f.accept(pending.ticket)).status).toBe(409);
  const late = await f.enrollment(brokerOwner());
  f.verify.mockImplementationOnce(async () => {
    f.clock.now = late.expiresAt;
    return true;
  });
  expect((await f.accept(late.ticket)).status).toBe(401);
});

test("maintenance reconciles lease deadlines and replay deadlines through the metadata lock", async () => {
  const f = fixture();
  const owner = brokerOwner();
  await f.enroll(owner);
  await f.call(owner, { type: "caa", accountUri: ACCOUNT });
  await f.call(owner, { type: "txt-create", value: "a".repeat(43) });
  const schedule = vi.fn(async (_next: number | undefined) => {});
  await f.broker.updateMaintenance(schedule);
  expect(schedule).toHaveBeenLastCalledWith(f.clock.now + 60_000);
  f.clock.now += 600_001;
  await f.broker.updateMaintenance(schedule);
  expect(schedule).toHaveBeenLastCalledWith(f.clock.now + 60_000);
});

test("public admission cannot coexist with manual approval or a missing provider capacity adapter", () => {
  const f = fixture();
  const options: DnsBrokerOptions = {
    origin: ORIGIN,
    relayDomain: "relay.example.test",
    store: memoryStore(),
    zone: f.zone,
    approvedNewOwners: [],
    publicAdmission: { secret: SECRET, siteKey: "fixture", verify: async () => true },
  };
  expect(() => new DnsBroker(options)).toThrow("no manual approval list");
  const { capacity: _capacity, ...zone } = f.zone;
  expect(() => new DnsBroker({ ...options, approvedNewOwners: undefined, zone })).toThrow(
    "provider capacity",
  );
});

test("a completion that expires after ticket verification is refused again inside the metadata transaction", async () => {
  const f = fixture();
  const owner = brokerOwner();
  await f.enroll(owner);
  const challenge = (await (await f.start(owner)).json()) as BrokerChallenge;
  const before = f.clock.now;
  let reads = 0;
  Object.defineProperty(f.clock, "now", {
    configurable: true,
    get: () => (reads++ === 0 ? before : challenge.expiresAt),
  });
  const result = await f.post("/_dns/v2/complete", {
    challengeId: challenge.challengeId,
    ownerSignature: owner.sign(challenge),
    ticket: challenge.ticket,
  });
  expect(result.status).toBe(401);
  expect(await result.json()).toEqual({ error: "challenge-unknown" });
  expect(await f.store.get(`used:${owner.hostname}`)).toBeUndefined();
});

test("maintenance chooses the earliest retained replay, budget and lease deadline in every combination", async () => {
  const f = fixture();
  const owner = brokerOwner();
  await f.enroll(owner);
  await f.call(owner, { type: "caa", accountUri: ACCOUNT });
  f.clock.now += 90_000_000;
  expect(await f.broker.expire()).toBeUndefined();
  const lease = {
    id: crypto.randomUUID(),
    hostname: owner.hostname,
    value: "a".repeat(43),
    expiresAt: f.clock.now + 50,
  };
  await f.store.put(`lease:${lease.id}`, lease);
  expect(await f.broker.expire()).toBe(lease.expiresAt);
  const leaseSchedule = vi.fn(async (_next: number | undefined) => {});
  await f.broker.updateMaintenance(leaseSchedule);
  expect(leaseSchedule).toHaveBeenLastCalledWith(lease.expiresAt);
  await f.store.put(`used:${owner.hostname}`, [
    { id: crypto.randomUUID(), expiresAt: f.clock.now + 40 },
  ]);
  expect(await f.broker.expire()).toBe(f.clock.now + 40);
  await f.store.put("budget:fixture", { count: 1, expiresAt: f.clock.now + 30 });
  expect(await f.broker.expire()).toBe(f.clock.now + 30);
  await f.store.delete(`lease:${lease.id}`);
  expect(await f.broker.expire()).toBe(f.clock.now + 30);
  await f.store.delete(`used:${owner.hostname}`);
  expect(await f.broker.expire()).toBe(f.clock.now + 30);
  const schedule = vi.fn(async (_next: number | undefined) => {});
  await f.broker.updateMaintenance(schedule);
  expect(schedule).toHaveBeenLastCalledWith(f.clock.now + 30);
  await f.store.delete("budget:fixture");
  await f.store.put(`used:${owner.hostname}`, [
    { id: crypto.randomUUID(), expiresAt: f.clock.now + 40 },
  ]);
  await f.broker.updateMaintenance(schedule);
  expect(schedule).toHaveBeenLastCalledWith(f.clock.now + 40);
});

test("failed registry initialization is handled and cannot admit requests against partial ownership state", async () => {
  const f = fixture();
  const store = memoryStore();
  vi.spyOn(store, "get").mockRejectedValue(new Error("storage unavailable"));
  const broker = new DnsBroker({
    origin: ORIGIN,
    relayDomain: "relay.example.test",
    store,
    zone: f.zone,
    publicAdmission: { secret: SECRET, siteKey: "fixture", verify: async () => true },
  });
  const response = await broker.handle(new Request(`${ORIGIN}/_dns/v2/health`));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "broker-failure" });
  expect(store.values.size).toBe(0);
});

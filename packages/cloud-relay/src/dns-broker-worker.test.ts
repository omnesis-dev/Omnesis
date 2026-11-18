// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { brokerCall, brokerOwner, type BrokerOwner } from "../test/dns-broker-owner.js";
import { fakeCloudflare } from "../test/fake-cloudflare.js";
import {
  brokerChallengeAdmissionTranscript,
  brokerChallengeSchema,
  brokerRequestDigest,
  sha256Hex,
  type BrokerOperation,
} from "./dns-broker-contract.js";
import { dnsBrokerClient } from "./dns-broker-client.js";
import worker, {
  DnsBrokerRegistry,
  type DnsBrokerEnv,
  type DurableObjectStateLike,
} from "./dns-broker-worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The runtime of the registry object as the broker uses it: one instance, its storage and its alarm. */
function durableObjects(overrides: Partial<DnsBrokerEnv> = {}) {
  const cloudflare = fakeCloudflare();
  cloudflare.add({ type: "A", name: "*.relay.example.test", content: "192.0.2.10" });
  vi.stubGlobal("fetch", cloudflare.fetch);
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const blocked: Promise<unknown>[] = [];
  const state: DurableObjectStateLike = {
    storage: {
      get: async (key) => structuredClone(values.get(key)),
      put: async (key, value) => void values.set(key, structuredClone(value)),
      delete: async (key) => values.delete(key),
      list: async ({ prefix }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
      setAlarm: async (time) => void (alarm = time),
      deleteAlarm: async () => void (alarm = null),
    },
    blockConcurrencyWhile: (callback) => {
      const running = callback();
      blocked.push(running);
      return running;
    },
  };
  const names: string[] = [];
  const env: DnsBrokerEnv = {
    PUBLIC_ADMISSION_ENABLED: "0",
    BROKER_ORIGIN: "https://dns.example.test",
    RELAY_DOMAIN: "relay.example.test",
    ZONE_ID: cloudflare.zoneId,
    ZONE_NAME: "example.test",
    CLOUDFLARE_API_TOKEN: cloudflare.token,
    ...overrides,
    DNS_BROKER: {
      idFromName: (name) => {
        names.push(name);
        return name;
      },
      get: () => ({
        fetch: async (request) => {
          await Promise.all(blocked);
          return instance.fetch(request);
        },
      }),
    },
  };
  const instance = new DnsBrokerRegistry(state, env);
  return {
    env,
    cloudflare,
    values,
    names,
    alarm: () => alarm,
    instance: () => instance,
    handle: (request: Request) => worker.fetch(request, env),
  };
}

test("every broker request reaches the one registry object, and nothing else is served", async () => {
  const objects = durableObjects();
  const owner = brokerOwner();
  expect(await brokerCall(objects.handle, owner, { type: "claim" })).toEqual({
    status: 200,
    body: { claimed: true },
  });
  expect(new Set(objects.names)).toEqual(new Set(["registry"]));
  const other = await objects.handle(new Request("https://dns.example.test/"));
  expect(other.status).toBe(404);
  expect(await other.json()).toEqual({ error: "not-found" });
  expect(objects.names).toHaveLength(2);
});

test("the alarm follows the lease journal and removes expired records", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const objects = durableObjects();
  const owner = brokerOwner();
  await brokerCall(objects.handle, owner, { type: "claim" });
  expect(objects.alarm()).toBeNull();
  await brokerCall(objects.handle, owner, { type: "txt-create", value: "a".repeat(43) });
  expect(objects.alarm()).toBe(Date.now() + 60_000);
  vi.setSystemTime(Date.now() + 600_001);
  await objects.instance().alarm();
  expect(objects.alarm()).toBeNull();
  expect(objects.cloudflare.records.filter((record) => record.type === "TXT")).toEqual([]);
});

test("the import token and CAA account prefix come from the Worker's environment", async () => {
  const token = "t".repeat(40);
  const objects = durableObjects({
    REGISTRY_IMPORT_TOKEN: token,
    CAA_ACCOUNT_URI_PREFIX: "https://ca.example.test/acct/",
  });
  const health = await objects.handle(new Request("https://dns.example.test/_dns/v2/health"));
  expect(await health.json()).toMatchObject({
    caa: { accountUriPrefix: "https://ca.example.test/acct/" },
  });
  const imported = await objects.handle(
    new Request("https://dns.example.test/_dns/v2/import", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ entries: [] }),
    }),
  );
  expect(await imported.json()).toEqual({ imported: 0, existing: 0, conflicts: 0, invalid: 0 });
  // An empty secret is no import route.
  const closed = durableObjects({ REGISTRY_IMPORT_TOKEN: "" });
  expect(
    (
      await closed.handle(
        new Request("https://dns.example.test/_dns/v2/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(404);
});

test("the Worker's code imports no Node module", async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  const bare = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(join(root, file), "utf8");
    for (const [, specifier] of source.matchAll(/(?:import|export)[^'"]*?from\s+["']([^"']+)["']/g))
      if (specifier!.startsWith("./")) await visit(specifier!.slice(2).replace(/\.js$/, ".ts"));
      else bare.add(specifier!);
    expect(source).not.toMatch(/import\(/);
  };
  await visit("dns-broker-worker.ts");
  expect([...seen].sort()).toEqual([
    "dns-broker-admission-budget.ts",
    "dns-broker-contract.ts",
    "dns-broker-core.ts",
    "dns-broker-error.ts",
    "dns-broker-http.ts",
    "dns-broker-public-admission.ts",
    "dns-broker-public-operations.ts",
    "dns-broker-tickets.ts",
    "dns-broker-worker.ts",
    "dns-broker-zone.ts",
  ]);
  expect([...bare]).toEqual(["zod"]);
  // Workers throws a TypeError for `redirect: "error"` before any request goes out, so every DNS
  // write failed on the deployed broker while Node-based tests passed.
  for (const file of seen)
    expect(await readFile(join(root, file), "utf8"), file).not.toMatch(/redirect:\s*["']error["']/);
});

test("Worker public admission requires an explicit mode and complete configuration", () => {
  expect(() => durableObjects({ PUBLIC_ADMISSION_ENABLED: undefined })).toThrow(
    "Choose public DNS admission",
  );
  expect(() => durableObjects({ PUBLIC_ADMISSION_ENABLED: "wrong" })).toThrow(
    "Choose public DNS admission",
  );
  expect(() => durableObjects({ PUBLIC_ADMISSION_ENABLED: "1" })).toThrow(
    "requires its key and Turnstile",
  );
});

test("the public Worker strips spoofed internal client context and uses Cloudflare's address", async () => {
  const objects = durableObjects({
    PUBLIC_ADMISSION_ENABLED: "1",
    PUBLIC_ADMISSION_KEY: Buffer.alloc(32, 4).toString("base64url"),
    TURNSTILE_SITE_KEY: "fixture-site-key",
    TURNSTILE_SECRET_KEY: "fixture-secret",
  });
  const owner = brokerOwner();
  const request = owner.request({ type: "claim" });
  const expiresAt = Date.now() + 30_000;
  const body = {
    ...request,
    proof: {
      expiresAt,
      signature: sign(
        null,
        brokerChallengeAdmissionTranscript(
          "https://dns.example.test",
          await brokerRequestDigest(request),
          expiresAt,
        ),
        owner.privateKey,
      ).toString("base64url"),
    },
  };
  const post = (headers: HeadersInit) =>
    objects.handle(
      new Request("https://dns.example.test/_dns/v2/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  expect((await post({ "x-omnesis-dns-worker-client": "192.0.2.1" })).status).toBe(403);
  expect(
    (await post({ "x-omnesis-dns-worker-client": "192.0.2.1", "cf-connecting-ip": "192.0.2.2" }))
      .status,
  ).toBe(428);
});

test("failed DNS writes with retained journals arm maintenance while unauthenticated errors do not retry cleanup", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const objects = durableObjects();
  const owner = brokerOwner();
  await brokerCall(objects.handle, owner, { type: "claim" });
  expect(objects.alarm()).toBeNull();
  objects.cloudflare.fail.add("create:TXT");
  objects.cloudflare.fail.add("list");
  expect(
    (await brokerCall(objects.handle, owner, { type: "txt-create", value: "a".repeat(43) })).status,
  ).toBe(502);
  expect(objects.alarm()).not.toBeNull();
  const transport = vi.fn(objects.cloudflare.fetch);
  vi.stubGlobal("fetch", transport);
  for (let index = 0; index < 5; index++)
    await objects.handle(new Request("https://dns.example.test/_dns/v2/missing"));
  expect(transport).not.toHaveBeenCalled();
  objects.cloudflare.fail.clear();
  vi.setSystemTime(Date.now() + 600_001);
  await objects.instance().alarm();
  expect([...objects.values.keys()].some((key) => key.startsWith("lease:"))).toBe(false);
  expect(objects.alarm()).toBeNull();
});

test("public alarm cleanup cannot erase maintenance for a concurrent new allocation", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const objects = durableObjects({
    PUBLIC_ADMISSION_ENABLED: "1",
    PUBLIC_ADMISSION_KEY: Buffer.alloc(32, 9).toString("base64url"),
    TURNSTILE_SITE_KEY: "fixture-site-key",
    TURNSTILE_SECRET_KEY: "fixture-server-secret",
  });
  let pause = false;
  let entered!: () => void, resume!: () => void;
  const cleaning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "challenges.cloudflare.com") {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("secret")).toBe("fixture-server-secret");
      return new Response(
        JSON.stringify({
          success: true,
          action: "gateway-enrollment",
          hostname: "dns.example.test",
          cdata: form.get("response"),
          challenge_ts: new Date().toISOString(),
        }),
      );
    }
    if (pause && init?.method === "DELETE") {
      entered();
      await blocked;
    }
    return objects.cloudflare.fetch(input, init);
  });
  const transport: typeof fetch = async (input, init) =>
    objects.handle(
      new Request(String(input), {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          "cf-connecting-ip": "192.0.2.20",
        },
      }),
    );
  const client = (owner: BrokerOwner) =>
    dnsBrokerClient({
      brokerUrl: "https://dns.example.test",
      relayUrl: "https://relay.example.test",
      gatewayId: owner.gatewayId,
      owner: async () => owner.privateKey,
      fetch: transport,
    });
  const admit = async (owner: BrokerOwner) => {
    const request = owner.request({ type: "claim" });
    const expiresAt = Date.now() + 30_000;
    const response = await transport("https://dns.example.test/_dns/v2/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        proof: {
          expiresAt,
          signature: sign(
            null,
            brokerChallengeAdmissionTranscript(
              "https://dns.example.test",
              await brokerRequestDigest(request),
              expiresAt,
            ),
            owner.privateKey,
          ).toString("base64url"),
        },
      }),
    });
    expect(response.status).toBe(428);
    const { verification } = (await response.json()) as { verification: { url: string } };
    const ticket = new URL(verification.url).searchParams.get("ticket")!;
    const cData = await sha256Hex(
      JSON.stringify([
        "omnesis-dns-owner-v1",
        owner.hostname,
        owner.gatewayId,
        owner.ownerPublicKey,
      ]),
    );
    const accepted = await transport("https://dns.example.test/_dns/v2/enroll/verify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://dns.example.test" },
      body: JSON.stringify({ ticket, token: cData }),
    });
    expect(accepted.status).toBe(200);
  };
  const first = brokerOwner();
  await admit(first);
  await client(first).publishCaa(
    "https://acme-v02.api.letsencrypt.org/acme/acct/123456",
    AbortSignal.timeout(5000),
  );
  await client(first).presenter().create("a".repeat(43), AbortSignal.timeout(5000));
  vi.setSystemTime(Date.now() + 600_001);
  pause = true;
  const alarm = objects.instance().alarm();
  await cleaning;
  try {
    await admit(brokerOwner());
  } finally {
    pause = false;
    resume();
  }
  await alarm;
  expect(objects.alarm()).not.toBeNull();
  expect(objects.alarm()).toBeGreaterThan(Date.now());
  expect([...objects.values.keys()].filter((key) => key.startsWith("allocation:"))).toHaveLength(2);
});

test("the protected Worker admits only approved new keys and continues serving existing owners", async () => {
  const owner = brokerOwner();
  const other = brokerOwner();
  const { hostname, gatewayId, ownerPublicKey } = owner;
  const objects = durableObjects({
    APPROVED_NEW_OWNERS_JSON: JSON.stringify([{ hostname, gatewayId, ownerPublicKey }]),
  });
  const client = (identity: typeof owner) =>
    dnsBrokerClient({
      brokerUrl: objects.env.BROKER_ORIGIN,
      relayUrl: "https://" + objects.env.RELAY_DOMAIN,
      gatewayId: identity.gatewayId,
      owner: async () => identity.privateKey,
      fetch: async (input, init) => objects.handle(new Request(input, init)),
    });
  const signal = new AbortController().signal;
  await expect(brokerCall(objects.handle, owner, { type: "claim" })).resolves.toMatchObject({
    status: 401,
  });
  await expect(client(other).claim(signal)).rejects.toThrow("refused");
  expect([...objects.values.keys()]).toEqual([]);
  await client(owner).claim(signal);
  const admitted = client(owner);
  await admitted.publishCaa("https://acme-v02.api.letsencrypt.org/acme/acct/123", signal);
  const lease = await admitted.presenter().create("a".repeat(43), signal);
  await admitted.presenter().remove(lease.id, signal);
  expect(objects.cloudflare.records.some(({ type }) => type === "CAA")).toBe(true);
});

test("protected requests reuse their reservation and a name cannot reserve twice", async () => {
  const owner = brokerOwner();
  const otherKey = brokerOwner(undefined, owner.gatewayId);
  const { hostname, gatewayId, ownerPublicKey } = owner;
  const objects = durableObjects({
    APPROVED_NEW_OWNERS_JSON: JSON.stringify([{ hostname, gatewayId, ownerPublicKey }]),
  });
  const post = (route: string, body: unknown) =>
    objects.handle(
      new Request(objects.env.BROKER_ORIGIN + "/_dns/v2/" + route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const challenge = async (identity: typeof owner, operation: BrokerOperation) => {
    const request = identity.request(operation);
    const expiresAt = Date.now() + 30_000;
    const digest = await brokerRequestDigest(request);
    const proof = {
      expiresAt,
      signature: sign(
        null,
        brokerChallengeAdmissionTranscript(objects.env.BROKER_ORIGIN, digest, expiresAt),
        identity.privateKey,
      ).toString("base64url"),
    };
    return post("challenge", { ...request, proof });
  };
  const claim = brokerChallengeSchema.parse(
    await (await challenge(owner, { type: "claim" })).json(),
  );
  expect(await (await challenge(owner, { type: "claim" })).json()).toEqual(claim);
  expect(
    (
      await post("complete", {
        challengeId: claim.challengeId,
        ownerSignature: otherKey.sign(claim),
      })
    ).status,
  ).toBe(401);
  expect(
    (await post("complete", { challengeId: claim.challengeId, ownerSignature: owner.sign(claim) }))
      .status,
  ).toBe(200);
  expect((await challenge(otherKey, { type: "claim" })).status).toBe(409);

  const pending = await challenge(owner, { type: "txt-create", value: "a".repeat(43) });
  expect(pending.status).toBe(200);
  expect((await challenge(owner, { type: "txt-create", value: "b".repeat(43) })).status).toBe(429);
});

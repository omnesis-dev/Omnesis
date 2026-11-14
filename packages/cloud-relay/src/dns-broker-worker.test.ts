// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { brokerCall, brokerOwner } from "../test/dns-broker-owner.js";
import { fakeCloudflare } from "../test/fake-cloudflare.js";
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
  expect(objects.alarm()).toBe(Date.now() + 600_000);
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
    "dns-broker-contract.ts",
    "dns-broker-core.ts",
    "dns-broker-worker.ts",
    "dns-broker-zone.ts",
  ]);
  expect([...bare]).toEqual(["zod"]);
});

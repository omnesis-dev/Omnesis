// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { brokerCall, brokerOwner, memoryStore, ownerFrom } from "../test/dns-broker-owner.js";
import { fakeCloudflare } from "../test/fake-cloudflare.js";
import { RelayAccounts } from "./accounts.js";
import { KEY_BINDING_PREFIX, gatewayKeyAccount } from "./gateway-key-auth.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { DnsBroker } from "./dns-broker-core.js";
import { cloudflareBrokerZone } from "./dns-broker-zone.js";
import { exportGatewayKeys, importRegistry, readRegistryExport } from "./dns-broker-registry.js";
import { runRelayCommand } from "./runtime.js";

const domain = "relay.example.test";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-dns-broker-registry-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

/** A relay database holding a hosted gateway, a custom domain, a Google-era binding and junk. */
async function relayDatabase() {
  const path = join(directory, "relay.sqlite");
  const accounts = new RelayAccounts(path);
  const certificate = await readFile(tlsFiles(directory, `*.${domain}`).certFile, "utf8");
  const custom = await readFile(tlsFiles(join(directory), "gateway.example.org").certFile, "utf8");
  const keys = generateKeyPairSync("ed25519");
  const gatewayId = randomUUID().toUpperCase();
  const register = (id: string, origin: string, cert: string) => {
    const key = id === gatewayId ? keys.publicKey : generateKeyPairSync("ed25519").publicKey;
    accounts.registerKeyBinding(
      gatewayKeyAccount({
        gatewayId: id,
        ownerPublicKey: key.export({ format: "pem", type: "spki" }).toString(),
      }),
      {
        gatewayId: id,
        publicOrigin: origin,
        certificate: cert,
        identityToken:
          KEY_BINDING_PREFIX + key.export({ format: "der", type: "spki" }).toString("base64url"),
      },
      true,
    );
  };
  register(gatewayId, `https://${hostedGatewayHostname(gatewayId, domain)}`, certificate);
  register(randomUUID(), "https://gateway.example.org", custom);
  const google = randomUUID();
  accounts.registerBinding("b".repeat(64), {
    gatewayId: google,
    publicOrigin: `https://${hostedGatewayHostname(google, domain)}`,
    certificate,
    identityToken: "google-id-token",
  });
  accounts.close();
  const db = new Database(path);
  db.prepare(
    "INSERT INTO relay_gateway_bindings(account_id, hostname, binding) VALUES (?, ?, ?)",
  ).run("c".repeat(64), "g-junk.relay.example.test", JSON.stringify({ unexpected: true }));
  db.close();
  return {
    path,
    owner: ownerFrom(keys.privateKey, keys.publicKey, domain, gatewayId.toLowerCase()),
  };
}

test("the export holds each hosted name with its gateway and owner key, and nothing else", async () => {
  const { path, owner } = await relayDatabase();
  expect(exportGatewayKeys(path, domain)).toEqual([
    { hostname: owner.hostname, gatewayId: owner.gatewayId, ownerPublicKey: owner.ownerPublicKey },
  ]);
  expect(() => exportGatewayKeys(join(directory, "missing.sqlite"), domain)).toThrow();
});

test("an imported gateway keeps its name, and a relay that races it with another key can't take it", async () => {
  const { path, owner } = await relayDatabase();
  const cloudflare = fakeCloudflare();
  const token = "i".repeat(40);
  const broker = new DnsBroker({
    origin: "https://dns.example.test",
    relayDomain: domain,
    importToken: token,
    store: memoryStore(),
    zone: cloudflareBrokerZone({
      zoneId: cloudflare.zoneId,
      zoneName: "example.test",
      relayDomain: domain,
      token: cloudflare.token,
      fetch: cloudflare.fetch,
    }),
  });
  const transport = (input: string | URL | Request, init?: RequestInit) =>
    broker.handle(new Request(input, init));
  const entries = exportGatewayKeys(path, domain);
  // Batches of 500: a thousand and one names take three requests.
  const many = [...entries, ...Array.from({ length: 1000 }, () => brokerOwner())].map((entry) => ({
    hostname: entry.hostname,
    gatewayId: entry.gatewayId,
    ownerPublicKey: entry.ownerPublicKey,
  }));
  const counting = vi.fn(transport);
  expect(
    await importRegistry({
      brokerUrl: "https://dns.example.test",
      token,
      entries: many,
      fetch: counting as typeof fetch,
    }),
  ).toEqual({ imported: 1001, existing: 0, conflicts: 0, invalid: 0 });
  expect(counting).toHaveBeenCalledTimes(3);
  const relay = brokerOwner(domain, owner.gatewayId);
  const handle = (request: Request) => broker.handle(request);
  expect((await brokerCall(handle, relay, { type: "claim" })).status).toBe(409);
  expect(
    (await brokerCall(handle, owner, { type: "txt-create", value: "a".repeat(43) })).status,
  ).toBe(200);
  await expect(
    importRegistry({
      brokerUrl: "https://dns.example.test",
      token: "wrong",
      entries,
      fetch: transport as typeof fetch,
    }),
  ).rejects.toThrow("refused");
});

test("the operator exports from the relay database and imports into the broker", async () => {
  const { path, owner } = await relayDatabase();
  const exportFile = join(directory, "registry-export.json");
  expect(
    await runRelayCommand("export-gateway-keys", {
      OMNESIS_CLOUD_RELAY_DB: path,
      OMNESIS_CLOUD_RELAY_DOMAIN: domain,
      OMNESIS_CLOUD_RELAY_DNS_BROKER_EXPORT_FILE: exportFile,
    }),
  ).toBeUndefined();
  expect((await stat(exportFile)).mode & 0o777).toBe(0o600);
  expect(await readRegistryExport(exportFile)).toMatchObject([{ hostname: owner.hostname }]);
  const tokenFile = join(directory, "import-token.json");
  await writeFile(tokenFile, JSON.stringify({ token: "i".repeat(40) }));
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Response.json({ imported: 1, existing: 0, conflicts: 0, invalid: 0 });
  });
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runRelayCommand("dns-broker-import-registry", {
      OMNESIS_ACME_DNS_BROKER_URL: "https://dns.example.test",
      OMNESIS_CLOUD_RELAY_DNS_BROKER_EXPORT_FILE: exportFile,
      OMNESIS_CLOUD_RELAY_DNS_BROKER_IMPORT_TOKEN_FILE: tokenFile,
    });
  } finally {
    vi.unstubAllGlobals();
  }
  expect(sent).toEqual([{ entries: [expect.objectContaining({ hostname: owner.hostname })] }]);
  expect(output).toHaveBeenCalledWith('{"imported":1,"existing":0,"conflicts":0,"invalid":0}\n');
});

test("an oversized export is refused before it is parsed", async () => {
  const file = join(directory, "export.json");
  await writeFile(file, "");
  const { truncate } = await import("node:fs/promises");
  await truncate(file, 64 * 1024 * 1024 + 1);
  await expect(readRegistryExport(file)).rejects.toThrow("too large");
});

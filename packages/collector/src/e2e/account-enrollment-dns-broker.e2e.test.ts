// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway names at the DNS broker, end to end: a real relay, a real broker serving its name
 * registry against the fixture DNS API, and a brand-new gateway connecting from its portal. The
 * gateway claims its hosted name at the broker before the relay ever hears its id, so a relay
 * that learns the id can neither take the name nor lease its challenge record, and the
 * gateway's certificate is issued through the broker, never through the relay's DNS token.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runRelayCommand } from "@omnesis/cloud-relay/runtime";
import { localAcmeAuthority } from "../../../cloud-relay/test/acme-authority.js";
import { brokerCall, brokerOwner } from "../../../cloud-relay/test/dns-broker-owner.js";
import {
  EnrollmentWorld,
  PasskeyBrowser,
  SCT_EXTENSION_LINE,
  browserSuiteAvailable,
  connectThisGateway,
  createAccountWithPasskey,
  enterConnectCode,
  expectText,
  servedCertificate,
  waitFor,
  type CloudRelayStatus,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import { E2EHarness } from "./harness.js";

const RELAY_DOMAIN = "relay.example.test";
const browserReady = browserSuiteAvailable("account-enrollment-dns-broker.e2e");

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.skipIf(!browserReady)("gateway names at the DNS broker", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  let broker: { url: string; close(): Promise<void> } | undefined;
  let brokerUrl: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-dns-broker-"));
    world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
    browser = await PasskeyBrowser.launch(world);
    const port = await freePort();
    brokerUrl = `http://127.0.0.1:${port}`;
    // Its own registry and its own copy of the DNS token; it needs nothing of the relay's.
    const token = join(directory, "broker-dns-token.json");
    await writeFile(token, await readFile(join(directory, "relay-dns-token.json")), {
      mode: 0o600,
    });
    broker = await runRelayCommand("serve-dns-broker", {
      OMNESIS_ACME_DNS_BROKER_URL: brokerUrl,
      OMNESIS_CLOUD_RELAY_DNS_BROKER_PORT: String(port),
      OMNESIS_CLOUD_RELAY_DOMAIN: RELAY_DOMAIN,
      OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: "a".repeat(32),
      OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: RELAY_DOMAIN,
      OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: token,
      OMNESIS_CLOUD_RELAY_DNS_BROKER_REGISTRY: join(directory, "broker-registry.json"),
      OMNESIS_CLOUD_RELAY_DNS_BROKER_FIXTURE_DNS_API_URL: world.dnsApiUrl(),
    });
  }, gatewayBootBudgetMs() + 60_000);

  afterAll(async () => {
    try {
      await browser?.close();
      await broker?.close();
      await world?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  /** The broker as anyone on the network reaches it. */
  const handle = async (request: Request) =>
    fetch(new URL(new URL(request.url).pathname, brokerUrl), {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    });

  test(
    "F3: a relay that knows a gateway's id cannot claim its name at the broker before the gateway does, and the certificate comes through the broker",
    async () => {
      let hostname: string | undefined;
      await mkdir(join(directory, "acme"), { recursive: true });
      const authority = await localAcmeAuthority(
        join(directory, "acme"),
        () => {
          if (!hostname) throw new Error("No gateway hostname yet");
          return hostname;
        },
        world.dnsRecords,
        { leafExtensions: [SCT_EXTENSION_LINE] },
      );
      const acmeRoot = join(directory, "acme-root.pem");
      await writeFile(acmeRoot, authority.root);
      const bundle = join(directory, "gateway-trust.pem");
      await writeFile(bundle, world.pki.caCert + authority.root);
      const fresh = new E2EHarness({
        extraGatewayEnv: {
          ...world.clientEnv({ NODE_EXTRA_CA_CERTS: bundle }),
          OMNESIS_CLOUD_RELAY_ENABLED: "1",
          OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
          OMNESIS_ACME_DIRECTORY_URL: authority.directoryUrl,
          OMNESIS_ACME_CA_FILE: acmeRoot,
          // The operator names the broker; nothing the relay says can.
          OMNESIS_ACME_DNS_PROVIDER: "broker",
          OMNESIS_ACME_DNS_BROKER_URL: brokerUrl,
          OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
        },
      });
      try {
        await fresh.start();
        const session = await browser.session();
        const page = session.page;
        await page.goto(`${fresh.gatewayUrl}/portal/?token=${encodeURIComponent(fresh.apiKey)}`);
        await page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
        await page.goto(`${fresh.gatewayUrl}/portal/settings/account`);
        await page.getByRole("button", { name: "Create an Omnesis account", exact: true }).click();
        await expectText(page, "Sign in to your Omnesis account", 30_000);
        const waiting = await fresh.gatewayJson<
          CloudRelayStatus & { hostname?: string; gatewayId?: string }
        >("/admin/cloud-relay");
        hostname = waiting.hostname;
        expect(hostname).toMatch(/^g-[a-z2-7]{8}\.relay\.example\.test$/);

        // The relay has now seen the gateway's id. With a key of its own it races for the name
        // and for its challenge record, and is too late for both.
        const relay = brokerOwner(RELAY_DOMAIN, waiting.gatewayId!);
        expect(await brokerCall(handle, relay, { type: "claim" }, brokerUrl)).toEqual({
          status: 409,
          body: { error: "name-taken" },
        });
        expect(
          await brokerCall(handle, relay, { type: "txt-create", value: "a".repeat(43) }, brokerUrl),
        ).toEqual({ status: 403, body: { error: "name-owned-by-another-key" } });
        const registry = JSON.parse(
          await readFile(join(directory, "broker-registry.json"), "utf8"),
        ) as Record<string, { gatewayId: string; ownerPublicKey: string; source: string }>;
        expect(registry[`name:${hostname}`]).toMatchObject({
          gatewayId: waiting.gatewayId,
          source: "claim",
        });
        expect(registry[`name:${hostname}`]!.ownerPublicKey).not.toBe(relay.ownerPublicKey);

        const person = await browser.session();
        await enterConnectCode(person.page, waiting.connect!.connectUrl!, waiting.connect!.code!);
        await createAccountWithPasskey(person.page);
        await connectThisGateway(person.page);
        const done = await waitFor(
          async () => {
            const status = await fresh.gatewayJson<CloudRelayStatus & Record<string, unknown>>(
              "/admin/cloud-relay",
            );
            return status.connect?.state === "done" || status.connect?.state === "failed"
              ? status
              : undefined;
          },
          "connect to finish",
          120_000,
        );
        expect(done).toMatchObject({
          connect: { state: "done" },
          hostname,
          certificate: { state: "valid" },
          tunnel: { state: "online" },
        });
        const served = await servedCertificate(world, hostname!, authority.root);
        expect(served.subjectAltName).toBe(`DNS:${hostname}`);
        // The challenge went through the broker: the relay never journaled a DNS lease, and the
        // broker left no record behind.
        await expect(stat(join(directory, "relay-dns-journal"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const after = JSON.parse(
          await readFile(join(directory, "broker-registry.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(Object.keys(after).filter((key) => key.startsWith("lease:"))).toEqual([]);
        expect(session.errors).toEqual([]);
        expect(person.errors).toEqual([]);
      } finally {
        await fresh.destroy();
        await authority.close();
      }
    },
    gatewayBootBudgetMs() + 240_000,
  );
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Public gateway setup with a real independent broker, DNS-01 issuer and passkey account. */
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DnsBroker } from "../../../cloud-relay/src/dns-broker-core.js";
import { cloudflareBrokerZone } from "../../../cloud-relay/src/dns-broker-zone.js";
import { memoryStore } from "../../../cloud-relay/test/dns-broker-owner.js";
import { localAcmeAuthority } from "../../../cloud-relay/test/acme-authority.js";
import {
  EnrollmentWorld,
  PasskeyBrowser,
  SCT_EXTENSION_LINE,
  browserSuiteAvailable,
  clickFirst,
  connectThisGateway,
  createAccountWithPasskey,
  createUnlinkedAccount,
  enterConnectCode,
  expectText,
  runCli,
  waitFor,
  type CloudRelayStatus,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { closeEnrollmentFixture } from "./enrollment-fixture-cleanup.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import { E2EHarness } from "./harness.js";
import type { AddressInfo } from "node:net";

const ready = browserSuiteAvailable("account-enrollment-dns-public.e2e");
const RELAY_DOMAIN = "relay.example.test";
const FIXTURE_DNS_TOKEN = "fixture-relay-dns-token";
const SDK_PATTERN = "https://challenges.cloudflare.com/turnstile/v0/api.js**";
// The fixture browser's loopback resolver covers the relay domain and its subdomains.
const BROKER_HOST = `dns.${RELAY_DOMAIN}`;
type Status = CloudRelayStatus & {
  configured: boolean;
  certificate: { state: string };
  hostname?: string;
  connect?: NonNullable<CloudRelayStatus["connect"]> & {
    verification?: { url: string; expiresAt: number };
  };
};

describe.skipIf(!ready)("public DNS enrollment", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  let server: ReturnType<typeof createServer>;
  let broker: DnsBroker;
  let brokerUrl: string;
  const authorities: Array<Awaited<ReturnType<typeof localAcmeAuthority>>> = [];
  let issuingHostname: string | undefined;
  const gateways: E2EHarness[] = [];
  const verified: { cData: string; hostname: string }[] = [];
  const claims: { hostname: string; gatewayId: string }[] = [];
  const store = memoryStore();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-public-dns-e2e-"));
    world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
    browser = await PasskeyBrowser.launch(world);
    const leaf = await world.pki.leaf("public-dns", [BROKER_HOST]);
    server = createServer(
      { key: await readFile(leaf.keyFile), cert: leaf.cert },
      (incoming, outgoing) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const part of incoming) chunks.push(Buffer.from(part));
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers))
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(",") : value);
          const request = new Request(new URL(incoming.url ?? "/", brokerUrl), {
            method: incoming.method,
            headers,
            ...(body.length ? { body } : {}),
          });
          if (new URL(request.url).pathname.endsWith("/challenge")) {
            const value = (await request.clone().json()) as {
              hostname: string;
              gatewayId: string;
              operation: { type: string };
            };
            if (value.operation.type === "claim") {
              claims.push(value);
              issuingHostname = value.hostname;
            }
          }
          const response = await broker.handle(request, {
            clientAddress: incoming.socket.remoteAddress,
          });
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        })().catch(() => {
          outgoing.writeHead(500);
          outgoing.end();
        });
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    brokerUrl = `https://${BROKER_HOST}:${(server.address() as AddressInfo).port}`;
    const zone = cloudflareBrokerZone({
      zoneId: "a".repeat(32),
      zoneName: RELAY_DOMAIN,
      relayDomain: RELAY_DOMAIN,
      token: FIXTURE_DNS_TOKEN,
      apiUrl: world.dnsApiUrl(),
    });
    // Provider quota parsing and headroom enforcement are tested at the broker boundary.
    // This integration controls its provider's budget while retaining real DNS publication.
    zone.capacity = async () => ({ usage: 1, quota: 1000, recordsPerName: 2, managedRecords: {} });
    broker = new DnsBroker({
      origin: brokerUrl,
      relayDomain: RELAY_DOMAIN,
      store,
      zone,
      publicAdmission: {
        secret: randomBytes(32).toString("base64url"),
        siteKey: "fixture-turnstile-site-key",
        verify: async ({ token, cData, hostname }) => {
          if (token !== `fixture-${cData}` || hostname !== BROKER_HOST) return false;
          verified.push({ cData, hostname });
          return true;
        },
      },
    });
    await fetch(`${world.dnsApiUrl()}/zones/${"a".repeat(32)}/dns_records`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${FIXTURE_DNS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "A", name: `*.${RELAY_DOMAIN}`, content: "192.0.2.10" }),
    });
  }, gatewayBootBudgetMs() + 60_000);

  afterAll(async () => {
    await closeEnrollmentFixture(world ? directory : undefined, [
      () => browser?.close(),
      ...gateways.map((gateway) => () => gateway.destroy()),
      ...authorities.map((authority) => () => authority.close()),
      async () => {
        if (!server) return;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
      () => world?.close(),
    ]);
  }, 60_000);

  async function freshGateway() {
    // The RFC8555 stand-in owns one account/order/certificate, so each gateway gets its own.
    const acme = join(directory, `acme-${gateways.length}`);
    await mkdir(acme);
    const authority = await localAcmeAuthority(
      acme,
      () => {
        if (!issuingHostname) throw new Error("The gateway has not requested its public name");
        return issuingHostname;
      },
      world.dnsRecords,
      { leafExtensions: [SCT_EXTENSION_LINE] },
    );
    authorities.push(authority);
    const acmeRoot = join(acme, "gateway-acme-root.pem");
    const trustFile = join(acme, "gateway-trust.pem");
    await writeFile(acmeRoot, authority.root);
    await writeFile(trustFile, world.pki.caCert + authority.root);
    const gateway = new E2EHarness({
      extraGatewayEnv: {
        ...world.clientEnv({ NODE_EXTRA_CA_CERTS: trustFile }),
        OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
        OMNESIS_ACME_DNS_PROVIDER: "broker",
        OMNESIS_ACME_DNS_BROKER_URL: brokerUrl,
        OMNESIS_ACME_DIRECTORY_URL: authority.directoryUrl,
        OMNESIS_ACME_CA_FILE: acmeRoot,
        OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
      },
    });
    gateways.push(gateway);
    await gateway.start();
    return gateway;
  }

  async function installSecurityWidget(session: PasskeySession, automatic = true): Promise<void> {
    // Only the third-party widget is scripted; the actual broker HTML, fetch and verification run.
    const complete = automatic
      ? "finish();"
      : "const button=document.createElement('button');button.textContent='Confirm test browser';button.addEventListener('click',finish);document.querySelector(selector).appendChild(button);";
    const script = `window.turnstile={render:function(selector,options){window.fixtureTurnstile={action:options.action,cData:options.cData};const finish=()=>options.callback('fixture-'+options.cData);${complete}return 'fixture-widget';}};window.omnesisDnsCheck();`;
    await session.context.route(SDK_PATTERN, (route) =>
      route.fulfill({ contentType: "application/javascript", body: script }),
    );
  }
  async function securityBrowser(): Promise<PasskeySession> {
    const session = await browser.session();
    await installSecurityWidget(session);
    return session;
  }

  async function finish(gateway: E2EHarness) {
    const result = await waitFor(
      async () => {
        const status = await gateway.gatewayJson<Status>("/admin/cloud-relay");
        return status.connect?.state === "failed" ||
          (status.connect?.state === "done" && status.certificate.state === "valid")
          ? status
          : undefined;
      },
      "public gateway connection to finish",
      120_000,
    );
    expect(result).toMatchObject({
      connect: { state: "done" },
      configured: true,
      account: { linked: true },
      tunnel: { state: "online" },
      certificate: { state: "valid" },
    });
    return result;
  }

  test(
    "portal setup obtains a public name automatically after the independent browser check, with a passkey-only account",
    async () => {
      const gateway = await freshGateway();
      const portal = await browser.session();
      await portal.page.goto(
        `${gateway.gatewayUrl}/portal/?token=${encodeURIComponent(gateway.apiKey)}`,
      );
      await portal.page.locator("nav.sidebar-nav").waitFor();
      await portal.page.goto(`${gateway.gatewayUrl}/portal/settings/account`);
      await portal.page.getByRole("button", { name: "Create an account", exact: true }).click();
      await expectText(portal.page, "Verify this gateway's setup", 30_000);
      const pending = await gateway.gatewayJson<Status>("/admin/cloud-relay");
      expect(pending.configured).toBe(false);
      expect(pending.connect?.verification?.url.startsWith(brokerUrl)).toBe(true);
      expect(pending.connect?.connectUrl).toBeUndefined();
      expect([...store.values.keys()].filter((key) => key.startsWith("name:"))).toHaveLength(0);
      await portal.page.screenshot({
        path: "/tmp/omnesis-dns-public-portal-verification.png",
        fullPage: true,
      });
      await portal.page.setViewportSize({ width: 390, height: 844 });
      await portal.page.screenshot({
        path: "/tmp/omnesis-dns-public-portal-verification-mobile.png",
        fullPage: true,
      });
      await portal.page.setViewportSize({ width: 1280, height: 720 });
      const checker = await browser.session();
      await checker.context.route(SDK_PATTERN, (route) => route.abort());
      await checker.page.goto(pending.connect!.verification!.url);
      await expectText(checker.page, "The security check is unavailable", 30_000);
      await checker.page.screenshot({
        path: "/tmp/omnesis-dns-public-worker-unavailable.png",
        fullPage: true,
      });
      await checker.context.unroute(SDK_PATTERN);
      await installSecurityWidget(checker, false);
      await checker.page.getByRole("button", { name: "Try again", exact: true }).click();
      await checker.page
        .getByRole("button", { name: "Confirm test browser", exact: true })
        .waitFor();
      await checker.page.screenshot({
        path: "/tmp/omnesis-dns-public-worker-pending.png",
        fullPage: true,
      });
      await checker.page.setViewportSize({ width: 390, height: 844 });
      await checker.page.screenshot({
        path: "/tmp/omnesis-dns-public-worker-pending-mobile.png",
        fullPage: true,
      });
      await checker.page.setViewportSize({ width: 1280, height: 720 });
      await checker.page.getByRole("button", { name: "Confirm test browser", exact: true }).click();
      await expectText(checker.page, "Verified. Return to Omnesis", 30_000);
      await checker.page.screenshot({
        path: "/tmp/omnesis-dns-public-worker-verified.png",
        fullPage: true,
      });
      expect(
        await checker.page.evaluate(
          () =>
            (globalThis as unknown as { fixtureTurnstile: { action: string } }).fixtureTurnstile
              .action,
        ),
      ).toBe("gateway-enrollment");
      await expectText(portal.page, "Sign in to your Omnesis account", 30_000);
      const waiting = await gateway.gatewayJson<Status>("/admin/cloud-relay");
      expect(waiting.connect?.verification).toBeUndefined();
      const person = await browser.session();
      await enterConnectCode(person.page, waiting.connect!.connectUrl!, waiting.connect!.code!);
      await createAccountWithPasskey(person.page);
      await connectThisGateway(person.page);
      await finish(gateway);
      expect(verified).toHaveLength(1);
      expect(portal.errors.concat(checker.errors, person.errors)).toEqual([]);
    },
    gatewayBootBudgetMs() + 180_000,
  );

  test(
    "the real CLI prints a browser security link, waits, then links an existing passkey account without operator approval",
    async () => {
      const gateway = await freshGateway();
      const person = await browser.session();
      await createUnlinkedAccount(world, person);
      const run = runCli(world, ["cloud", "connect", "--accept-terms"], {
        OMNESIS_CONFIG_DIR: join(directory, "cli-public"),
        OMNESIS_GATEWAY_URL: gateway.gatewayUrl,
        OMNESIS_TOKEN: gateway.apiKey,
      });
      const url = await waitFor(
        () => /Open (https:\/\/\S+\/_dns\/v2\/enroll\?ticket=\S+)/.exec(run.stdout())?.[1],
        "CLI security check link",
        60_000,
      );
      expect(new URL(url).origin).toBe(brokerUrl);
      expect(run.stdout()).not.toContain("and enter");
      const checker = await securityBrowser();
      await checker.page.goto(url);
      await expectText(checker.page, "Verified. Return to Omnesis", 30_000);
      const printed = await waitFor(
        () => {
          const match = /visit (\S+)\nand enter ([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(run.stdout());
          return match ? { url: match[1]!, code: match[2]! } : undefined;
        },
        "CLI account sign-in code",
        60_000,
      );
      await enterConnectCode(person.page, printed.url, printed.code);
      await clickFirst(person.page, ["Sign in with Passkey"]);
      await connectThisGateway(person.page);
      expect(await run.exit).toBe(0);
      expect(run.stdout()).toContain("No approval from Omnesis is needed");
      expect(run.stdout()).toContain("Connected to your Omnesis account.");
      await finish(gateway);
      expect(verified).toHaveLength(2);
      expect(checker.errors.concat(person.errors)).toEqual([]);
      expect(claims.every((claim) => claim.hostname.endsWith(`.${RELAY_DOMAIN}`))).toBe(true);
    },
    gatewayBootBudgetMs() + 180_000,
  );
});

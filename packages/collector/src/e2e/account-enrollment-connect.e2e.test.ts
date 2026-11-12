// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Connecting a gateway by sign-in (docs/device-enrollment.md § Connecting a
 * gateway), end to end: a real relay daemon with account sign-in, real
 * gateways tunnelled through it, the real `omnesis cloud connect`, and a
 * headless Chromium signing in with a virtual passkey after typing the code
 * the gateway shows. An account is created only where the person chose to
 * create one; signing in never makes one, and the connection goes on by
 * itself once the sign-in is done.
 *
 * The gateways here already hold a relay registration when they connect (the
 * relay routes their tunnel with it), so these cases cover the sign-in, the
 * relay's signup policy and the account link with its one trusted sign-in. A
 * from-scratch connect that also obtains a public certificate needs an ACME
 * authority and DNS provider and is covered by the cloud-relay package's
 * integration tests.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { authorizeAccountDesktop, pairAccountDevice } from "@omnesis/cloud-relay";
import { localAcmeAuthority } from "../../../cloud-relay/test/acme-authority.js";
import {
  CREATE_ACCOUNT_HEADING,
  EnrollmentGateway,
  EnrollmentWorld,
  PasskeyBrowser,
  SIGN_IN_HEADING,
  browserSuiteAvailable,
  clickFirst,
  connectGatewayBySignIn,
  createAccountWithPasskey,
  createUnlinkedAccount,
  enterConnectCode,
  expectPasskeySignInRefused,
  expectText,
  finishedConnect,
  passkeyIds,
  runCli,
  signedInAccount,
  waitFor,
  SCT_EXTENSION_LINE,
  servedCertificate,
  signInOnThisMachine,
  type CloudRelayStatus,
  type DeviceRow,
  type EnrollmentGateway as Gateway,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import { E2EHarness } from "./harness.js";

/** The issuer name the local ACME fixture puts on its certificates. */
const FIXTURE_ACME_ISSUER = ["Fictional", "ACME", "Test", "Authority"].join(" ");

const browserReady = browserSuiteAvailable("account-enrollment-connect.e2e");

describe.skipIf(!browserReady)("connect a gateway by signing in", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  const gateways: Gateway[] = [];
  let allowed: { session: PasskeySession; accountId: string };
  let refused: { session: PasskeySession; accountId: string };
  /** A gateway linked to an account it created, and the browser holding that account's passkey. */
  let switched: { gateway: Gateway; session: PasskeySession; accountId: string };

  /** The real `omnesis cloud connect`, run against a gateway with its admin token and no terminal. */
  function cloudConnect(gateway: Gateway, args: string[]) {
    return runCli(world, ["cloud", "connect", "--accept-terms", ...args], {
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_CONFIG_DIR: join(directory, `cli-${gateway.gatewayId}`),
      OMNESIS_GATEWAY_URL: gateway.harness.gatewayUrl,
      OMNESIS_TOKEN: gateway.harness.apiKey,
    });
  }

  async function printedGatewayCode(run: ReturnType<typeof cloudConnect>) {
    return waitFor(
      () => {
        const match = /visit (\S+)\nand enter ([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(run.stdout());
        if (match) return { connectUrl: match[1]!, code: match[2]! };
        if (run.proc.exitCode !== null)
          throw new Error(
            `cloud connect exited ${run.proc.exitCode}: ${run.stdout()}\n${run.stderr()}`,
          );
        return undefined;
      },
      "cloud connect to print its code",
      60_000,
    );
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-connect-"));
    world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
    browser = await PasskeyBrowser.launch(world);
  }, gatewayBootBudgetMs() + 60_000);

  afterAll(async () => {
    try {
      await browser?.close();
      for (const gateway of gateways) await gateway.close().catch(() => undefined);
      await world?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test(
    "a brand-new gateway with only the flag, a relay URL and a certificate directory connects from its portal all the way, and a device then joins automatically",
    async () => {
      // A private ACME directory the gateway is told about, as an operator would
      // name a staging or private CA. Its leaves carry an embedded SCT list.
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
      // The gateway's own outbound checks trust both fixture authorities.
      const bundle = join(directory, "gateway-trust.pem");
      await writeFile(bundle, world.pki.caCert + authority.root);
      // Nothing but the opt-in, the relay and the directory: no gateway id,
      // session, owner key, invitation or certificate.
      const fresh = new E2EHarness({
        extraGatewayEnv: {
          ...world.clientEnv({ NODE_EXTRA_CA_CERTS: bundle }),
          OMNESIS_CLOUD_RELAY_ENABLED: "1",
          OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
          OMNESIS_ACME_DIRECTORY_URL: authority.directoryUrl,
          OMNESIS_ACME_CA_FILE: acmeRoot,
          // Certificate transparency polling would reach a public log service.
          OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
        },
      });
      const priorCa = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
      try {
        await fresh.start();
        const health = await fetch(`${fresh.gatewayUrl}/health`);
        expect(health.status).toBe(200);
        const before = await fresh.gatewayJson<CloudRelayStatus & Record<string, unknown>>(
          "/admin/cloud-relay",
        );
        expect(before).toMatchObject({
          configured: false,
          enabled: false,
          serviceConfigured: true,
          config: { relayUrl: world.relayOrigin, acmeDirectoryUrl: authority.directoryUrl },
        });
        // Let's Encrypt's terms are shown only for Let's Encrypt.
        expect((before.config as { acmeTermsUrl?: string }).acmeTermsUrl).toBeUndefined();
        expect(before.connect).toBeUndefined();

        // The portal's Omnesis account page offers to create an account or use one, and
        // choosing to create starts the sign-in.
        const session = await browser.session();
        const page = session.page;
        await page.goto(`${fresh.gatewayUrl}/portal/?token=${encodeURIComponent(fresh.apiKey)}`);
        await page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
        await page.goto(`${fresh.gatewayUrl}/portal/settings/account`);
        await expectText(page, "Enroll this gateway in your Omnesis Account", 30_000);
        expect(await page.getByRole("button", { name: "Connect", exact: true }).count()).toBe(0);
        await page.getByRole("button", { name: "I already have one", exact: true }).waitFor();
        await page.getByRole("button", { name: "Create an Omnesis account", exact: true }).click();
        await expectText(page, "Sign in to your Omnesis account", 30_000);

        const waiting = await fresh.gatewayJson<CloudRelayStatus & { hostname?: string }>(
          "/admin/cloud-relay",
        );
        expect(waiting.connect).toMatchObject({ state: "waiting" });
        expect(waiting.connect!.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
        expect(new URL(waiting.connect!.connectUrl!).origin).toBe(world.relayOrigin);
        await expectText(page, waiting.connect!.code!, 30_000);
        hostname = waiting.hostname;
        expect(hostname).toMatch(/^g-[a-z2-7]{8}\.relay\.example\.test$/);

        // A person types the code at the relay and lands on the page for creating an account,
        // as chosen in the portal. Making the account is the decision: nothing else to press.
        const person = await browser.session();
        await enterConnectCode(person.page, waiting.connect!.connectUrl!, waiting.connect!.code!);
        await createAccountWithPasskey(person.page);
        await expectText(person.page, "You're all set");

        // The gateway registers, obtains its certificate over DNS-01 through the
        // relay, brings its tunnel up and links the account.
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
        expect(done.connect).toMatchObject({ state: "done" });
        expect(done).toMatchObject({
          enabled: true,
          configured: true,
          hostname,
          enrollment: { state: "enrolled" },
          tunnel: { state: "online" },
          certificate: { state: "valid" },
          account: { linked: true },
          deviceEnrollment: { policy: "automatic" },
        });
        expect(done.deviceEnrollment).not.toHaveProperty("chosen");
        expect(done.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
          await passkeyIds(person),
        );
        await expectText(page, `Connected as ${hostname}`, 30_000);
        // Nothing to choose first: the settings are all there, with automatic joining selected.
        await expectText(page, "What happens when a new device signs in", 30_000);
        expect(await page.getByRole("radio", { name: /^Join automatically/ }).isChecked()).toBe(
          true,
        );
        expect(await page.getByRole("radio", { name: /^Ask me first/ }).isChecked()).toBe(false);
        expect(await page.getByRole("button", { name: "Continue", exact: true }).count()).toBe(0);
        await expectText(page, "This gateway is linked to your Omnesis account.", 30_000);
        // The address answers once no hint is left under it.
        await page.locator(".relay-address").waitFor({ timeout: 30_000 });
        await expect
          .poll(() => page.locator(".relay-address + .relay-hint").count(), { timeout: 30_000 })
          .toBe(0);

        // What the relay serves for that name is the certificate the directory issued.
        const served = await servedCertificate(world, hostname!, authority.root);
        expect(served.issuer).toContain(FIXTURE_ACME_ISSUER);
        expect(served.subjectAltName).toBe(`DNS:${hostname}`);

        // Nobody chose a policy: a CLI joins through the relay with no comparison.
        process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = acmeRoot;
        const comparisons: string[] = [];
        let launched!: (url: string) => void;
        const launchUrl = new Promise<string>((resolve) => (launched = resolve));
        const pairing = pairAccountDevice(
          {
            kind: "cli",
            name: "Fictional hallway CLI",
            relayUrl: world.relayOrigin,
            deviceKeyFile: join(directory, "fresh-cli", "device.key"),
            signal: AbortSignal.timeout(120_000),
            selectGateway: async () => {
              throw new Error("One linked gateway needs no chooser");
            },
            confirm: async (value) => {
              comparisons.push(value.verificationCode);
              return true;
            },
          },
          {
            authorize: (input, dependencies) =>
              authorizeAccountDesktop(input, {
                ...dependencies,
                // The CLI's browser is this machine's browser: the person's own.
                openBrowser: async (url) => launched(url),
              }),
          },
        );
        pairing.catch(() => undefined);
        await signInOnThisMachine(
          person,
          await Promise.race([
            launchUrl,
            pairing.then(() => {
              throw new Error("Paired before anyone signed in");
            }),
          ]),
        );
        // A held request would mean the gateway did not trust this join; say why.
        const held = waitFor(
          async () =>
            (
              await fresh.gatewayJson<{ items: Array<{ name: string; status: string }> }>(
                "/admin/cloud-pairing/requests",
              )
            ).items.find(
              (request) => request.name === "Fictional hallway CLI" && request.status === "pending",
            ),
          "a held request",
          120_000,
        ).then((request) => {
          throw new Error(
            `The join was held instead of automatic: ${JSON.stringify(request)}; comparisons ${JSON.stringify(comparisons)}`,
          );
        });
        held.catch(() => undefined);
        const joined = await Promise.race([pairing, held]);
        expect(comparisons).toEqual([]);
        expect(joined.gatewayUrl).toBe(done.publicOrigin);
        expect(joined.gatewayCertificate.trim()).toBe(served.pem.trim());
        const row = (await fresh.gatewayJson<{ items: DeviceRow[] }>("/admin/devices")).items.find(
          (device) => device.id === joined.deviceId,
        );
        expect(row).toMatchObject({ kind: "cli", name: "Fictional hallway CLI" });
        expect(row?.enrollment).toMatchObject({ method: "automatic", signIn: "passkey" });
        expect(session.errors).toEqual([]);
        expect(person.errors).toEqual([]);
      } finally {
        if (priorCa === undefined) delete process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
        else process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = priorCa;
        await fresh.destroy();
        await authority.close();
      }
    },
    gatewayBootBudgetMs() + 240_000,
  );

  test(
    "open signup: the code the gateway shows leads to a new passkey account, and the gateway ends linked with that sign-in pinned and joining automatically until the owner asks to approve",
    async () => {
      const gateway = await EnrollmentGateway.start(world, "open");
      gateways.push(gateway);
      const before = await gateway.status();
      expect(before.account.linked).toBe(false);
      expect(before.deviceEnrollment.trustedSignIns).toEqual([]);

      const session = await browser.session();
      const done = await connectGatewayBySignIn(gateway, session, "create");
      expect(done.connect).toMatchObject({ state: "done" });
      expect(done.enrollment.state).toBe("enrolled");
      expect(done.tunnel.state).toBe("online");
      expect(done.account.linked).toBe(true);
      expect(done.deviceEnrollment).toMatchObject({ policy: "automatic" });
      expect(done.deviceEnrollment.trustedSignIns).toHaveLength(1);
      expect(done.deviceEnrollment.trustedSignIns[0]!.type).toBe("passkey");
      // The pinned credential is the one this browser's authenticator holds.
      expect(done.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
        await passkeyIds(session),
      );

      const asking = await gateway.setPolicy("ask");
      expect(asking.deviceEnrollment).toMatchObject({ policy: "ask" });
      expect(asking.deviceEnrollment.trustedSignIns).toHaveLength(1);
      expect(session.errors).toEqual([]);
    },
    gatewayBootBudgetMs() + 120_000,
  );

  test(
    "I already have one: the sign-in page creates nothing by itself, offers to create an account instead, and the account made there links the gateway",
    async () => {
      const gateway = await EnrollmentGateway.start(world, "switch");
      gateways.push(gateway);
      const started = await gateway.connect("existing");
      expect(started.connect).toMatchObject({ state: "waiting" });
      const session = await browser.session();
      const page = session.page;
      await enterConnectCode(page, started.connect!.connectUrl!, started.connect!.code!);
      // The sign-in view: the two ways to sign in, and no way to create an account on it.
      await page.getByRole("heading", { name: SIGN_IN_HEADING, exact: true }).waitFor();
      await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Create with a passkey" }).count()).toBe(0);
      // The relay refuses to make an account while the person is on this view.
      const refusedCreation = await page.evaluate(async () => {
        const response = await fetch(
          `/_relay/account/api/passkeys/register/options${window.location.search}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ createAccount: true, label: "Fictional passkey" }),
          },
        );
        return response.status;
      });
      expect(refusedCreation).toBe(403);
      // The person has no account after all, and says so.
      await clickFirst(page, ["Create an account instead"]);
      await page.getByRole("heading", { name: CREATE_ACCOUNT_HEADING, exact: true }).waitFor();
      // The choice goes both ways.
      await clickFirst(page, ["I already have an account"]);
      await page.getByRole("heading", { name: SIGN_IN_HEADING, exact: true }).waitFor();
      await clickFirst(page, ["Create an account instead"]);
      await createAccountWithPasskey(page);
      await expectText(page, "You're all set");

      const done = await finishedConnect(gateway);
      expect(done.connect).toMatchObject({ state: "done" });
      expect(done.account.linked).toBe(true);
      expect(done.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
        await passkeyIds(session),
      );
      expect(session.errors).toEqual([]);
      switched = {
        gateway,
        session,
        accountId: (await signedInAccount(world, session)).accountId,
      };
    },
    gatewayBootBudgetMs() + 120_000,
  );

  test("starting over: an unlinked gateway creates a different account, and the account it created before is gone with its sign-in", async () => {
    const { gateway, session: former } = switched;
    await gateway.unlinkAccount();
    expect((await gateway.status()).deviceEnrollment.trustedSignIns).toEqual([]);

    const session = await browser.session();
    const done = await connectGatewayBySignIn(gateway, session, "create");
    expect(done.connect).toMatchObject({ state: "done" });
    expect(done.account.linked).toBe(true);
    expect(done.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
      await passkeyIds(session),
    );
    const created = (await signedInAccount(world, session)).accountId;
    expect(created).not.toBe(switched.accountId);

    // The earlier account had no gateway left, so it made way: its session is over and
    // its passkey signs in to nothing.
    const page = former.page;
    await page.goto(`${world.relayOrigin}/_relay/account`);
    await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).waitFor();
    expect(await page.getByRole("heading", { name: "Sign-in methods" }).count()).toBe(0);
    await expectPasskeySignInRefused(former);
    // A reload still shows the signed-out page: the relay holds no session for it.
    await page.reload();
    await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).waitFor();
    // The new account is untouched by that attempt.
    expect((await gateway.status()).account.linked).toBe(true);
    expect(session.errors).toEqual([]);
  }, 180_000);

  test(
    "allowlist signup: an account not on the list ends failed not-allowed with nothing linked or pinned",
    async () => {
      // Two passkey accounts exist before the relay starts limiting signups.
      const allowedSession = await browser.session();
      allowed = {
        session: allowedSession,
        accountId: await createUnlinkedAccount(world, allowedSession),
      };
      const refusedSession = await browser.session();
      refused = {
        session: refusedSession,
        accountId: await createUnlinkedAccount(world, refusedSession),
      };
      expect(allowed.accountId).not.toBe(refused.accountId);
      await world.stopRelay();
      await world.setAllowlist({ accounts: [allowed.accountId] });
      await world.startRelay({ signupPolicy: "allowlist" });

      const gateway = await EnrollmentGateway.start(world, "allowlist");
      gateways.push(gateway);
      const run = cloudConnect(gateway, []);
      const printed = await printedGatewayCode(run);
      await enterConnectCode(refused.session.page, printed.connectUrl, printed.code);
      await clickFirst(refused.session.page, ["Sign in with Passkey"]);
      await expectText(
        refused.session.page,
        "This service isn't accepting your Omnesis account yet.",
      );
      expect(await run.exit).not.toBe(0);
      expect(run.stderr() + run.stdout()).toContain("not-allowed");

      const status = await gateway.status();
      expect(status.connect).toMatchObject({ state: "failed", error: "not-allowed" });
      expect(status.account.linked).toBe(false);
      // Not linked, so nothing joins automatically.
      expect(status.deviceEnrollment).toMatchObject({ policy: "ask", trustedSignIns: [] });
      expect((await signedInAccount(world, refused.session)).accountId).toBe(refused.accountId);
    },
    gatewayBootBudgetMs() + 180_000,
  );

  test("allowlist signup: a listed account connects through the real CLI, which pins its sign-in and records the owner's choice to approve each device", async () => {
    const gateway = gateways.at(-1)!;
    const run = cloudConnect(gateway, ["--ask-first"]);
    const printed = await printedGatewayCode(run);
    await enterConnectCode(allowed.session.page, printed.connectUrl, printed.code);
    // The CLI connects to an account the person already has; signing in is all it takes.
    await allowed.session.page
      .getByRole("heading", { name: SIGN_IN_HEADING, exact: true })
      .waitFor();
    await clickFirst(allowed.session.page, ["Sign in with Passkey"]);
    await expectText(allowed.session.page, "You're all set");
    expect(await run.exit).toBe(0);
    expect(run.stdout()).toContain("Connected to your Omnesis account.");
    expect(run.stdout()).toContain("New devices will wait for your approval.");

    const status = await gateway.status();
    expect(status.connect).toMatchObject({ state: "done" });
    expect(status.account.linked).toBe(true);
    expect(status.tunnel.state).toBe("online");
    expect(status.deviceEnrollment).toMatchObject({ policy: "ask" });
    expect(status.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
      await passkeyIds(allowed.session),
    );
    // The first gateway's link survived the relay restart and policy change.
    expect((await gateways[0]!.status()).account.linked).toBe(true);
  }, 180_000);
});

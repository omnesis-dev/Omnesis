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

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  authorizeAccountDesktop,
  hostedGatewayHostname,
  pairAccountDevice,
} from "@omnesis/cloud-relay";
import { localAcmeAuthority } from "../../../cloud-relay/test/acme-authority.js";
import { closeEnrollmentFixture } from "./enrollment-fixture-cleanup.js";
import {
  CREATE_ACCOUNT_HEADING,
  EnrollmentGateway,
  EnrollmentWorld,
  PasskeyBrowser,
  SIGN_IN_HEADING,
  browserSuiteAvailable,
  clickFirst,
  connectGatewayBySignIn,
  connectThisGateway,
  createAccountWithPasskey,
  createUnlinkedAccount,
  enterConnectCode,
  expectPasskeySignInRefused,
  expectText,
  finishedConnect,
  pageAuthenticator,
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
  const gateways = new Set<Gateway>();
  const sharedGateways = new Set<Gateway>();
  let originalGateway: Gateway;
  /** A gateway linked to an account it created, and the browser holding that account's passkey. */
  let switched: { gateway: Gateway; session: PasskeySession; accountId: string };
  /** An account made before the relay became invite-only, and the browser holding its passkey. */
  let inviteOnly: { session: PasskeySession; accountId: string };

  /** The real `omnesis cloud …`, run against a gateway with its admin token and no terminal. */
  function cloud(harness: E2EHarness, args: string[]) {
    return runCli(world, ["cloud", ...args], {
      OMNESIS_CONFIG_DIR: join(directory, `cli-${harness.gatewayUrl.replace(/\W+/g, "-")}`),
      OMNESIS_GATEWAY_URL: harness.gatewayUrl,
      OMNESIS_TOKEN: harness.apiKey,
    });
  }
  /** The real `omnesis cloud connect`, unattended: every choice is a flag. */
  function cloudConnect(gateway: Gateway, args: string[]) {
    return cloud(gateway.harness, ["connect", ...args]);
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

  // Each gateway owns full runtime worker pools. Keep only the fixtures that a
  // later case still needs; independent cases must not accumulate live gateways.
  afterEach(async () => {
    await closeEnrollmentFixture(
      undefined,
      [...gateways]
        .filter((gateway) => !sharedGateways.has(gateway))
        .map((gateway) => async () => {
          await gateway.close();
          gateways.delete(gateway);
        }),
    );
  }, 60_000);

  afterAll(async () => {
    await closeEnrollmentFixture(world ? directory : undefined, [
      () => browser?.close(),
      ...[...gateways].map((gateway) => () => gateway.close()),
      () => world?.close(),
    ]);
  }, 60_000);

  test(
    "a brand-new gateway with only a relay URL and a certificate directory connects from its portal all the way, and a device that signs in on the relay's page is held until the owner approves it",
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
      // Nothing but the relay and the directory: no gateway id,
      // session, owner key, invitation or certificate.
      const fresh = new E2EHarness({
        extraGatewayEnv: {
          ...world.clientEnv({ NODE_EXTRA_CA_CERTS: bundle }),
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
        await expectText(page, "Do you want an Omnesis account?", 30_000);
        expect(await page.getByRole("button", { name: "Connect", exact: true }).count()).toBe(0);
        await page.getByRole("button", { name: "I already have one", exact: true }).waitFor();
        await page.getByRole("button", { name: "Create an account", exact: true }).click();
        await expectText(page, "Create your Omnesis account", 30_000);

        const waiting = await fresh.gatewayJson<CloudRelayStatus & { hostname?: string }>(
          "/admin/cloud-relay",
        );
        expect(waiting.connect).toMatchObject({ state: "waiting" });
        expect(waiting.connect!.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
        expect(new URL(waiting.connect!.connectUrl!).origin).toBe(world.relayOrigin);
        await expectText(page, waiting.connect!.code!, 30_000);
        // The name it reserved is offered nowhere until the relay has registered the gateway.
        expect(waiting.hostname).toBeUndefined();
        expect(waiting.publicMcp.url).toBeUndefined();
        hostname = hostedGatewayHostname(waiting.gatewayId!, new URL(world.relayOrigin).hostname);
        expect(hostname).toMatch(/^g-[a-z2-7]{8}\.relay\.example\.test$/);

        // A person types the code at the relay and lands on the page for creating an account,
        // as chosen in the portal, makes the account and presses to connect the gateway.
        const person = await browser.session();
        await enterConnectCode(person.page, waiting.connect!.connectUrl!, waiting.connect!.code!);
        await createAccountWithPasskey(person.page);
        await connectThisGateway(person.page);

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
          // Linked, with the link page's passkey only a suggestion until it is confirmed here.
          deviceEnrollment: { policy: "automatic", confirmationNeeded: true, confirmedSignIns: [] },
        });
        expect(done.deviceEnrollment).not.toHaveProperty("chosen");
        expect(done.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
          await passkeyIds(person),
        );
        // Nothing is confirmed here yet, so the setup checklist stands in for the headline, and
        // its last step uses the account's passkey: the portal opens the gateway's own address,
        // signed in, to run it there.
        await waitFor(
          () => new URL(page.url()).hostname === hostname,
          "the portal to open the gateway's own address",
          30_000,
        );
        await expectText(page, "Finish setting up", 30_000);
        await expectText(page, "Let your passkey add devices", 30_000);
        // Nothing to choose first: the account is there at once, and what new devices may do
        // is chosen once for every way in, under Settings → Connectivity.
        expect(await page.getByRole("button", { name: "Continue", exact: true }).count()).toBe(0);
        await expectText(page, "This gateway is linked to your Omnesis account.", 30_000);
        // The relay's page shows its address, which answers once no hint is left under it.
        await page.goto(new URL("/portal/settings/relay", page.url()).href);
        await page.locator(".relay-address").waitFor({ timeout: 30_000 });
        await expect
          .poll(() => page.locator(".relay-address + .relay-hint").count(), { timeout: 30_000 })
          .toBe(0);

        // What the relay serves for that name is the certificate the directory issued.
        const served = await servedCertificate(world, hostname!, authority.root);
        expect(served.issuer).toContain(FIXTURE_ACME_ISSUER);
        expect(served.subjectAltName).toBe(`DNS:${hostname}`);

        // TM-01: nobody chose a policy, yet a CLI whose sign-in was made on the relay's page is
        // held for the owner, who compares its code and approves it.
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
        const held = await waitFor(
          async () =>
            (
              await fresh.gatewayJson<{
                items: Array<{
                  requestId: string;
                  name: string;
                  status: string;
                  canTrustSignIn: boolean;
                  verificationCode: string;
                }>;
              }>("/admin/cloud-pairing/requests")
            ).items.find(
              (request) => request.name === "Fictional hallway CLI" && request.status === "pending",
            ),
          "the held request",
          120_000,
        );
        expect(held).toMatchObject({ canTrustSignIn: false });
        await waitFor(() => comparisons.length === 1, "the device to show its comparison code");
        expect(comparisons).toEqual([held.verificationCode]);
        await fresh.gatewayJson("/admin/cloud-pairing/decision", {
          method: "POST",
          body: JSON.stringify({ requestId: held.requestId, approve: true }),
        });
        const joined = await pairing;
        expect(joined.gatewayUrl).toBe(done.publicOrigin);
        expect(joined.gatewayCertificate.trim()).toBe(served.pem.trim());
        const row = (await fresh.gatewayJson<{ items: DeviceRow[] }>("/admin/devices")).items.find(
          (device) => device.id === joined.deviceId,
        );
        expect(row).toMatchObject({ kind: "cli", name: "Fictional hallway CLI" });
        expect(row?.enrollment).toMatchObject({ method: "approved", signIn: "passkey" });
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
    "open signup: the code the gateway shows leads to a new passkey account, and the gateway ends linked with that sign-in pinned as a suggestion, waiting for the owner to confirm it",
    async () => {
      const gateway = await EnrollmentGateway.start(world, "open");
      gateways.add(gateway);
      const before = await gateway.status();
      expect(before.account.linked).toBe(false);
      expect(before.deviceEnrollment.trustedSignIns).toEqual([]);

      const session = await browser.session();
      const done = await connectGatewayBySignIn(gateway, session, "create");
      expect(done.connect).toMatchObject({ state: "done" });
      expect(done.enrollment.state).toBe("enrolled");
      expect(done.tunnel.state).toBe("online");
      expect(done.account.linked).toBe(true);
      expect(done.deviceEnrollment).toMatchObject({
        policy: "automatic",
        confirmationNeeded: true,
        confirmOrigin: gateway.publicOrigin,
      });
      expect(done.deviceEnrollment.trustedSignIns).toHaveLength(1);
      expect(done.deviceEnrollment.trustedSignIns[0]).toMatchObject({ confirmed: false });
      expect(done.deviceEnrollment.trustedSignIns[0]!.type).toBe("passkey");
      // The pinned credential is the one this browser's authenticator holds.
      expect(done.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
        await passkeyIds(session),
      );

      const asking = await gateway.setPolicy("ask");
      expect(asking.deviceEnrollment).toMatchObject({ policy: "ask" });
      expect(asking.deviceEnrollment.trustedSignIns).toHaveLength(1);
      expect(session.errors).toEqual([]);
      originalGateway = gateway;
      sharedGateways.add(gateway);
    },
    gatewayBootBudgetMs() + 120_000,
  );

  test(
    "I already have one: the sign-in page creates nothing by itself, offers to create an account instead, and the account made there links the gateway",
    async () => {
      const gateway = await EnrollmentGateway.start(world, "switch");
      gateways.add(gateway);
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
      await connectThisGateway(page);

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
      sharedGateways.add(gateway);
    },
    gatewayBootBudgetMs() + 120_000,
  );

  test("starting over: an unlinked gateway creates a different account, and the account it created before is gone with its sign-in", async () => {
    const { gateway, session: former } = switched;
    sharedGateways.delete(gateway);
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
    "invite signup: an account with no gateway connects through the real CLI without an invite, which pins its sign-in and records the owner's choice to approve each device",
    async () => {
      sharedGateways.delete(originalGateway);
      // A passkey account exists, with no gateway, before the relay becomes invite-only.
      const session = await browser.session();
      const existing = { session, accountId: await createUnlinkedAccount(world, session) };
      await world.stopRelay();
      await world.startRelay({ signupPolicy: "invite" });

      const gateway = await EnrollmentGateway.start(world, "invite-only");
      gateways.add(gateway);
      // `--accept-terms` is still accepted from older scripts, and changes nothing.
      const run = cloudConnect(gateway, ["--existing", "--ask-first", "--accept-terms"]);
      const printed = await printedGatewayCode(run);
      await enterConnectCode(existing.session.page, printed.connectUrl, printed.code);
      // The CLI connects to an account the person already has: sign in, then connect.
      await existing.session.page
        .getByRole("heading", { name: SIGN_IN_HEADING, exact: true })
        .waitFor();
      await clickFirst(existing.session.page, ["Sign in with Passkey"]);
      await connectThisGateway(existing.session.page);
      expect(await run.exit).toBe(0);
      // A line for each step it saw, in order, then where the gateway is.
      const output = run.stdout();
      const lines = [
        "Waiting for you to sign in to your Omnesis account…",
        "Signed in.",
        "Connected to your Omnesis account.",
        `  Address: ${gateway.publicOrigin}`,
        `  Portal:  ${gateway.publicOrigin}/portal/`,
        `  MCP:     ${gateway.publicOrigin}/mcp`,
        "New devices will wait for your approval.",
      ];
      for (const line of lines) expect(output).toContain(line);
      expect(lines.map((line) => output.indexOf(line))).toEqual(
        lines.map((line) => output.indexOf(line)).sort((a, b) => a - b),
      );
      expect(output).not.toContain("Do you already have an Omnesis account?");
      expect(output).not.toContain("Your invite wasn't used");

      const status = await gateway.status();
      expect(status.connect).toMatchObject({ state: "done" });
      expect(status.account.linked).toBe(true);
      expect(status.tunnel.state).toBe("online");
      expect(status.deviceEnrollment).toMatchObject({ policy: "ask" });
      expect(status.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual(
        await passkeyIds(existing.session),
      );
      expect((await signedInAccount(world, existing.session)).accountId).toBe(existing.accountId);
      // The first gateway's link survived the relay restart and policy change.
      expect((await originalGateway.status()).account.linked).toBe(true);

      // Connecting a linked gateway again is refused before any sign-in starts.
      const again = cloudConnect(gateway, ["--existing"]);
      expect(await again.exit).not.toBe(0);
      expect(again.stderr()).toContain(
        "This gateway is already connected to an Omnesis account. To connect it to another, run `omnesis cloud unlink` first.",
      );
      expect(await gateway.status()).toMatchObject({
        connect: { state: "done" },
        account: { linked: true },
      });
      // The gateway refuses it as well, whatever asks.
      const refused = await fetch(`${gateway.harness.gatewayUrl}/admin/cloud-relay/connect`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gateway.harness.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ termsAccepted: true, intent: "existing" }),
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "already-connected" });
      inviteOnly = existing;
    },
    gatewayBootBudgetMs() + 180_000,
  );

  test(
    "without a terminal, the CLI names both flags and starts nothing; a chosen new account that already existed is said, and the invite stays unused",
    async () => {
      const gateway = await EnrollmentGateway.start(world, "invite-existing");
      gateways.add(gateway);
      const before = await gateway.status();
      const unattended = cloudConnect(gateway, []);
      expect(await unattended.exit).not.toBe(0);
      expect(unattended.stderr()).toContain("--existing");
      expect(unattended.stderr()).toContain("--invite");
      const after = await gateway.status();
      expect(after.connect).toBeUndefined();
      expect(after.gatewayId).toBe(before.gatewayId);

      // The owner brings an invite to create an account, but signs in with the one they have.
      const invite = world.invite();
      const run = cloudConnect(gateway, ["--invite", invite]);
      const printed = await printedGatewayCode(run);
      expect(run.stdout()).toContain("Waiting for you to create your Omnesis account…");
      const page = inviteOnly.session.page;
      await enterConnectCode(page, printed.connectUrl, printed.code);
      await page.getByRole("heading", { name: CREATE_ACCOUNT_HEADING, exact: true }).waitFor();
      await clickFirst(page, ["I already have an account"]);
      await page.getByRole("heading", { name: SIGN_IN_HEADING, exact: true }).waitFor();
      await clickFirst(page, ["Sign in with Passkey"]);
      await connectThisGateway(page);
      expect(await run.exit).toBe(0);
      expect(run.stdout()).toContain(
        "Connected to your Omnesis account.\nYou already had an Omnesis account, so this gateway is now linked to it. Your invite wasn't used.\n",
      );
      // Said by the CLI, so the gateway's status no longer says it: the portal won't again.
      expect((await gateway.status()).connect).toEqual({ state: "done", intent: "create" });
      expect((await signedInAccount(world, inviteOnly.session)).accountId).toBe(
        inviteOnly.accountId,
      );
      // The invite can still create an account.
      const checked = await fetch(`${world.relayOrigin}/_relay/v3/signup/invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: invite.slice(invite.indexOf("#") + 1) }),
      });
      expect(await checked.json()).toMatchObject({ status: "valid" });
    },
    gatewayBootBudgetMs() + 180_000,
  );

  test(
    "a connect left waiting and run again with an invite starts again with it, and says the invite went unused when an existing account signs in",
    async () => {
      const gateway = await EnrollmentGateway.start(world, "invite-after-existing");
      gateways.add(gateway);
      // The owner starts signing in to an account they have, then closes the terminal.
      const first = cloudConnect(gateway, ["--existing"]);
      await printedGatewayCode(first);
      first.proc.kill("SIGTERM");
      await first.exit.catch(() => undefined);
      expect((await gateway.status()).connect).toMatchObject({
        state: "waiting",
        intent: "existing",
      });
      // Run again to create an account with an invite, it starts a sign-up that carries it.
      const invite = world.invite();
      const run = cloudConnect(gateway, ["--invite", invite]);
      const printed = await printedGatewayCode(run);
      expect(run.stdout()).toContain("Waiting for you to create your Omnesis account…");
      expect((await gateway.status()).connect).toMatchObject({
        state: "waiting",
        intent: "create",
      });
      const page = inviteOnly.session.page;
      await enterConnectCode(page, printed.connectUrl, printed.code);
      // The relay offers to create the account: the sign-up has the invite.
      await page.getByRole("heading", { name: CREATE_ACCOUNT_HEADING, exact: true }).waitFor();
      await page.getByRole("button", { name: "Create with a passkey", exact: true }).waitFor();
      // The owner signs in to the account they have instead, and is told the invite wasn't used.
      await clickFirst(page, ["I already have an account"]);
      await page.getByRole("heading", { name: SIGN_IN_HEADING, exact: true }).waitFor();
      await clickFirst(page, ["Sign in with Passkey"]);
      await connectThisGateway(page);
      expect(await run.exit).toBe(0);
      // The CLI said so, which is the gateway's notice acknowledged.
      expect(run.stdout()).toContain("Your invite wasn't used.");
      expect((await gateway.status()).connect).toMatchObject({ state: "done", intent: "create" });
      const checked = await fetch(`${world.relayOrigin}/_relay/v3/signup/invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: invite.slice(invite.indexOf("#") + 1) }),
      });
      expect(await checked.json()).toMatchObject({ status: "valid" });
    },
    gatewayBootBudgetMs() + 180_000,
  );

  test(
    "a browser already signed in to an account still creates a new one with a passkey from the CLI, which spends the invite",
    async () => {
      const gateway = await EnrollmentGateway.start(world, "invite-passkey");
      gateways.add(gateway);
      const invite = world.invite();
      const run = cloudConnect(gateway, ["--invite", invite]);
      const printed = await printedGatewayCode(run);
      // This browser holds a session for the account that already exists.
      const page = inviteOnly.session.page;
      await enterConnectCode(page, printed.connectUrl, printed.code);
      await page.getByRole("heading", { name: CREATE_ACCOUNT_HEADING, exact: true }).waitFor();
      await clickFirst(page, ["Create with a passkey"]);
      await connectThisGateway(page);
      expect(await run.exit).toBe(0);
      expect(run.stdout()).not.toContain("Your invite wasn't used");
      const status = await gateway.status();
      expect(status.connect).toMatchObject({ state: "done", intent: "create" });
      expect(status.connect).not.toHaveProperty("existingAccount");
      // A new account, now this browser's, and the invite created it.
      const created = (await signedInAccount(world, inviteOnly.session)).accountId;
      expect(created).not.toBe(inviteOnly.accountId);
      const checked = await fetch(`${world.relayOrigin}/_relay/v3/signup/invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: invite.slice(invite.indexOf("#") + 1) }),
      });
      expect(await checked.json()).toMatchObject({ status: "used" });
      // Using it again is refused before anyone signs in.
      const again = await EnrollmentGateway.start(world, "invite-reused");
      gateways.add(again);
      const reused = cloudConnect(again, ["--invite", invite]);
      expect(await reused.exit).not.toBe(0);
      expect(reused.stdout() + reused.stderr()).toContain(
        "The invite was already used to create an account",
      );
      expect((await again.status()).account.linked).toBe(false);
    },
    2 * gatewayBootBudgetMs() + 180_000,
  );

  test(
    "the window a portal opened by script for the sign-in closes itself once the gateway is connected",
    async () => {
      const gateway = await EnrollmentGateway.start(world, "portal-window");
      gateways.add(gateway);
      // Creating an account here takes an invite by now.
      const started = await gateway.connect("create", world.invite());
      expect(started.connect?.state).toBe("waiting");
      // The portal opens its window by script, cuts it off from its own tab, and marks the link.
      const link = new URL(started.connect!.authorizeUrl!);
      link.searchParams.set("window", "portal");
      const session = await browser.session();
      try {
        const [popup] = await Promise.all([
          session.context.waitForEvent("page"),
          session.page.evaluate((url) => {
            const opened = window.open(url, "omnesis-connect");
            if (opened) opened.opener = null;
          }, link.href),
        ]);
        await pageAuthenticator(session, popup);
        await clickFirst(popup, ["Continue"]);
        await popup.getByRole("heading", { name: CREATE_ACCOUNT_HEADING, exact: true }).waitFor();
        await clickFirst(popup, ["Create with a passkey"]);
        const closed = popup.waitForEvent("close", { timeout: 60_000 });
        await clickFirst(popup, ["Connect this gateway"]);
        await closed;
        expect(popup.isClosed()).toBe(true);
        expect((await finishedConnect(gateway)).connect?.state).toBe("done");
      } finally {
        await session.context.close();
      }
    },
    gatewayBootBudgetMs() + 180_000,
  );

  test(
    "a connection that never finished offers its reserved address nowhere, and starting over returns the gateway to never connected",
    async () => {
      const fresh = new E2EHarness({
        extraGatewayEnv: {
          ...world.clientEnv(),
          OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
          // Never reached: a connection that stops before its sign-in asks for no certificate.
          OMNESIS_ACME_DIRECTORY_URL: "https://127.0.0.1:9/directory",
          OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
        },
      });
      try {
        await fresh.start();
        const status = () => fresh.gatewayJson<CloudRelayStatus>("/admin/cloud-relay");
        // The owner starts connecting and stops before signing in.
        const run = cloud(fresh, ["connect", "--existing"]);
        await printedGatewayCode(run);
        run.proc.kill("SIGTERM");
        await run.exit.catch(() => undefined);
        const reserved = await status();
        expect(reserved.connect).toMatchObject({ state: "waiting", intent: "existing" });
        await fresh.gatewayJson("/admin/cloud-relay/connect/cancel", {
          method: "POST",
          body: "{}",
        });
        const unfinished = await status();
        expect(unfinished).toMatchObject({
          configured: true,
          enabled: false,
          gatewayId: reserved.gatewayId,
          unfinished: {},
          can: { startOver: true },
        });
        // Its reserved name is offered nowhere: not in the status, not to an agent.
        expect(unfinished.hostname).toBeUndefined();
        expect(unfinished.publicOrigin).toBeUndefined();
        expect(unfinished.publicMcp.url).toBeUndefined();
        const relayDomain = new URL(world.relayOrigin).hostname;
        const offered = await fresh.gatewayJson<{
          oauth: { resources: { resource: string }[] } | null;
        }>("/admin/access");
        for (const { resource } of offered.oauth?.resources ?? [])
          expect(new URL(resource).hostname.endsWith(`.${relayDomain}`)).toBe(false);
        const remote = await fresh.gatewayJson<{
          mcpAddresses?: { id: string; url: string | null }[];
        }>("/admin/remote-access");
        expect(remote.mcpAddresses?.find((row) => row.id === "relay")?.url ?? null).toBeNull();
        // `omnesis cloud status` says so, with both ways on.
        const shown = cloud(fresh, ["status"]);
        expect(await shown.exit).toBe(0);
        expect(shown.stdout()).toContain(
          "didn't finish, it was interrupted. Run `omnesis cloud connect` to try again, or `omnesis cloud start-over` to discard it",
        );

        const startOver = cloud(fresh, ["start-over"]);
        expect(await startOver.exit).toBe(0);
        expect(startOver.stdout()).toContain("The unfinished connection is discarded.");
        const fromScratch = await status();
        expect(fromScratch).toMatchObject({ configured: false, enabled: false });
        expect(fromScratch.gatewayId).toBeUndefined();
        expect(fromScratch.unfinished).toBeUndefined();
        // Connecting again reserves a new name.
        const next = await fresh.gatewayJson<CloudRelayStatus>("/admin/cloud-relay/connect", {
          method: "POST",
          body: JSON.stringify({ termsAccepted: true, intent: "existing" }),
        });
        expect(next.gatewayId).toBeDefined();
        expect(next.gatewayId).not.toBe(reserved.gatewayId);
        await fresh.gatewayJson("/admin/cloud-relay/connect/cancel", {
          method: "POST",
          body: "{}",
        });
      } finally {
        await fresh.destroy();
      }
    },
    gatewayBootBudgetMs() + 120_000,
  );
});

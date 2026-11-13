// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Each account sign-in is for one purpose (docs/device-enrollment.md § Each
 * sign-in is for one purpose), played end to end by an outsider: a real relay
 * daemon offering Google and passkey sign-in, real gateways tunnelled through
 * it, a headless Chromium holding the owner's passkey, and a local stand-in for
 * Google (`FakeGoogle`).
 *
 * The owner's account was created with Google on "home" and later got a
 * passkey, which home trusts as endorsed. Home joins trusted sign-ins
 * automatically, so a device bringing a proof from either sign-in would join
 * with no approval. The outsider has no account. It makes its own device key,
 * computes that device's enrollment nonce, and starts an operation that links
 * a gateway with that nonce: a gateway sign-up on the relay, or an owner-link
 * from a gateway of its own that it registered with the relay. The owner signs
 * in on that page and presses to connect. The outsider collects the sign-in
 * proof and offers it to home as its device's enrollment sign-in. A sign-in
 * made for linking a gateway never stands in for a device's enrollment, so home
 * refuses it and nothing joins.
 *
 * The link pages wait for the press (F1b), and the owner's enrollment choices
 * outlast the link (F7): ask-first and a declined sign-in on "cabin", a second
 * gateway of the account, survive the owner disconnecting it and linking the
 * same account again, and ask-first survives the relay saying the account was
 * deleted.
 *
 * The scenarios run in order: the last one deletes the account.
 */

import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_SIGNUP_PATH,
  GATEWAY_SIGNUP_PROTOCOL,
  ManagedAccountBrowser,
  enrollmentNonce,
  enrollmentSignatureTranscript,
  gatewaySignupStarted,
  gatewaySignupTranscript,
  signDeviceTranscript,
  tlsSpkiFingerprint,
} from "@omnesis/cloud-relay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  COUNTERSIGN_HEADING,
  ENDORSEMENT_HEADING,
  EnrollmentGateway,
  EnrollmentWorld,
  FakeGoogle,
  GatewayRefused,
  PASSKEY_ADDED,
  PasskeyBrowser,
  browserSuiteAvailable,
  chooseAccountMenu,
  clickFirst,
  createAccountWithPasskey,
  devicePinnedJson,
  enterConnectCode,
  expectText,
  finishedConnect,
  freshAccountSignIn,
  passkeyIds,
  sha256Hex,
  waitFor,
  type CloudRelayStatus,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import type { Page } from "playwright";

const browserReady = browserSuiteAvailable("account-enrollment-sign-in-purpose.e2e");

/** The owner's Google account. Invented. */
const OWNER_GOOGLE = "fictional-purpose-owner-google-subject";
const CONNECT = "Connect this gateway";
const ACCOUNT_CALLBACK = "/admin/cloud-relay/account/callback";

/** A device only the outsider holds, and the enrollment nonce its own request commits to. */
interface OutsiderDevice {
  request: { requestId: string; kind: "cli"; name: string; secret: string };
  devicePublicKey: string;
  privateKey: KeyObject;
  nonce: string;
}

function outsiderDevice(name: string): OutsiderDevice {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const devicePublicKey = key.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const request = {
    requestId: randomUUID(),
    kind: "cli" as const,
    name,
    secret: randomBytes(32).toString("hex"),
  };
  return {
    request,
    devicePublicKey,
    privateKey: key.privateKey,
    nonce: enrollmentNonce({ ...request, devicePublicKey }),
  };
}

/**
 * A gateway sign-up sent straight to the relay from an identity the outsider made up, with the
 * outsider's device nonce as the sign-up's nonce. Returns what the relay started and the poll
 * only that identity can make.
 */
async function outsiderSignup(world: EnrollmentWorld, nonce: string) {
  const owner = generateKeyPairSync("ed25519");
  const issuedAt = Math.floor(Date.now() / 1000);
  const redemptionSecret = randomBytes(32).toString("base64url");
  const unsigned = {
    protocol: GATEWAY_SIGNUP_PROTOCOL,
    operationId: randomUUID(),
    gatewayId: randomUUID(),
    ownerPublicKey: owner.publicKey.export({ format: "pem", type: "spki" }).toString(),
    nonce,
    redemptionSha256: sha256Hex(redemptionSecret),
    issuedAt,
    expiresAt: issuedAt + 300,
  };
  const response = await fetch(`${world.relayOrigin}${GATEWAY_SIGNUP_PATH}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...unsigned,
      ownerSignature: sign(
        null,
        gatewaySignupTranscript(world.relayOrigin, unsigned),
        owner.privateKey,
      ).toString("base64url"),
      intent: "existing",
    }),
  });
  if (!response.ok) throw new Error(`Signup start refused: ${response.status}`);
  const started = gatewaySignupStarted.parse(await response.json());
  const poll = async () =>
    (await (
      await fetch(`${world.relayOrigin}${GATEWAY_SIGNUP_PATH}/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: started.operationId, redemptionSecret }),
      })
    ).json()) as { status: string; signInProof?: unknown };
  return { started, poll };
}

/**
 * Signed in on a page that links a gateway, the owner presses "Connect this gateway", as the
 * outsider hopes they will. That the page waits for the press is asserted on its own (F1b); a
 * page that already went on by itself is not pressed again.
 */
async function connectWhenAsked(page: Page, done: () => boolean | Promise<boolean>) {
  const button = page.getByRole("button", { name: CONNECT, exact: true });
  await waitFor(
    async () => (await done()) || (await button.isVisible().catch(() => false)),
    `the "${CONNECT}" button`,
  );
  if (!(await done())) await button.click({ timeout: 5_000 }).catch(() => undefined);
  await waitFor(done, "the gateway link to go through");
}

const allSet = (page: Page) => () =>
  page
    .getByText("You're all set")
    .first()
    .isVisible()
    .catch(() => false);

describe.skipIf(!browserReady)("a sign-in made to link a gateway never enrolls a device", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  let owner: PasskeySession;
  /** The account's first gateway: Google and the passkey pinned, joining automatically. */
  let home: EnrollmentGateway;
  /** The account's second gateway, linked with the passkey. */
  let cabin: EnrollmentGateway;
  /** Registered with the relay by the outsider, in no account. */
  let outsider: EnrollmentGateway;
  let passkey: string;
  const priorCaFile = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;

  const pins = async (gateway: EnrollmentGateway) =>
    (await gateway.status()).deviceEnrollment.trustedSignIns.map((pin) => ({
      type: pin.type,
      id: pin.id,
      source: pin.source,
    }));

  /** The gateway's own link file, where the owner's choices are kept; undefined once removed. */
  async function linkRecord(gateway: EnrollmentGateway) {
    const { configDir } = gateway.harness as unknown as { configDir: string };
    const text = await readFile(join(configDir, "cloud-relay", "account-link.json"), "utf8").catch(
      () => undefined,
    );
    return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
  }

  /** The gateway shows a code; the owner types it, signs in and presses to connect. */
  async function link(
    gateway: EnrollmentGateway,
    session: PasskeySession,
    intent: "create" | "existing",
    method: "Passkey" | "Google",
  ): Promise<CloudRelayStatus> {
    const started = await gateway.connect(intent);
    if (started.connect?.state !== "waiting")
      throw new Error(`Connect did not start: ${JSON.stringify(started.connect)}`);
    await enterConnectCode(session.page, started.connect.connectUrl!, started.connect.code!);
    if (intent === "create" && method === "Passkey") await createAccountWithPasskey(session.page);
    else if (intent === "create") await clickFirst(session.page, ["Create with Google"]);
    else await clickFirst(session.page, [`Sign in with ${method}`, `Verify with ${method}`]);
    await connectWhenAsked(session.page, allSet(session.page));
    return finishedConnect(gateway);
  }

  /**
   * The outsider offers `proof` to `gateway` as the enrollment sign-in of its own device, the
   * way a device asks to join: a fresh challenge, its key's signature naming the gateway, and
   * the proof. It has no account attestation to add. Returns the gateway's answer or refusal.
   */
  async function offer(gateway: EnrollmentGateway, device: OutsiderDevice, proof: unknown) {
    await gateway.pace(2);
    const target = { publicOrigin: gateway.publicOrigin, certificate: gateway.leaf.cert };
    const { challenge } = (await devicePinnedJson(target, "/devices/account/challenge", {})) as {
      challenge: string;
    };
    return devicePinnedJson(target, "/devices/account/request", {
      ...device.request,
      proof,
      deviceKey: {
        publicKey: device.devicePublicKey,
        challenge,
        signature: signDeviceTranscript(
          device.privateKey,
          enrollmentSignatureTranscript({
            ...device.request,
            gatewaySpkiFingerprint: tlsSpkiFingerprint(gateway.leaf.cert),
            challenge,
            devicePublicKey: device.devicePublicKey,
          }),
        ),
      },
    }).catch((error: unknown) => error);
  }

  /** Refused outright: nothing joined, nothing waits for the owner, the devices are as before. */
  async function expectRefused(
    gateway: EnrollmentGateway,
    device: OutsiderDevice,
    outcome: unknown,
    devicesBefore: string[],
  ) {
    expect(outcome, `the gateway answered ${JSON.stringify(outcome)}`).toBeInstanceOf(
      GatewayRefused,
    );
    // The proof does not verify as a device's enrollment sign-in, and the outsider has no
    // account attestation, so the request is not even held for the owner.
    expect((outcome as GatewayRefused).status).toBe(401);
    expect((await gateway.devices()).map((row) => row.id).sort()).toEqual(devicesBefore);
    expect(
      (await gateway.pendingRequests()).some((request) => request.name === device.request.name),
    ).toBe(false);
  }

  /**
   * The outsider's own registered gateway asks the relay for an owner-link operation, signed
   * with its owner key and carrying the outsider's device nonce, exactly as a gateway's account
   * page would. It holds that gateway's session and key files.
   */
  function outsiderHandoff() {
    const env = {
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
      OMNESIS_CLOUD_RELAY_SESSION_FILE: outsider.sessionFile,
      OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: outsider.ownerKeyFile,
      OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: join(outsider.directory, "invitation.json"),
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: outsider.gatewayId,
      OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: outsider.publicOrigin,
      OMNESIS_TLS_CERT: outsider.leaf.certFile,
      OMNESIS_TLS_KEY: outsider.leaf.keyFile,
    };
    const handoff = new ManagedAccountBrowser({ env: () => env });
    return {
      handoff,
      begin: (nonce: string) =>
        handoff.begin({
          purpose: "owner-link",
          nonce,
          callbackUrl: `${outsider.publicOrigin}${ACCOUNT_CALLBACK}`,
          browserState: randomBytes(32).toString("base64url"),
        }),
    };
  }

  /** Captures the owner's browser being sent back to the outsider's gateway, with its result. */
  async function captureCallback(page: Page) {
    const seen: { url?: URL } = {};
    await page.route(
      (url) => url.pathname === ACCOUNT_CALLBACK,
      (route) => {
        seen.url = new URL(route.request().url());
        return route.fulfill({ status: 200, contentType: "text/html", body: "<p>Done</p>" });
      },
    );
    return seen;
  }

  beforeAll(
    async () => {
      directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-purpose-"));
      world = await EnrollmentWorld.create(directory, { signupPolicy: "open", google: true });
      process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = world.pki.caCertFile;
      browser = await PasskeyBrowser.launch(world);
      owner = await browser.session();
      home = await EnrollmentGateway.start(world, "home");
      cabin = await EnrollmentGateway.start(world, "cabin");
      outsider = await EnrollmentGateway.start(world, "outsider");

      // The account is created with Google on home, which pins that Google account.
      world.google!.signInAs(OWNER_GOOGLE);
      const linked = await link(home, owner, "create", "Google");
      if (linked.connect?.state !== "done")
        throw new Error(`Link failed: ${JSON.stringify(linked.connect)}`);

      // A passkey added on the account page, vouched for by the Google account.
      const page = owner.page;
      await page.goto(`${world.relayOrigin}/_relay/account`);
      await page.getByRole("heading", { name: "Sign-in methods", exact: true }).waitFor();
      await clickFirst(page, ["Add a passkey"]);
      await page.getByRole("heading", { name: COUNTERSIGN_HEADING, exact: true }).waitFor();
      await clickFirst(page, ["Use new passkey"]);
      await page.getByRole("heading", { name: ENDORSEMENT_HEADING, exact: true }).waitFor();
      await clickFirst(page, ["Confirm with Google"]);
      await expectText(page, PASSKEY_ADDED);
      [passkey] = (await passkeyIds(owner)) as [string];
      await home.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
      await waitFor(
        async () => (await pins(home)).some((pin) => pin.id === passkey),
        "home to pin the added passkey",
      );
      await home.setPolicy("automatic");

      // Cabin is linked with the passkey and trusts the Google account on its countersignature.
      const second = await link(cabin, owner, "existing", "Passkey");
      if (second.connect?.state !== "done")
        throw new Error(`Link failed: ${JSON.stringify(second.connect)}`);
      await cabin.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
      await waitFor(
        async () => (await pins(cabin)).some((pin) => pin.id === FakeGoogle.digest(OWNER_GOOGLE)),
        "cabin to trust the Google account its passkey countersigned",
      );
    },
    3 * gatewayBootBudgetMs() + 300_000,
  );

  afterAll(async () => {
    try {
      await browser?.close();
      await home?.close();
      await cabin?.close();
      await outsider?.close();
      await world?.close();
    } finally {
      if (priorCaFile === undefined) delete process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
      else process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = priorCaFile;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("home trusts both of the owner's sign-ins and joins them automatically", async () => {
    expect(await pins(home)).toEqual([
      { type: "google", id: FakeGoogle.digest(OWNER_GOOGLE), source: "link-page" },
      { type: "passkey", id: passkey, source: "endorsed" },
    ]);
    expect((await home.status()).deviceEnrollment.policy).toBe("automatic");
  });

  test("F1b: signed in on a page that links a gateway, nothing is linked until the owner presses to connect it", async () => {
    // A gateway sign-up.
    const signup = await outsiderSignup(world, outsiderDevice("Fictional waiting CLI").nonce);
    const page = owner.page;
    await enterConnectCode(page, signup.started.connectUrl, signup.started.code);
    await clickFirst(page, ["Sign in with Passkey", "Verify with Passkey"]);
    const button = page.getByRole("button", { name: CONNECT, exact: true });
    await button.waitFor({ timeout: 20_000 });
    // Long enough for a page that goes on by itself to have done so.
    await page.waitForTimeout(3_000);
    expect(await button.isVisible()).toBe(true);
    expect(await allSet(page)()).toBe(false);
    expect(await signup.poll()).toMatchObject({ status: "pending" });
    await button.click();
    await expectText(page, "You're all set");
    expect(
      await waitFor(async () => {
        const value = await signup.poll();
        return value.status !== "pending" && value;
      }, "the sign-up to be approved"),
    ).toMatchObject({ status: "approved" });

    // An owner-link from a gateway's account page.
    const { begin } = outsiderHandoff();
    const pending = await begin(outsiderDevice("Fictional waiting link CLI").nonce);
    const callback = await captureCallback(page);
    try {
      await page.goto(pending.authorizeUrl);
      await clickFirst(page, ["Sign in with Passkey", "Verify with Passkey"]);
      await button.waitFor({ timeout: 20_000 });
      await page.waitForTimeout(3_000);
      expect(await button.isVisible()).toBe(true);
      expect(callback.url).toBeUndefined();
      expect(new URL(page.url()).pathname).toBe("/_relay/account");
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  }, 120_000);

  test("F1: an outsider cannot turn the owner's passkey sign-in on a gateway sign-up page into a device enrollment", async () => {
    const devicesBefore = (await home.devices()).map((row) => row.id).sort();
    const device = outsiderDevice("Fictional outsider passkey CLI");
    const signup = await outsiderSignup(world, device.nonce);
    const page = owner.page;
    await enterConnectCode(page, signup.started.connectUrl, signup.started.code);
    await clickFirst(page, ["Sign in with Passkey", "Verify with Passkey"]);
    await connectWhenAsked(page, allSet(page));
    const approved = await waitFor(async () => {
      const value = await signup.poll();
      return value.status !== "pending" && value;
    }, "the outsider's sign-up to be approved");
    expect(approved).toMatchObject({ status: "approved", signInProof: { type: "passkey" } });
    // The owner's pinned passkey made it, for the nonce the outsider chose.
    expect((approved.signInProof as { credential: { id: string } }).credential.id).toBe(passkey);

    await expectRefused(
      home,
      device,
      await offer(home, device, approved.signInProof),
      devicesBefore,
    );
  }, 180_000);

  test("F1: an outsider cannot turn the owner's Google sign-in on a gateway sign-up page into a device enrollment", async () => {
    const devicesBefore = (await home.devices()).map((row) => row.id).sort();
    const device = outsiderDevice("Fictional outsider Google CLI");
    const signup = await outsiderSignup(world, device.nonce);
    const page = owner.page;
    world.google!.signInAs(OWNER_GOOGLE);
    await enterConnectCode(page, signup.started.connectUrl, signup.started.code);
    await clickFirst(page, ["Sign in with Google", "Verify with Google"]);
    await connectWhenAsked(page, allSet(page));
    const approved = await waitFor(async () => {
      const value = await signup.poll();
      return value.status !== "pending" && value;
    }, "the outsider's sign-up to be approved");
    expect(approved).toMatchObject({ status: "approved", signInProof: { type: "google" } });

    await expectRefused(
      home,
      device,
      await offer(home, device, approved.signInProof),
      devicesBefore,
    );
  }, 180_000);

  test("F1: an outsider's own registered gateway cannot turn the owner's sign-in on its owner-link page into a device enrollment", async () => {
    const devicesBefore = (await home.devices()).map((row) => row.id).sort();
    const device = outsiderDevice("Fictional outsider link CLI");
    const { handoff, begin } = outsiderHandoff();
    const pending = await begin(device.nonce);
    const page = owner.page;
    const callback = await captureCallback(page);
    try {
      await page.goto(pending.authorizeUrl);
      await clickFirst(page, ["Sign in with Passkey", "Verify with Passkey"]);
      await connectWhenAsked(page, () => callback.url !== undefined);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    // The owner's browser carried the one-time result to the outsider's gateway, which redeems it.
    expect(callback.url!.searchParams.get("state")).toBe(pending.browserState);
    const redeemed = await handoff.redeem(pending, callback.url!.searchParams.get("result")!);
    expect(redeemed.signInProof).toMatchObject({ type: "passkey" });
    expect((redeemed.signInProof as { credential: { id: string } }).credential.id).toBe(passkey);

    await expectRefused(
      home,
      device,
      await offer(home, device, redeemed.signInProof),
      devicesBefore,
    );
  }, 180_000);

  test("F7: ask-first and a declined sign-in survive the owner disconnecting the gateway and linking the same account again", async () => {
    const google = FakeGoogle.digest(OWNER_GOOGLE);
    expect((await cabin.setPolicy("ask")).deviceEnrollment.policy).toBe("ask");
    // The owner stops trusting the Google account here, which declines it.
    const removed = await cabin.removeTrustedSignIn(google);
    expect(removed.deviceEnrollment.trustedSignIns.map((pin) => pin.id)).toEqual([passkey]);

    await cabin.unlinkAccount();
    expect((await cabin.status()).account.linked).toBe(false);
    // Disconnected, the gateway keeps the owner's choices and drops its pins.
    expect(await linkRecord(cabin)).toMatchObject({
      linked: false,
      enrollmentPolicy: "ask",
      declinedGoogle: [google],
    });

    const relinked = await link(cabin, owner, "existing", "Passkey");
    expect(relinked.connect?.state).toBe("done");
    expect(relinked.account.linked).toBe(true);
    expect(relinked.deviceEnrollment.policy).toBe("ask");
    expect(await linkRecord(cabin)).toMatchObject({
      linked: true,
      enrollmentPolicy: "ask",
      declinedGoogle: [google],
    });
    // The passkey's countersignature still names the Google account, but a declined sign-in is
    // never pinned from it again.
    await cabin.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      expect(await pins(cabin)).toEqual([{ type: "passkey", id: passkey, source: "link-page" }]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect((await cabin.status()).deviceEnrollment.policy).toBe("ask");
  }, 240_000);

  test("F7: ask-first survives the relay saying the account was deleted, and carries over to the next account", async () => {
    const google = FakeGoogle.digest(OWNER_GOOGLE);
    await cabin.setPolicy("ask");

    // The owner deletes the account on the relay's account page.
    await freshAccountSignIn(world, owner);
    const page = owner.page;
    await chooseAccountMenu(page, "Delete account");
    await expectText(page, "Delete your Omnesis account?");
    const final = page.getByRole("button", { name: "Delete account permanently", exact: true });
    const confirm = page.getByRole("button", { name: "Confirm with passkey", exact: true });
    await final.or(confirm).first().waitFor({ timeout: 20_000 });
    if (await confirm.isVisible()) await confirm.click();
    await final.click();
    await expectText(page, /account was deleted\./);

    const after = await waitFor(
      async () => {
        const status = (await cabin.status()) as CloudRelayStatus & { notice?: string };
        return status.notice === "account-deleted" ? status : undefined;
      },
      "cabin to learn its account is gone",
      120_000,
    );
    expect(after.account.linked).toBe(false);
    // With no account it joins nothing automatically, and the owner's choices are on record.
    expect(after.deviceEnrollment).toEqual({ policy: "ask", trustedSignIns: [] });
    expect(await linkRecord(cabin)).toMatchObject({
      linked: false,
      dormant: true,
      enrollmentPolicy: "ask",
      declinedGoogle: [google],
    });

    // Connected to a new account, the gateway still asks first; the old account's refusals
    // belong to that account and do not carry over.
    const someone = await browser.session();
    const again = await link(cabin, someone, "create", "Passkey");
    expect(again.connect?.state).toBe("done");
    expect(again.account.linked).toBe(true);
    expect(again.deviceEnrollment.policy).toBe("ask");
    expect(await linkRecord(cabin)).toMatchObject({
      linked: true,
      enrollmentPolicy: "ask",
      declinedGoogle: [],
    });
  }, 300_000);
});

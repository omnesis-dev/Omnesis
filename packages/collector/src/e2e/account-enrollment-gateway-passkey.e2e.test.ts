// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Passkeys on the gateway's own page (docs/device-enrollment.md, "Passkeys on the gateway's own
 * page"), end to end: a real relay daemon, a real gateway tunnelled through it on its hosted name
 * `g-….relay.example.test`, and a headless Chromium holding the account's passkey in a virtual
 * authenticator. The RP ID is the relay's host, so the same passkey answers on the relay's pages,
 * on this gateway's page and on any other name under the relay's domain: only the origin the
 * browser reports tells them apart, and the gateway checks it against its own.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  ManagedAccountBrowser,
  enrollmentNonce,
  enrollmentSignatureTranscript,
  gatewayPasskeyChallenge,
  passkeyProofChallenge,
  hostedGatewayHostname,
  signDeviceTranscript,
} from "@omnesis/cloud-relay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EnrollmentGateway,
  EnrollmentWorld,
  PasskeyBrowser,
  RELAY_HOST,
  assertionOn,
  browserSuiteAvailable,
  clickFirst,
  connectGatewayBySignIn,
  copyPasskey,
  syncPasskey,
  expectText,
  passkeyIds,
  signedInAccount,
  waitFor,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import type { Page } from "playwright";

const browserReady = browserSuiteAvailable("account-enrollment-gateway-passkey.e2e");

/** Saves a screenshot for review when `OMNESIS_E2E_SHOT_DIR` names a directory; otherwise nothing. */
async function shot(page: Page, name: string): Promise<void> {
  const target = process.env.OMNESIS_E2E_SHOT_DIR;
  if (target)
    await page.screenshot({ path: join(target, `gateway-passkey-${name}.png`), fullPage: true });
}

describe.skipIf(!browserReady)("passkeys on the gateway's own page", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  let gateway: EnrollmentGateway;
  /** Holds the passkey of the account the gateway is linked to. */
  let owner: PasskeySession;
  const priorCaFile = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
  const priorEnabled = process.env.OMNESIS_CLOUD_RELAY_ENABLED;

  /**
   * Opens the portal on the gateway's public name, logged in with the owner's admin token. A
   * sign-in through the relay's account page would now wait for approval, since nothing is
   * confirmed yet.
   */
  async function ownerPortal(session: PasskeySession) {
    const page = session.page;
    await page.goto(
      `${gateway.publicOrigin}/portal/?token=${encodeURIComponent(gateway.harness.apiKey)}`,
    );
    await page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
    return page;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-gateway-passkey-"));
    world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
    process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = world.pki.caCertFile;
    process.env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
    browser = await PasskeyBrowser.launch(world);
    gateway = await EnrollmentGateway.start(world, "home");
    owner = await browser.session();
    const linked = await connectGatewayBySignIn(gateway, owner, "create");
    if (linked.connect?.state !== "done" || !linked.account.linked)
      throw new Error(`Gateway did not link: ${JSON.stringify(linked.connect)}`);
  }, gatewayBootBudgetMs() + 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
      await gateway?.close();
      await world?.close();
    } finally {
      if (priorCaFile === undefined) delete process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
      else process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = priorCaFile;
      if (priorEnabled === undefined) delete process.env.OMNESIS_CLOUD_RELAY_ENABLED;
      else process.env.OMNESIS_CLOUD_RELAY_ENABLED = priorEnabled;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("a freshly linked gateway offers its own origin for confirming, and nothing is confirmed yet", async () => {
    const status = await gateway.status();
    expect(status.deviceEnrollment.confirmOrigin).toBe(gateway.publicOrigin);
    expect(status.deviceEnrollment.confirmedSignIns).toEqual([]);
    // Until the owner confirms a sign-in here, every new device waits for a person.
    expect(status.deviceEnrollment).toMatchObject({ confirmationNeeded: true });
    expect(status.deviceEnrollment.trustedSignIns).toEqual([
      expect.objectContaining({ type: "passkey", source: "link-page", confirmed: false }),
    ]);
  });

  test("TM-01 (relay page): an owner passkey assertion steered by a relay page cannot confirm a passkey", async () => {
    const ceremony = await gateway.passkeyConfirmation();
    expect(ceremony).toMatchObject({ rpId: RELAY_HOST, origin: gateway.publicOrigin });
    // A compromised relay serves its own page with the very challenge the gateway issued.
    const credential = await assertionOn(owner, world.relayOrigin, ceremony.webauthnChallenge);
    const refused = await gateway.confirmPasskey({
      type: "gateway-passkey",
      challenge: ceremony.challenge,
      credential,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "passkey-not-confirmed" });
    expect((await gateway.status()).deviceEnrollment.confirmedSignIns).toEqual([]);
  }, 120_000);

  test("TM-01 (sibling gateway): an assertion made on another gateway's name under the relay domain is refused", async () => {
    const sibling = `https://${hostedGatewayHostname(randomUUID(), RELAY_HOST)}:${world.dataPort}`;
    const ceremony = await gateway.passkeyConfirmation();
    const credential = await assertionOn(owner, sibling, ceremony.webauthnChallenge);
    const refused = await gateway.confirmPasskey({
      type: "gateway-passkey",
      challenge: ceremony.challenge,
      credential,
    });
    expect(refused.status).toBe(403);
    // The challenge was spent by that attempt: the gateway's own page can't reuse it either.
    const again = await gateway.confirmPasskey({
      type: "gateway-passkey",
      challenge: ceremony.challenge,
      credential: await assertionOn(owner, gateway.publicOrigin, ceremony.webauthnChallenge),
    });
    expect(again.status).toBe(409);
    expect((await gateway.status()).deviceEnrollment.confirmedSignIns).toEqual([]);
  }, 120_000);

  test("right after linking, the owner confirms the passkey from the card on the gateway's own page", async () => {
    const page = await ownerPortal(owner);
    await page.goto(`${gateway.publicOrigin}/portal/settings/account`);
    await expectText(page, "Confirm your passkey on this gateway");
    await expectText(page, "Not confirmed on this gateway");
    await shot(page, "confirm-card");
    await clickFirst(page, ["Confirm with passkey"]);
    const confirmed = await waitFor(async () => {
      const status = await gateway.status();
      return status.deviceEnrollment.confirmedSignIns?.length ? status : undefined;
    }, "the passkey to be confirmed");
    expect(confirmed.deviceEnrollment.confirmedSignIns).toEqual([
      {
        type: "passkey",
        id: (await passkeyIds(owner))[0],
        at: expect.any(Number),
        via: "gateway-origin",
      },
    ]);
    expect(confirmed.deviceEnrollment.trustedSignIns).toEqual([
      expect.objectContaining({ source: "link-page", confirmed: true }),
    ]);
    await expectText(page, "Confirmed on this gateway");
    expect(await page.getByText("Confirm your passkey on this gateway").count()).toBe(0);
    await shot(page, "confirmed");
    // The list the CLI reads says the same.
    const listed = await gateway.json<{ items: Array<{ confirmed: boolean; via?: string }> }>(
      "/admin/cloud-relay/trusted-sign-ins",
    );
    expect(listed.items).toEqual([
      expect.objectContaining({ confirmed: true, via: "gateway-origin" }),
    ]);
    expect(owner.errors).toEqual([]);
  }, 180_000);

  /**
   * A device's request with a passkey assertion made on `from` over the ceremony the gateway
   * issued for it, as a native client or a page would send it. Returns the gateway's answer.
   */
  async function passkeyRequest(
    from: string,
    tamper: (body: Record<string, any>) => Record<string, any> = (body) => body,
  ) {
    await gateway.pace(2);
    const config = await (await gateway.fetch("/devices/account/config")).json();
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const fields = {
      requestId: randomUUID(),
      kind: "cli" as const,
      name: "Fictional laptop",
      secret: randomBytes(32).toString("hex"),
    };
    const devicePublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    const ceremony = await (
      await gateway.fetch("/devices/account/passkey/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...fields, devicePublicKey }),
      })
    ).json();
    const webauthnChallenge =
      from === gateway.publicOrigin
        ? ceremony.webauthnChallenge
        : // A page elsewhere names its own origin, as the challenge's construction requires.
          gatewayPasskeyChallenge("device-enrollment", from, ceremony.challenge, ceremony.binding);
    const body = tamper({
      ...fields,
      deviceKey: {
        publicKey: devicePublicKey,
        challenge: ceremony.challenge,
        signature: signDeviceTranscript(
          privateKey,
          enrollmentSignatureTranscript({
            ...fields,
            gatewaySpkiFingerprint: config.gatewaySpkiFingerprint,
            challenge: ceremony.challenge,
            devicePublicKey,
          }),
        ),
      },
      proof: {
        type: "gateway-passkey",
        challenge: ceremony.challenge,
        credential: await assertionOn(owner, from, webauthnChallenge),
      },
    });
    const response = await gateway.fetch("/devices/account/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, body };
  }

  test("the portal joins with a passkey on the gateway's own page, with no relay page in between", async () => {
    await gateway.setPolicy("automatic");
    await gateway.pace(3);
    const before = new Set((await gateway.devices()).map((device) => device.id));
    const fresh = await browser.session();
    const copied = await copyPasskey(owner, fresh);
    const visited: string[] = [];
    fresh.page.on("framenavigated", (frame) => {
      if (frame === fresh.page.mainFrame()) visited.push(frame.url());
    });
    await fresh.page.goto(`${gateway.publicOrigin}/portal/`);
    await clickFirst(fresh.page, ["Sign in with Passkey"]);
    await fresh.page.locator("nav.sidebar-nav").waitFor({ timeout: 30_000 });
    await syncPasskey(fresh, owner, copied);
    expect(visited.filter((url) => new URL(url).origin === world.relayOrigin)).toEqual([]);
    const added = (await gateway.devices()).filter((device) => !before.has(device.id));
    expect(added).toEqual([
      expect.objectContaining({
        kind: "portal",
        enrollment: expect.objectContaining({ method: "automatic", signIn: "passkey" }),
      }),
    ]);
    expect(fresh.errors).toEqual([]);
    await fresh.context.close();
  }, 180_000);

  test("TM-01 (join): a device-enrollment assertion steered by a relay page or a sibling gateway's page joins nothing", async () => {
    const before = (await gateway.devices()).length;
    for (const from of [
      world.relayOrigin,
      `https://${hostedGatewayHostname(randomUUID(), RELAY_HOST)}:${world.dataPort}`,
    ]) {
      const { response } = await passkeyRequest(from);
      expect(response.status).toBe(401);
    }
    expect((await gateway.pendingRequests()).filter((value) => value.status === "pending")).toEqual(
      [],
    );
    expect((await gateway.devices()).length).toBe(before);
  }, 180_000);

  test("TM-03: a gateway passkey assertion can't be kept for later, made up ahead, or carry a relay time", async () => {
    const before = (await gateway.devices()).length;
    // Used once, it joins; the very same request body is refused the second time.
    const { response, body } = await passkeyRequest(gateway.publicOrigin);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "approved" });
    const replayed = await gateway.fetch("/devices/account/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, requestId: randomUUID() }),
    });
    expect(replayed.status).toBe(409);
    // A challenge the gateway never issued (one a relay would pick to stockpile assertions).
    const madeUp = randomBytes(32).toString("base64url");
    const invented = await passkeyRequest(gateway.publicOrigin, (value) => ({
      ...value,
      deviceKey: { ...value.deviceKey, challenge: madeUp },
      proof: { ...value.proof, challenge: madeUp },
    }));
    expect(invented.response.status).toBe(409);
    // A relay-chosen time in the future has no place in the proof at all.
    const dated = await passkeyRequest(gateway.publicOrigin, (value) => ({
      ...value,
      proof: {
        ...value.proof,
        issuedAt: String(Math.floor(Date.now() / 1000) + 30 * 86400),
      },
    }));
    expect(dated.response.status).toBe(400);
    // The one approved request becomes a device only when its pairing code is redeemed.
    expect((await gateway.devices()).length).toBe(before);
  }, 180_000);

  test("a held request is approved on the gateway's public approval page with the owner's passkey", async () => {
    await gateway.setPolicy("ask");
    const { response, body } = await passkeyRequest(gateway.publicOrigin);
    const held = await response.json();
    expect(held.status).toBe("pending");
    // No portal login: the page is public and the confirmed passkey is the credential.
    const visitor = await browser.session();
    const copied = await copyPasskey(owner, visitor);
    const page = visitor.page;
    await page.goto(`${gateway.publicOrigin}/portal/approve#${body.requestId}`);
    await expectText(page, "Approve a new device");
    await expectText(page, held.verificationCode);
    await shot(page, "approval-page");
    await clickFirst(page, ["Approve with passkey"]);
    await expectText(page, "can finish joining now");
    await syncPasskey(visitor, owner, copied);
    const polled = await (
      await gateway.fetch("/devices/account/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: body.requestId, secret: body.secret }),
      })
    ).json();
    expect(polled).toMatchObject({ status: "approved", pairingCode: expect.any(String) });
    expect(visitor.errors).toEqual([]);
    await visitor.context.close();
  }, 180_000);

  test("TM-01 (approval): an approval assertion steered by a relay page approves nothing", async () => {
    await gateway.setPolicy("ask");
    const { body } = await passkeyRequest(gateway.publicOrigin);
    const ceremony = await (
      await gateway.fetch("/devices/account/approval/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: body.requestId }),
      })
    ).json();
    const credential = await assertionOn(
      owner,
      world.relayOrigin,
      gatewayPasskeyChallenge(
        "approve-request",
        world.relayOrigin,
        ceremony.challenge,
        ceremony.binding,
      ),
    );
    const refused = await gateway.fetch("/devices/account/approval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: body.requestId,
        proof: { type: "gateway-passkey", challenge: ceremony.challenge, credential },
      }),
    });
    expect(refused.status).toBe(403);
    expect(
      (await gateway.pendingRequests()).find((request) => request.requestId === body.requestId),
    ).toMatchObject({ status: "pending" });
    await gateway.decide(body.requestId, false);
    await gateway.setPolicy("automatic");
  }, 180_000);

  test("TM-01: a compromised relay steering the owner's confirmed passkey on its own page, with its own attestation, gets only a held request", async () => {
    await gateway.setPolicy("automatic");
    // The owner confirmed this passkey on the gateway's page earlier in this suite.
    expect((await gateway.status()).deviceEnrollment.confirmedSignIns).toHaveLength(1);
    const before = (await gateway.devices()).length;
    // The attacker's device and request.
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const devicePublicKey = key.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    const request = {
      requestId: randomUUID(),
      kind: "cli" as const,
      name: "Fictional relay-steered CLI",
      secret: randomBytes(32).toString("hex"),
    };
    const nonce = enrollmentNonce({ ...request, devicePublicKey });
    // The relay's page asks the owner's passkey, the one confirmed on this gateway, to sign the
    // attacker's nonce, and the relay mints its attestation for the same nonce.
    const salt = randomBytes(32).toString("base64url"),
      issuedAt = String(Math.floor(Date.now() / 1000));
    const credential = await assertionOn(
      owner,
      world.relayOrigin,
      passkeyProofChallenge(salt, issuedAt, nonce),
    );
    const account = await signedInAccount(world, owner);
    const identityToken = await (
      await world.accountAuthority()
    ).issue({
      accountId: account.accountId,
      gatewayId: gateway.gatewayId,
      ownerAccountId: await gateway.ownerAccountId(),
      nonce,
    });
    await gateway.pace(2);
    const config = await (await gateway.fetch("/devices/account/config")).json();
    const { challenge } = await (
      await gateway.fetch("/devices/account/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    const reply = await (
      await gateway.fetch("/devices/account/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          identityToken,
          proof: { type: "passkey", salt, issuedAt, credential },
          deviceKey: {
            publicKey: devicePublicKey,
            challenge,
            signature: signDeviceTranscript(
              key.privateKey,
              enrollmentSignatureTranscript({
                ...request,
                gatewaySpkiFingerprint: config.gatewaySpkiFingerprint,
                challenge,
                devicePublicKey,
              }),
            ),
          },
        }),
      })
    ).json();
    // The passkey is confirmed and the policy automatic, yet a relay page made this sign-in.
    expect(reply.status).toBe("pending");
    expect(reply.pairingCode).toBeUndefined();
    const held = (await gateway.pendingRequests()).find(
      (value) => value.requestId === request.requestId,
    );
    expect(held).toMatchObject({ signIn: "passkey", canTrustSignIn: false });
    expect((await gateway.devices()).length).toBe(before);
    await gateway.decide(request.requestId, false);
  }, 180_000);

  test("TM-01 (pairing on another gateway): a gateway the owner was tricked into linking cannot turn the owner's sign-in on its pairing page into a device at the owner's real gateway", async () => {
    await gateway.setPolicy("automatic");
    const devicesBefore = (await gateway.devices()).map((row) => row.id).sort();
    // The attacker's gateway, which the owner linked to their account.
    const rogue = await EnrollmentGateway.start(world, "rogue");
    try {
      const linked = await connectGatewayBySignIn(rogue, owner, "existing");
      if (linked.connect?.state !== "done") throw new Error("The rogue gateway did not link");
      // Its own device, and a "Pair this browser" operation for the account with that device's
      // nonce, started from the rogue gateway's files, as its owner can.
      const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const devicePublicKey = key.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url");
      const request = {
        requestId: randomUUID(),
        kind: "cli" as const,
        name: "Fictional rogue-paired CLI",
        secret: randomBytes(32).toString("hex"),
      };
      const account = (await signedInAccount(world, owner)).accountId;
      const handoff = new ManagedAccountBrowser({
        accountId: () => account,
        env: () => ({
          OMNESIS_CLOUD_RELAY_ENABLED: "1",
          OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
          OMNESIS_CLOUD_RELAY_SESSION_FILE: rogue.sessionFile,
          OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: rogue.ownerKeyFile,
          OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: join(rogue.directory, "invitation.json"),
          OMNESIS_CLOUD_RELAY_GATEWAY_ID: rogue.gatewayId,
          OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: rogue.publicOrigin,
          OMNESIS_TLS_CERT: rogue.leaf.certFile,
          OMNESIS_TLS_KEY: rogue.leaf.keyFile,
        }),
      });
      const pending = await handoff.begin({
        purpose: "device-enrollment",
        nonce: enrollmentNonce({ ...request, devicePublicKey }),
        callbackUrl: `${rogue.publicOrigin}/devices/account/callback`,
        browserState: randomBytes(32).toString("base64url"),
      });
      // The owner signs in on that page; it goes on by itself to the rogue gateway's callback.
      const page = owner.page;
      const seen: { url?: URL } = {};
      await page.route(
        (url) => url.pathname === "/devices/account/callback",
        (route) => {
          seen.url = new URL(route.request().url());
          return route.fulfill({ status: 200, contentType: "text/html", body: "<p>Done</p>" });
        },
      );
      try {
        await page.goto(pending.authorizeUrl);
        await clickFirst(page, ["Sign in with Passkey", "Verify with Passkey"]);
        await waitFor(() => seen.url !== undefined, "the page to return to the rogue gateway");
      } finally {
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }
      const redeemed = await handoff.redeem(pending, seen.url!.searchParams.get("result")!);
      expect(redeemed.signInProof).toMatchObject({ type: "passkey" });
      // The owner's confirmed passkey signed the rogue device's nonce on a relay page.
      expect((redeemed.signInProof as { credential: { id: string } }).credential.id).toBe(
        (await passkeyIds(owner))[0],
      );
      // Offered at the owner's real gateway, with the rogue gateway's attestation.
      await gateway.pace(2);
      const config = await (await gateway.fetch("/devices/account/config")).json();
      const { challenge } = await (
        await gateway.fetch("/devices/account/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json();
      const response = await gateway.fetch("/devices/account/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          identityToken: redeemed.identityToken,
          proof: redeemed.signInProof,
          deviceKey: {
            publicKey: devicePublicKey,
            challenge,
            signature: signDeviceTranscript(
              key.privateKey,
              enrollmentSignatureTranscript({
                ...request,
                gatewaySpkiFingerprint: config.gatewaySpkiFingerprint,
                challenge,
                devicePublicKey,
              }),
            ),
          },
        }),
      });
      // A relay page's sign-in is never trusted, and that attestation names another gateway.
      expect(response.status).toBe(401);
      expect((await gateway.devices()).map((row) => row.id).sort()).toEqual(devicesBefore);
      expect(
        (await gateway.pendingRequests()).some((value) => value.requestId === request.requestId),
      ).toBe(false);
    } finally {
      await rogue.close();
    }
  }, 300_000);
});

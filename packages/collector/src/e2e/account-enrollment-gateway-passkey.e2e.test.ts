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
  enrollmentSignatureTranscript,
  gatewayPasskeyChallenge,
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

  /** Opens the portal on the gateway's public name and signs in through the account page. */
  async function portalSignIn(session: PasskeySession) {
    await gateway.pace(3);
    const page = session.page;
    await page.goto(`${gateway.publicOrigin}/portal/`);
    // The relay's account page; signing in on the gateway's own page is the other button.
    await clickFirst(page, ["Sign in on the Omnesis account page"]);
    await clickFirst(page, ["Sign in with Passkey", "Verify with Passkey"]);
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
    const page = await portalSignIn(owner);
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
});

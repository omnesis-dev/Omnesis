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
import { randomUUID } from "node:crypto";
import { hostedGatewayHostname } from "@omnesis/cloud-relay";
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
    await clickFirst(page, ["Sign in with Passkey"]);
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
});

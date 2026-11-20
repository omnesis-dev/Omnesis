// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Invite-only sign-up, end to end: a real relay daemon with the invite policy and the public
 * half of an invite key, a real gateway, and a headless Chromium with a virtual passkey. An
 * invite link the operator signed lets one person create one account with a passkey alone, and
 * its gateway connects; the same invite is refused once used; a sign-up without an invite can't
 * create an account but an account that exists still connects; the relay's invite page says
 * whether a link works; and the relay never writes an invite to its log.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
  enterConnectCode,
  expectText,
  signedInAccount,
  startGatewaySignup,
  waitFor,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

const browserReady = browserSuiteAvailable("account-enrollment-invites.e2e");

describe.skipIf(!browserReady)("invite-only sign-up", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  const gateways: EnrollmentGateway[] = [];
  const invites: string[] = [];
  /** The invite the first account was created with, and that account's browser. */
  let used: string;
  let invited: { session: PasskeySession; accountId: string };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-e2e-invites-"));
    world = await EnrollmentWorld.create(join(directory, "world"), { signupPolicy: "invite" });
    browser = await PasskeyBrowser.launch(world);
  }, gatewayBootBudgetMs() + 60_000);

  afterAll(async () => {
    for (const gateway of gateways) await gateway.close();
    await browser?.close();
    await world?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test(
    "an invite lets a passkey alone create an account, and the gateway connects",
    async () => {
      used = world.invite();
      invites.push(used);
      const gateway = await EnrollmentGateway.start(world, "invited");
      gateways.push(gateway);
      const session = await browser.session();
      const status = await connectGatewayBySignIn(gateway, session, "create", used);
      expect(status).toMatchObject({ connect: { state: "done" }, account: { linked: true } });
      invited = { session, accountId: (await signedInAccount(world, session)).accountId };
      expect(invited.accountId).toMatch(/^[a-f0-9]{64}$/);
      // The passkey alone created the account: this relay has no Google sign-in at all.
      expect(world.google).toBeUndefined();
    },
    gatewayBootBudgetMs() + 180_000,
  );

  test("a used invite can't start another sign-up", async () => {
    await expect(startGatewaySignup(world, "create", used)).rejects.toMatchObject({
      status: 403,
      body: JSON.stringify({ error: "invite-used" }),
    });
    const expired = world.invite({
      issuedAt: Math.floor(Date.now() / 1000) - 120,
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    invites.push(expired);
    await expect(startGatewaySignup(world, "create", expired)).rejects.toMatchObject({
      status: 403,
      body: JSON.stringify({ error: "invite-expired" }),
    });
  });

  test("without an invite nobody can create an account, but an account that exists connects", async () => {
    const signup = await startGatewaySignup(world, "create");
    const stranger = await browser.session();
    await enterConnectCode(stranger.page, signup.started.connectUrl, signup.started.code);
    await stranger.page
      .getByRole("heading", { name: CREATE_ACCOUNT_HEADING, exact: true })
      .waitFor();
    await expectText(stranger.page, "Omnesis accounts are invite-only for now.");
    expect(await stranger.page.getByRole("button", { name: "Create with a passkey" }).count()).toBe(
      0,
    );
    // The person who has an account switches to signing in, and connects this gateway.
    const { page } = invited.session;
    const again = await startGatewaySignup(world, "create");
    await enterConnectCode(page, again.started.connectUrl, again.started.code);
    await expectText(page, "Omnesis accounts are invite-only for now.");
    await clickFirst(page, ["I already have an account"]);
    await page.getByRole("heading", { name: SIGN_IN_HEADING, exact: true }).waitFor();
    await clickFirst(page, ["Sign in with Passkey"]);
    await connectThisGateway(page);
    const decided = await waitFor(async () => {
      const value = await again.poll();
      return value.status !== "pending" && value;
    }, "the gateway's signup decision");
    expect(decided).toMatchObject({ status: "approved" });
    // The stranger's sign-up created nothing: no account, so no session either.
    expect(
      (await stranger.context.cookies()).some((value) => value.name === "__Host-omnesis-account"),
    ).toBe(false);
    expect(await signup.poll()).toEqual({ status: "pending", expiresAt: expect.any(Number) });
    await signup.cancel();
  });

  test("the invite page says whether a link works", async () => {
    const session = await browser.session();
    const fresh = world.invite();
    invites.push(fresh);
    await session.page.goto(fresh);
    await expectText(session.page, /This invite works until /);
    await session.page.goto(used);
    await expectText(session.page, "This invite was already used to create an account.");
    await session.page.goto(`${world.relayOrigin}/invite`);
    await expectText(session.page, "This link has no invite in it");
    // Only that: nothing to use or copy.
    expect(await session.page.getByText("You're invited to Omnesis").isVisible()).toBe(false);
    expect(await session.page.getByRole("button", { name: "Copy invite" }).isVisible()).toBe(false);
  });

  test("the relay keeps no invite in its log", () => {
    const log = world.relayLog();
    for (const link of invites) expect(log).not.toContain(link.slice(link.indexOf("#") + 1));
  });
});

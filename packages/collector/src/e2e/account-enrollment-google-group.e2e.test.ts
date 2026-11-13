// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Invite-only sign-up through a group at Google (docs/device-enrollment.md §
 * Connecting a gateway), end to end: a real relay daemon with the allowlist
 * policy, an empty allowlist and a group at Google as the invitation, a headless
 * Chromium that creates an account with "Create with Google", and one loopback
 * server standing in for Google's sign-in, token, key and group membership
 * endpoints. A person whose verified email is in the group creates an account
 * and the gateway is approved; a person outside it is told accounts are
 * invite-only, with the link to ask to join, and the gateway sees the usual
 * refusal. An invited account that left its gateway connects another one by
 * signing in with Google, until it is removed from the group. The relay never
 * writes any of these addresses to its log.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeGoogle } from "../../../cloud-relay/test/fake-google.js";
import {
  CREATE_ACCOUNT_HEADING,
  EnrollmentGateway,
  EnrollmentWorld,
  SIGN_IN_HEADING,
  finishedConnect,
  PasskeyBrowser,
  browserSuiteAvailable,
  clickFirst,
  enterConnectCode,
  expectText,
  signedInAccount,
  startGatewaySignup,
  waitFor,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

const browserReady = browserSuiteAvailable("account-enrollment-google-group.e2e");
const JOIN_URL = "https://groups.example.com/g/testers";
const INVITED = "maya.reeves@example.com";
const STRANGER = "jamie.lopez@example.com";
const RETURNING = "david.lin@example.com";

describe.skipIf(!browserReady)("invite-only sign-up through a group at google", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  let google: FakeGoogle;
  const gateways: EnrollmentGateway[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-e2e-signup-group-"));
    google = await FakeGoogle.start("testers@example.com");
    google.members.add(INVITED);
    const serviceAccount = join(directory, "signup-group-service-account.json");
    await writeFile(serviceAccount, JSON.stringify(google.serviceAccountKey()), { mode: 0o600 });
    const webSecret = join(directory, "relay-google-web.json");
    await writeFile(
      webSecret,
      JSON.stringify({
        web: { client_id: google.webClientId, client_secret: google.webClientSecret },
      }),
      { mode: 0o600 },
    );
    world = await EnrollmentWorld.create(join(directory, "world"), {
      signupPolicy: "allowlist",
      extraEnv: {
        OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: google.webClientId,
        OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE: webSecret,
        OMNESIS_CLOUD_RELAY_GOOGLE_FIXTURE_URL: google.url,
        OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP: "testers@example.com",
        OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE: serviceAccount,
        OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL: JOIN_URL,
      },
    });
    browser = await PasskeyBrowser.launch(world);
  });

  afterAll(async () => {
    for (const gateway of gateways) await gateway.close();
    await browser?.close();
    await world?.close();
    await google?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /** A gateway asks to create an account; the person types its code and picks Google. */
  async function createWithGoogle(signIn: { subject: string; email: string }) {
    const signup = await startGatewaySignup(world, "create");
    const session = await browser.session();
    google.nextSignIn = { subject: signIn.subject, email: signIn.email, emailVerified: true };
    await enterConnectCode(session.page, signup.started.connectUrl, signup.started.code);
    await session.page
      .getByRole("heading", { name: CREATE_ACCOUNT_HEADING, exact: true })
      .waitFor();
    await clickFirst(session.page, ["Create with Google"]);
    return { signup, session };
  }

  test("a google identity in the group creates an account and its gateway is approved", async () => {
    const { signup, session } = await createWithGoogle({
      subject: "fictional-invited-subject",
      email: "Maya.Reeves@Example.com",
    });
    // Signing in was the decision, so the page goes on by itself.
    await expectText(session.page, "You're all set");
    expect((await signedInAccount(world, session)).accountId).toMatch(/^[a-f0-9]{64}$/);
    // The relay asked Google for the address only because this sign-in creates an account.
    expect(google.authorizations.at(-1)!.get("scope")).toBe("openid email");
    expect(
      google.groupApiRequests().some((value) => value.includes("memberKey.id=maya.reeves%40")),
    ).toBe(true);
    const decided = await waitFor(async () => {
      const value = await signup.poll();
      return value.status !== "pending" && value;
    }, "the gateway's signup decision");
    expect(decided).toMatchObject({ status: "approved" });
  });

  test("a google identity outside the group is told accounts are invite-only and where to ask", async () => {
    const { signup, session } = await createWithGoogle({
      subject: "fictional-stranger-subject",
      email: STRANGER,
    });
    await expectText(session.page, "Omnesis accounts are invite-only for now.");
    await expectText(session.page, "Ask to join here:");
    expect(await session.page.getByRole("link", { name: JOIN_URL }).getAttribute("href")).toBe(
      JOIN_URL,
    );
    // No account and no session were made for the stranger.
    expect(
      (await session.context.cookies()).some((value) => value.name === "__Host-omnesis-account"),
    ).toBe(false);
    // The gateway learns only that the sign-in was refused.
    expect(await signup.poll()).toEqual({ status: "denied", reason: "not-allowed" });
  });

  test(
    "an invited account that left its gateway connects another with google, and is refused once removed from the group",
    async () => {
      const person = { subject: "fictional-returning-subject", email: RETURNING };
      google.members.add(RETURNING);
      /** The gateway shows a code; the person types it and signs in with Google. */
      const connectWithGoogle = async (
        gateway: EnrollmentGateway,
        intent: "create" | "existing",
      ) => {
        const session = await browser.session();
        google.nextSignIn = { ...person, emailVerified: true };
        const started = await gateway.connect(intent);
        if (started.connect?.state !== "waiting")
          throw new Error(`Connect did not start: ${JSON.stringify(started.connect)}`);
        await enterConnectCode(session.page, started.connect.connectUrl!, started.connect.code!);
        await session.page
          .getByRole("heading", {
            name: intent === "create" ? CREATE_ACCOUNT_HEADING : SIGN_IN_HEADING,
            exact: true,
          })
          .waitFor();
        await clickFirst(session.page, [
          intent === "create" ? "Create with Google" : "Sign in with Google",
        ]);
        return session;
      };

      // The group admits the new account, and its first gateway links.
      const first = await EnrollmentGateway.start(world, "first");
      gateways.push(first);
      const creator = await connectWithGoogle(first, "create");
      await expectText(creator.page, "You're all set");
      expect(await finishedConnect(first)).toMatchObject({
        connect: { state: "done" },
        account: { linked: true },
      });
      const accountId = (await signedInAccount(world, creator)).accountId;
      await first.unlinkAccount();

      // The account now has no gateway and is on no allowlist: the group lets it connect another.
      const second = await EnrollmentGateway.start(world, "second");
      gateways.push(second);
      const asked = google.groupApiRequests().length;
      const returning = await connectWithGoogle(second, "existing");
      await expectText(returning.page, "You're all set");
      expect(await finishedConnect(second)).toMatchObject({
        connect: { state: "done" },
        account: { linked: true },
      });
      expect((await signedInAccount(world, returning)).accountId).toBe(accountId);
      expect(google.groupApiRequests().length).toBeGreaterThan(asked);
      await second.unlinkAccount();

      // Removed from the group, the same account is refused as not invited.
      google.members.delete(RETURNING);
      const removed = await connectWithGoogle(second, "existing");
      await expectText(removed.page, "Omnesis accounts are invite-only for now.");
      expect(await removed.page.getByRole("link", { name: JOIN_URL }).getAttribute("href")).toBe(
        JOIN_URL,
      );
      expect(await finishedConnect(second)).toMatchObject({
        connect: { state: "failed", error: "not-allowed" },
        account: { linked: false },
      });
    },
    gatewayBootBudgetMs() * 2 + 180_000,
  );

  test("the relay keeps no address in its log", () => {
    const log = world.relayLog().toLowerCase();
    for (const address of [INVITED, STRANGER, RETURNING]) expect(log).not.toContain(address);
  });
});

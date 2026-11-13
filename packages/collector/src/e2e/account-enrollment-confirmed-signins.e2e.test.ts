// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One account behaves as one across its gateways (docs/device-enrollment.md,
 * Passkeys added later), end to end: a real relay daemon offering Google and
 * passkey sign-in, two real gateways tunnelled through it, the Node pairing
 * client a CLI uses, and a headless Chromium with a virtual passkey
 * authenticator. Google is the harness's stand-in (`FakeGoogle`); its tokens
 * are verified by the product unchanged.
 *
 * The account is created with Google on the first gateway. A passkey is added
 * on the account page: it signs once for the account's Google sign-in, and
 * Google vouches for it. The second gateway is linked with that passkey, so
 * the passkey is all it saw for itself. A device that signs in with Google on
 * the second gateway then joins with no approval, because the gateway checked
 * the passkey's own signature naming that Google account. Then the relay turns
 * against the owner: it adds a Google account of its own choosing to the
 * account, first with no evidence and then written into the passkey's signed
 * list, and a device signing in with it is held for approval each time.
 *
 * The scenarios run in order, each leaving the world as the next expects.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { authorizeAccountDesktop, pairAccountDevice } from "@omnesis/cloud-relay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  COUNTERSIGN_HEADING,
  ENDORSEMENT_HEADING,
  EnrollmentGateway,
  EnrollmentWorld,
  FakeGoogle,
  PASSKEY_ADDED,
  PasskeyBrowser,
  browserSuiteAvailable,
  clickFirst,
  connectGatewayBySignIn,
  enterConnectCode,
  expectText,
  finishedConnect,
  passkeyIds,
  waitFor,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

const browserReady = browserSuiteAvailable("account-enrollment-confirmed-signins.e2e");

/** The owner's Google account, and one the relay slips into the account later. Both invented. */
const OWNER_GOOGLE = "fictional-owner-google-subject";
const RELAY_GOOGLE = "fictional-relay-chosen-google-subject";

describe.skipIf(!browserReady)("a gateway trusts the sign-ins its passkey confirmed", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  /** Created the account with Google. */
  let home: EnrollmentGateway;
  /** Linked later with the passkey added to the account. */
  let cabin: EnrollmentGateway;
  let owner: PasskeySession;
  let passkey: string;
  const priorCaFile = process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
  const priorEnabled = process.env.OMNESIS_CLOUD_RELAY_ENABLED;

  /**
   * A CLI pairs with `gateway` while the person signs in with Google on this
   * machine's browser. Returns once the sign-in is done; `result` settles when
   * the client finishes.
   */
  async function pairWithGoogle(gateway: EnrollmentGateway, name: string, subject: string) {
    await gateway.pace(2);
    world.google!.signInAs(subject);
    let launched!: (url: string) => void;
    const launchUrl = new Promise<string>((resolve) => (launched = resolve));
    const comparisons: string[] = [];
    const result = pairAccountDevice(
      {
        kind: "cli",
        name,
        relayUrl: world.relayOrigin,
        deviceKeyFile: join(directory, name.replaceAll(" ", "-"), "device.key"),
        signal: AbortSignal.timeout(120_000),
        // The account has two gateways now; the person picks this one.
        selectGateway: async (choices) => {
          const choice = choices.find((value) => value.gatewayId === gateway.gatewayId);
          if (!choice) throw new Error("The gateway is not among the account's gateways");
          return choice.gatewayId;
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
            openBrowser: async (url) => launched(url),
          }),
      },
    );
    result.catch(() => undefined);
    const page = owner.page;
    await page.goto(await launchUrl);
    await clickFirst(page, ["Sign in with Google", "Verify with Google"]);
    await clickFirst(page, ["Continue on this device"]);
    await expectText(page, "Sign-in finished");
    return { result, comparisons };
  }

  /** The request `pairing` is waiting on, or the reason it never got one. */
  async function heldRequest(
    gateway: EnrollmentGateway,
    name: string,
    pairing: { result: Promise<unknown> },
  ) {
    return Promise.race([
      waitFor(
        async () =>
          (await gateway.pendingRequests()).find(
            (request) => request.name === name && request.status === "pending",
          ),
        `a held request from ${name}`,
      ),
      pairing.result.then(
        () => {
          throw new Error(`${name} joined without being held`);
        },
        (error: unknown) => {
          throw new Error(`${name} stopped before its request was held`, { cause: error });
        },
      ),
    ]);
  }

  const pins = async (gateway: EnrollmentGateway) =>
    (await gateway.status()).deviceEnrollment.trustedSignIns.map((pin) => ({
      type: pin.type,
      id: pin.id,
      source: pin.source,
    }));

  /** What a compromised relay does to its own database while it runs. */
  function asTheRelay<T>(change: (db: Database.Database) => T): T {
    const db = new Database(join(directory, "relay.sqlite"));
    try {
      db.pragma("busy_timeout = 5000");
      return change(db);
    } finally {
      db.close();
    }
  }

  beforeAll(
    async () => {
      directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-confirmed-"));
      world = await EnrollmentWorld.create(directory, { signupPolicy: "open", google: true });
      process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = world.pki.caCertFile;
      process.env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
      browser = await PasskeyBrowser.launch(world);
      home = await EnrollmentGateway.start(world, "home");
      cabin = await EnrollmentGateway.start(world, "cabin");
      owner = await browser.session();
    },
    2 * gatewayBootBudgetMs() + 120_000,
  );

  afterAll(async () => {
    try {
      await browser?.close();
      await home?.close();
      await cabin?.close();
      await world?.close();
    } finally {
      if (priorCaFile === undefined) delete process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
      else process.env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE = priorCaFile;
      if (priorEnabled === undefined) delete process.env.OMNESIS_CLOUD_RELAY_ENABLED;
      else process.env.OMNESIS_CLOUD_RELAY_ENABLED = priorEnabled;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("the account is created with Google on the first gateway, which pins that Google account", async () => {
    world.google!.signInAs(OWNER_GOOGLE);
    const started = await home.connect("create");
    expect(started.connect?.state).toBe("waiting");
    await enterConnectCode(owner.page, started.connect!.connectUrl!, started.connect!.code!);
    await clickFirst(owner.page, ["Create with Google"]);
    await expectText(owner.page, "You're all set");
    const linked = await finishedConnect(home);
    expect(linked.connect?.state).toBe("done");
    expect(linked.account.linked).toBe(true);
    expect(await pins(home)).toEqual([
      { type: "google", id: FakeGoogle.digest(OWNER_GOOGLE), source: "link-page" },
    ]);
  }, 180_000);

  test("a passkey added on the account page signs for the Google account, and Google vouches for it", async () => {
    const page = owner.page;
    await page.goto(`${world.relayOrigin}/_relay/account`);
    await page.getByRole("heading", { name: "Sign-in methods", exact: true }).waitFor();
    await clickFirst(page, ["Add a passkey"]);
    await page.getByRole("heading", { name: COUNTERSIGN_HEADING, exact: true }).waitFor();
    await clickFirst(page, ["Use new passkey"]);
    await page.getByRole("heading", { name: ENDORSEMENT_HEADING, exact: true }).waitFor();
    await clickFirst(page, ["Confirm with Google"]);
    await expectText(page, PASSKEY_ADDED);
    [passkey] = await passkeyIds(owner);
    expect(passkey).toBeDefined();
    expect(owner.errors).toEqual([]);
    // The first gateway learns the passkey forwards, from the Google sign-in it pinned.
    await home.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
    await waitFor(
      async () => (await pins(home)).some((pin) => pin.id === passkey),
      "the first gateway to pin the added passkey",
    );
    expect(await pins(home)).toEqual([
      { type: "google", id: FakeGoogle.digest(OWNER_GOOGLE), source: "link-page" },
      { type: "passkey", id: passkey, source: "endorsed" },
    ]);
  }, 180_000);

  test("the second gateway, linked with the passkey, joins a device that signs in with Google with no approval", async () => {
    const linked = await connectGatewayBySignIn(cabin, owner, "existing");
    expect(linked.connect?.state).toBe("done");
    // The passkey is the only sign-in this gateway saw for itself. Whatever else it trusts, it
    // trusts on evidence (`endorsed`): it may already have fetched it when the link refreshed.
    expect((await pins(cabin)).filter((pin) => pin.source !== "endorsed")).toEqual([
      { type: "passkey", id: passkey, source: "link-page" },
    ]);
    expect((await cabin.status()).deviceEnrollment.policy).toBe("automatic");

    const name = "Fictional cabin CLI";
    const pairing = await pairWithGoogle(cabin, name, OWNER_GOOGLE);
    const joined = await pairing.result;
    expect(pairing.comparisons).toEqual([]);
    expect((await cabin.devices()).find((device) => device.id === joined.deviceId)).toMatchObject({
      kind: "cli",
      name,
      enrollment: { method: "automatic", signIn: "google" },
    });
    expect(
      (await cabin.pendingRequests()).some(
        (request) => request.name === name && request.status === "pending",
      ),
    ).toBe(false);
    // It trusts the Google account on the passkey's own signature.
    expect(await pins(cabin)).toEqual([
      { type: "passkey", id: passkey, source: "link-page" },
      { type: "google", id: FakeGoogle.digest(OWNER_GOOGLE), source: "endorsed" },
    ]);
  }, 300_000);

  test("a Google account the relay adds to the account is held for approval, listed alone or written into the passkey's signed list", async () => {
    const injected = FakeGoogle.digest(RELAY_GOOGLE);
    const before = await pins(cabin);
    // The relay links a Google account of its choosing to the owner's account. It is listed as
    // one of the account's sign-ins, and it can sign in on the relay's pages.
    const accountId = asTheRelay((db) => {
      const { account_id } = db
        .prepare("SELECT account_id FROM omnesis_passkeys WHERE credential_id = ?")
        .get(passkey) as { account_id: string };
      db.prepare(
        "INSERT INTO omnesis_federated_credentials (provider, subject_digest, account_id, created_at) VALUES ('google', ?, ?, ?)",
      ).run(injected, account_id, Date.now());
      return account_id;
    });
    expect(accountId).toMatch(/^[a-f0-9]{64}$/);

    const listed = "Fictional injected CLI";
    const first = await pairWithGoogle(cabin, listed, RELAY_GOOGLE);
    const held = await heldRequest(cabin, listed, first);
    expect(held).toMatchObject({ kind: "cli", signIn: "google" });
    await waitFor(() => first.comparisons.length === 1, "the device to show its comparison code");
    await cabin.decide(held.requestId, false);
    await expect(first.result).rejects.toThrow(/denied/);
    expect(await pins(cabin)).toEqual(before);

    // The relay then rewrites the passkey's countersignature to name its Google account too.
    asTheRelay((db) => {
      const row = db
        .prepare(
          "SELECT countersignature FROM omnesis_passkey_countersignatures WHERE credential_id = ?",
        )
        .get(passkey) as { countersignature: string };
      const value = JSON.parse(row.countersignature) as { google: string[] };
      expect(value.google).toEqual([FakeGoogle.digest(OWNER_GOOGLE)]);
      value.google.push(injected);
      db.prepare(
        "UPDATE omnesis_passkey_countersignatures SET countersignature = ? WHERE credential_id = ?",
      ).run(JSON.stringify(value), passkey);
    });
    const written = "Fictional rewritten CLI";
    const second = await pairWithGoogle(cabin, written, RELAY_GOOGLE);
    const heldAgain = await heldRequest(cabin, written, second);
    expect(heldAgain).toMatchObject({ kind: "cli", signIn: "google" });
    await cabin.decide(heldAgain.requestId, false);
    await expect(second.result).rejects.toThrow(/denied/);
    // Nothing was added, and nothing the gateway already trusted was lost.
    expect(await pins(cabin)).toEqual(before);
    expect((await cabin.devices()).some((device) => [listed, written].includes(device.name))).toBe(
      false,
    );
  }, 300_000);
});

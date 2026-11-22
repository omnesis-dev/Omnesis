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
 * on the account page in two prompts: creating it, and Google vouching for it.
 * The third and last prompt is on the gateway's own page: one assertion that
 * confirms the passkey there and countersigns the account's other sign-ins.
 * The second gateway is linked with that passkey, so the passkey is all it saw
 * for itself until the owner confirms it on that gateway's page too, which
 * makes it suggest the Google account the passkey countersigned there. A device
 * that signs in with Google on a relay page still waits for the owner. Then the
 * relay turns against the owner: it adds a Google account of its own choosing
 * to the account, first with no evidence and then written into a countersignature
 * it makes up, and a device signing in with it is held for approval each time.
 *
 * The scenarios run in order, each leaving the world as the next expects.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { authorizeAccountDesktop, pairAccountDevice, signInDigest } from "@omnesis/cloud-relay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EnrollmentGateway,
  EnrollmentWorld,
  FakeGoogle,
  PASSKEY_ADDED,
  PasskeyBrowser,
  addSecondPasskey,
  assertionOn,
  browserSuiteAvailable,
  clickFirst,
  connectGatewayBySignIn,
  devicePinnedJson,
  confirmPasskeyHere,
  connectThisGateway,
  enterConnectCode,
  expectText,
  finishedConnect,
  freshAccountSignIn,
  passkeyIds,
  waitFor,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import type { Page } from "playwright";

const browserReady = browserSuiteAvailable("account-enrollment-confirmed-signins.e2e");

/** Saves a screenshot for review when `OMNESIS_E2E_SHOT_DIR` names a directory; otherwise nothing. */
async function shot(page: Page, name: string): Promise<void> {
  const target = process.env.OMNESIS_E2E_SHOT_DIR;
  if (target)
    await page.screenshot({ path: join(target, `confirmed-signins-${name}.png`), fullPage: true });
}

/** Local status can refresh before the public tunnel is ready for a new TLS client. */
async function waitForPublicTlsHealth(gateway: EnrollmentGateway): Promise<void> {
  const timeoutMs = gatewayBootBudgetMs(),
    deadline = performance.now() + timeoutMs;
  await waitFor(
    async () => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("Public TLS readiness budget exhausted");
      const health = await devicePinnedJson(
        { publicOrigin: gateway.publicOrigin, certificate: gateway.leaf.cert },
        "/health",
        undefined,
        AbortSignal.timeout(Math.ceil(remaining)),
      );
      return (
        performance.now() < deadline &&
        health !== null &&
        typeof health === "object" &&
        "status" in health &&
        health.status === "ok"
      );
    },
    "the pinned public TLS health response",
    timeoutMs,
  );
}

/** The owner's Google account, and one the relay slips into the account later. Both invented. */
const OWNER_GOOGLE = "fictional-owner-google-subject";
const RELAY_GOOGLE = "fictional-relay-chosen-google-subject";

describe.skipIf(!browserReady)(
  "a gateway suggests the sign-ins its passkey vouched for, and trusts none on the relay's word",
  () => {
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

    /**
     * A CLI pairs with `gateway` while the person signs in with Google on this
     * machine's browser. Returns once the sign-in is done; `result` settles when
     * the client finishes.
     */
    async function pairWithGoogle(gateway: EnrollmentGateway, name: string, subject: string) {
      world.google!.signInAs(subject);
      return pairBySignIn(gateway, name, owner, "Google");
    }

    /** The same with a passkey `session` holds. */
    async function pairBySignIn(
      gateway: EnrollmentGateway,
      name: string,
      session: PasskeySession,
      method: "Google" | "Passkey",
    ) {
      await gateway.pace(2);
      await waitForPublicTlsHealth(gateway);
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
      const page = session.page;
      await page.goto(await launchUrl);
      await clickFirst(page, [`Sign in with ${method}`, `Verify with ${method}`]);
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
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);

    test("the account is created with Google on the first gateway, which suggests that Google account until the owner confirms one", async () => {
      world.google!.signInAs(OWNER_GOOGLE);
      const started = await home.connect("create");
      expect(started.connect?.state).toBe("waiting");
      await enterConnectCode(owner.page, started.connect!.connectUrl!, started.connect!.code!);
      await clickFirst(owner.page, ["Create with Google"]);
      await connectThisGateway(owner.page);
      const linked = await finishedConnect(home);
      expect(linked.connect?.state).toBe("done");
      expect(linked.account.linked).toBe(true);
      expect(await pins(home)).toEqual([
        { type: "google", id: FakeGoogle.digest(OWNER_GOOGLE), source: "link-page" },
      ]);
      expect(linked.deviceEnrollment).toMatchObject({ confirmationNeeded: true });
    }, 180_000);

    /** What the relay stored beside `credential` as that passkey's countersignature, if anything. */
    const storedCountersignatures = (credential: string) =>
      asTheRelay(
        (db) =>
          (
            db
              .prepare(
                "SELECT count(*) AS count FROM omnesis_passkey_countersignatures WHERE credential_id = ?",
              )
              .get(credential) as { count: number }
          ).count,
      );
    /**
     * A relay page asks the owner's passkey to sign `gateway`'s confirmation ceremony on the
     * relay's own origin (TM-01). Returns the gateway's answer.
     */
    async function steeredConfirmation(gateway: EnrollmentGateway) {
      const ceremony = await gateway.passkeyConfirmation();
      return gateway.confirmPasskey({
        type: "gateway-passkey",
        challenge: ceremony.challenge,
        credential: await assertionOn(owner, world.relayOrigin, ceremony.webauthnChallenge),
      });
    }

    test("from the first gateway's setup, a passkey added to an account that has Google takes two prompts on the account page: creating it, and Google vouching for it", async () => {
      const page = owner.page;
      // The gateway's own page, signed in with its admin token: nothing is confirmed yet and the
      // account has no passkey, so the last step offers to add one, and says nothing about phones.
      await page.goto(
        `${home.publicOrigin}/portal/settings/account?token=${encodeURIComponent(home.harness.apiKey)}`,
      );
      await expectText(page, "Finish setting up");
      await expectText(page, "Add a passkey (optional)");
      expect(await page.getByText(/phone/i).count()).toBe(0);
      await shot(page, "portal-add-passkey-step");
      // Its one button opens the account page in a new tab, remembering in this tab that the last
      // step comes back here. This test continues in this tab, which holds the passkey device.
      const [opened] = await Promise.all([
        page.waitForEvent("popup"),
        page.getByRole("link", { name: "Add a passkey", exact: true }).click(),
      ]);
      expect(new URL(opened.url()).searchParams.get("add")).toBe("passkey");
      await opened.close();
      await page.goto(`${world.relayOrigin}/_relay/account?add=passkey`);
      // Prompt one creates it.
      await page
        .getByRole("heading", { name: "Adding a passkey · step 1 of 3", exact: true })
        .waitFor();
      await shot(page, "relay-step-1");
      await clickFirst(page, ["Create passkey"]);
      await page
        .getByRole("heading", { name: "Adding a passkey · step 2 of 3", exact: true })
        .waitFor();
      // The page names what can vouch for it: the account's Google sign-in, as it has no passkey.
      await page.getByRole("button", { name: "Confirm with Google", exact: true }).waitFor();
      await shot(page, "relay-step-2");
      // Prompt two: Google vouches for it, and that is all the account page asks for.
      await clickFirst(page, ["Confirm with Google"]);
      await expectText(
        page,
        "Passkey added. To finish, go back to your gateway's page and use the new passkey once there.",
      );
      await shot(page, "relay-added");
      [passkey] = await passkeyIds(owner);
      expect(passkey).toBeDefined();
      // The passkey signed nothing on the relay's page.
      expect(storedCountersignatures(passkey!)).toBe(0);
      // The first gateway learns the passkey forwards, from the Google sign-in it pinned, as soon
      // as the owner comes back to its account page: the portal asks it to read the account.
      await page.goto(`${home.publicOrigin}/portal/settings/account`);
      await waitFor(
        async () => (await pins(home)).some((pin) => pin.id === passkey),
        "the first gateway to pin the added passkey",
      );
      expect(await pins(home)).toEqual([
        { type: "google", id: FakeGoogle.digest(OWNER_GOOGLE), source: "link-page" },
        { type: "passkey", id: passkey, source: "endorsed" },
      ]);
      expect(owner.errors).toEqual([]);
    }, 180_000);

    test("TM-01: the third prompt is on the gateway's own page, where one assertion confirms the passkey, and a relay page can't make it", async () => {
      // The relay steers the gateway's own ceremony to its page: the gateway refuses it.
      const steered = await steeredConfirmation(home);
      expect(steered.status).toBe(403);
      expect((await home.status()).deviceEnrollment.confirmedSignIns).toEqual([]);
      // Back on the gateway's page, the step is the sequence's third, and one prompt confirms it.
      const page = owner.page;
      await page.goto(`${home.publicOrigin}/portal/settings/account`);
      await expectText(page, "Adding a passkey · step 3 of 3");
      await shot(page, "portal-step-3");
      await clickFirst(page, ["Continue with passkey"]);
      const status = await waitFor(async () => {
        const value = await home.status();
        return value.deviceEnrollment.confirmedSignIns?.length ? value : undefined;
      }, "the passkey to be confirmed");
      expect(status.deviceEnrollment.confirmedSignIns).toEqual([
        expect.objectContaining({ type: "passkey", id: passkey, via: "gateway-origin" }),
      ]);
      await page.locator("#relay-setup-title").waitFor({ state: "detached", timeout: 20_000 });
      // It countersigned the Google account, which the gateway already had: nothing more to suggest.
      expect(await pins(home)).toEqual([
        { type: "google", id: FakeGoogle.digest(OWNER_GOOGLE), source: "link-page" },
        { type: "passkey", id: passkey, source: "endorsed" },
      ]);
      // Nothing of it is stored on the relay.
      expect(storedCountersignatures(passkey!)).toBe(0);
      expect(owner.errors).toEqual([]);
    }, 180_000);

    test("TM-02: the second gateway, linked with the passkey, suggests the Google account once the passkey countersigns it there, and holds a device that signs in with it", async () => {
      const linked = await connectGatewayBySignIn(cabin, owner, "existing");
      expect(linked.connect?.state).toBe("done");
      // The passkey is the only sign-in this gateway saw for itself, and the relay holds nothing
      // that signs for the account's others.
      await cabin.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
      await cabin.json("/admin/cloud-relay/account/refresh", { method: "POST", body: "{}" });
      expect(await pins(cabin)).toEqual([{ type: "passkey", id: passkey, source: "link-page" }]);
      expect((await cabin.status()).deviceEnrollment.policy).toBe("automatic");
      // A relay page can't make the confirmation here either, and pins nothing by trying.
      expect((await steeredConfirmation(cabin)).status).toBe(403);
      expect(await pins(cabin)).toEqual([{ type: "passkey", id: passkey, source: "link-page" }]);
      // The owner's one prompt on this gateway's page confirms the passkey and countersigns the
      // account's other sign-ins, so the Google account is suggested...
      const ceremony = await cabin.passkeyConfirmation();
      expect(ceremony.allowCredentials).toEqual([passkey]);
      await confirmPasskeyHere(cabin, owner);
      expect(await pins(cabin)).toEqual([
        { type: "passkey", id: passkey, source: "link-page" },
        { type: "google", id: FakeGoogle.digest(OWNER_GOOGLE), source: "countersigned" },
      ]);
      expect((await cabin.status()).deviceEnrollment).toMatchObject({
        confirmationNeeded: false,
        confirmedSignIns: [expect.objectContaining({ type: "passkey", id: passkey })],
      });
      // ...but a suggestion trusts nothing: a device signing in with Google on the relay's page
      // waits for the owner, who can't confirm a web sign-in by approving it.
      const name = "Fictional cabin CLI";
      const pairing = await pairWithGoogle(cabin, name, OWNER_GOOGLE);
      const held = await heldRequest(cabin, name, pairing);
      expect(held).toMatchObject({ kind: "cli", signIn: "google", canTrustSignIn: false });
      await waitFor(
        () => pairing.comparisons.length === 1,
        "the device to show its comparison code",
      );
      expect(pairing.comparisons).toEqual([held.verificationCode]);
      await cabin.decide(held.requestId, true, true);
      const joined = await pairing.result;
      expect((await cabin.devices()).find((device) => device.id === joined.deviceId)).toMatchObject(
        {
          kind: "cli",
          name,
          enrollment: { method: "approved", signIn: "google" },
        },
      );
      // Approving it confirmed nothing more.
      expect(
        (await cabin.status()).deviceEnrollment.confirmedSignIns?.map((value) => value.id),
      ).toEqual([passkey]);
    }, 300_000);

    test("a passkey removed from the account stays out when a relay compromised later lists it again with its evidence", async () => {
      // A second passkey, added on the account page and vouched for by the first.
      const second = await addSecondPasskey(browser, world, owner, {
        // The account has Google and one passkey: Google first, the passkey by name, and Google
        // again for a passkey that lives on another device.
        atConfirmation: async (page) => {
          const choices = await page.locator(".confirm button").allTextContents();
          expect(choices[0]).toBe("Confirm with Google");
          expect(choices[1]).toMatch(/^Confirm with your passkey “.+”, added /);
          expect(choices.slice(2)).toEqual(["Confirm with Google instead", "Cancel"]);
          await shot(page, "relay-step-2-named-passkey");
        },
      });
      const [added] = await passkeyIds(second);
      await cabin.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
      await waitFor(
        async () => (await pins(cabin)).some((pin) => pin.id === added),
        "the second gateway to pin the added passkey",
      );
      expect((await pins(cabin)).find((pin) => pin.id === added)?.source).toBe("endorsed");
      // What the relay holds about it, which a compromised relay would keep.
      const kept = asTheRelay((db) =>
        ["omnesis_passkeys", "omnesis_passkey_endorsements"].map((table) => ({
          table,
          rows: db.prepare(`SELECT * FROM ${table} WHERE credential_id = ?`).all(added),
        })),
      );
      expect(kept.map(({ rows }) => rows.length)).toEqual([1, 1]);
      // The owner removes it on the account page, and the gateway sees it gone.
      await freshAccountSignIn(world, owner);
      const remove = owner.page.getByRole("button", { name: "Remove", exact: true });
      expect(await remove.count()).toBe(2);
      await remove.last().click();
      await owner.page.getByRole("button", { name: "Sign in with Passkey", exact: true }).waitFor();
      await cabin.json("/admin/cloud-relay/reconnect", { method: "POST", body: "{}" });
      await waitFor(
        async () => !(await pins(cabin)).some((pin) => pin.id === added),
        "the removed passkey's pin to be dropped",
        60_000,
      );
      const before = await pins(cabin);
      // The relay turns: it puts the passkey back, with the endorsement that made it a suggestion,
      // and a device signs in with it.
      asTheRelay((db) => {
        for (const { table, rows } of kept)
          for (const row of rows as Record<string, unknown>[]) {
            const columns = Object.keys(row);
            db.prepare(
              `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            ).run(...columns.map((column) => row[column]));
          }
      });
      const name = "Fictional restored-passkey CLI";
      const pairing = await pairBySignIn(cabin, name, second, "Passkey");
      const held = await heldRequest(cabin, name, pairing);
      expect(held).toMatchObject({ kind: "cli", signIn: "passkey" });
      await cabin.decide(held.requestId, false);
      await expect(pairing.result).rejects.toThrow(/denied/);
      expect(await pins(cabin)).toEqual(before);
      expect((await cabin.devices()).some((device) => device.name === name)).toBe(false);
      // The account itself no longer has it once the relay is put right again.
      asTheRelay((db) => {
        for (const { table } of [...kept].reverse())
          db.prepare(`DELETE FROM ${table} WHERE credential_id = ?`).run(added);
      });
      await freshAccountSignIn(world, owner);
      await second.context.close();
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

      // The relay then makes up a countersignature by the owner's passkey naming its Google account
      // too, from an assertion it got that passkey to make on its own page for something else.
      const salt = randomBytes(32).toString("base64url"),
        issuedAt = String(Math.floor(Date.now() / 1000));
      const credential = await assertionOn(
        owner,
        world.relayOrigin,
        randomBytes(32).toString("base64url"),
      );
      asTheRelay((db) =>
        db.prepare("INSERT OR REPLACE INTO omnesis_passkey_countersignatures VALUES (?,?)").run(
          passkey,
          JSON.stringify({
            proof: { type: "passkey", salt, issuedAt, credential },
            signIns: [
              signInDigest({ type: "google", id: FakeGoogle.digest(OWNER_GOOGLE) }),
              signInDigest({ type: "google", id: injected }),
            ],
          }),
        ),
      );
      const written = "Fictional rewritten CLI";
      const second = await pairWithGoogle(cabin, written, RELAY_GOOGLE);
      const heldAgain = await heldRequest(cabin, written, second);
      expect(heldAgain).toMatchObject({ kind: "cli", signIn: "google" });
      await cabin.decide(heldAgain.requestId, false);
      await expect(second.result).rejects.toThrow(/denied/);
      // Nothing was added, and nothing the gateway already knew was lost.
      expect(await pins(cabin)).toEqual(before);
      expect(
        (await cabin.devices()).some((device) => [listed, written].includes(device.name)),
      ).toBe(false);
    }, 300_000);
  },
);

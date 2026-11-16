// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The account page's gateway list, end to end: a real relay daemon, two real gateways that
 * registered with their owner keys and were connected to one Omnesis account by signing in, and
 * a headless Chromium with a virtual passkey.
 *
 * Each gateway says whether the relay holds its tunnel right now, and the page reads that again
 * when its tab is shown again. Unlinking a gateway on the page takes it off the relay at once; a
 * running gateway then resets to "not connected", and one that was offline does so the first
 * time it starts, once, without asking the relay again and again. Either can be connected again
 * from scratch.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EnrollmentGateway,
  EnrollmentWorld,
  PasskeyBrowser,
  browserSuiteAvailable,
  connectGatewayBySignIn,
  expectText,
  waitFor,
  type CloudRelayStatus,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";
import type { Page } from "playwright";

const browserReady = browserSuiteAvailable("account-gateway-unlink.e2e");

type Status = CloudRelayStatus & { notice?: string; enabled: boolean };

/** No account, no registration, remote access off: what the portal's first-time screen shows. */
const disconnected = {
  enabled: false,
  enrollment: { state: "unconfigured" },
  tunnel: { state: "disabled" },
  account: { linked: false, activated: false },
};

/** What a person sees on the gateway's row of the account page: "Online", "Offline", or no row. */
async function presence(page: Page, hostname: string): Promise<string | undefined> {
  const row = page.locator(".gateway-item", { hasText: hostname });
  if ((await row.count()) === 0) return undefined;
  return (await row.locator(".presence").textContent()) ?? undefined;
}

/** The person comes back to the tab: hidden, then shown again, as switching tabs does. */
async function returnToTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const state of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
}

/** Waits for the row to say `expected`, returning to the tab between looks. */
async function expectPresence(page: Page, hostname: string, expected: string | undefined) {
  await waitFor(
    async () => {
      if ((await presence(page, hostname)) === expected) return true;
      await returnToTab(page);
      return false;
    },
    `${hostname} to read ${expected ?? "absent"} on the account page`,
    30_000,
  );
}

/**
 * Unlinks the gateway from its row of the account page: checks the in-page question, confirms with the passkey if
 * the sign-in is no longer fresh, and waits for the page to say it was unlinked.
 */
async function unlinkOnAccountPage(page: Page, hostname: string): Promise<string> {
  const row = page.locator(".gateway-item", { hasText: hostname });
  // The row's own "…" menu, beside its link.
  await row.getByRole("button", { name: /^More actions for / }).click();
  await row.getByRole("menuitem", { name: "Unlink from account", exact: true }).click();
  await expectText(page, "Nothing on the gateway is deleted. Its data stays where it is.");
  await expectText(
    page,
    "To use it from outside your home network again, connect it again from its settings.",
  );
  // Connecting may have taken longer than a sign-in stays fresh; then the passkey confirms and
  // unlinks in one step, as the panel says.
  const final = page.getByRole("button", { name: "Unlink gateway", exact: true });
  const confirm = page.getByRole("button", { name: "Confirm with passkey", exact: true });
  await final.or(confirm).first().waitFor({ timeout: 20_000 });
  await ((await confirm.isVisible()) ? confirm : final).click();
  const status = page.getByRole("status").filter({ hasText: "was unlinked from your account" });
  await status.waitFor({ timeout: 20_000 });
  return (await status.textContent()) ?? "";
}

describe.skipIf(!browserReady)("unlink a gateway on the account page", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let browser: PasskeyBrowser;
  let person: PasskeySession;
  let home: EnrollmentGateway;
  let cabin: EnrollmentGateway;

  beforeAll(
    async () => {
      directory = await mkdtemp(join(tmpdir(), "omnesis-account-unlink-"));
      world = await EnrollmentWorld.create(directory, { signupPolicy: "open" });
      browser = await PasskeyBrowser.launch(world);
      person = await browser.session();
      home = await EnrollmentGateway.start(world, "home");
      cabin = await EnrollmentGateway.start(world, "cabin");
      expect(await connectGatewayBySignIn(home, person, "create")).toMatchObject({
        connect: { state: "done" },
        account: { linked: true },
      });
      expect(await connectGatewayBySignIn(cabin, person, "existing")).toMatchObject({
        connect: { state: "done" },
        account: { linked: true },
      });
      await person.page.goto(`${world.relayOrigin}/_relay/account`);
      await expectText(person.page, cabin.hostname);
    },
    gatewayBootBudgetMs() * 2 + 180_000,
  );

  afterAll(async () => {
    try {
      await browser?.close();
      await home?.close().catch(() => undefined);
      await cabin?.close().catch(() => undefined);
      await world?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test(
    "each gateway shows online while the relay holds its tunnel, offline while it is stopped, and online again once it is back",
    async () => {
      const page = person.page;
      await expectPresence(page, home.hostname, "Online");
      await expectPresence(page, cabin.hostname, "Online");
      // The dot is never the only signal: the word is there, and the green is on the dot.
      const dot = page.locator(".gateway-item", { hasText: home.hostname }).locator(".presence");
      expect(await dot.getAttribute("class")).toBe("presence online");

      await cabin.harness.restartGateway(async () => {
        // Stopped: the relay drops its tunnel, and the page says so when the person looks again.
        await expectPresence(page, cabin.hostname, "Offline");
        await expectPresence(page, home.hostname, "Online");
        const offline = page.locator(".gateway-item", { hasText: cabin.hostname });
        expect(await offline.locator(".presence").getAttribute("class")).toBe("presence");
      });
      await waitFor(
        async () => (await cabin.status()).tunnel.state === "online",
        "cabin's tunnel to come back",
        gatewayBootBudgetMs(),
      );
      await expectPresence(page, cabin.hostname, "Online");
      expect(person.errors).toEqual([]);
    },
    gatewayBootBudgetMs() + 120_000,
  );

  test("unlinking a running gateway takes it off the relay at once, it resets to not connected with its data intact, and it can be connected again", async () => {
    const page = person.page;
    expect((await home.throughRelay("/health")).status).toBe(200);
    const devices = (await home.devices()).map((device) => device.id).sort();
    expect(devices.length).toBeGreaterThan(0);

    const said = await unlinkOnAccountPage(page, home.hostname);
    expect(said).toMatch(/^“.+” was unlinked from your account\.$/);
    // The row is gone and the other gateway stays.
    expect(await presence(page, home.hostname)).toBeUndefined();
    expect(await presence(page, cabin.hostname)).toBe("Online");

    // The relay closed its tunnel and routes its name nowhere.
    await waitFor(async () => {
      try {
        return (await home.throughRelay("/health")).status !== 200;
      } catch {
        return true;
      }
    }, "the relay to stop routing home");

    // The gateway learns it was unlinked and is as if it had never been linked.
    const after = await waitFor(
      async () => {
        const status = (await home.status()) as Status;
        return status.notice === "gateway-removed" ? status : undefined;
      },
      "home to learn it was unlinked",
      60_000,
    );
    expect(after).toMatchObject(disconnected);
    expect(after.connect).toBeUndefined();
    // Nothing on it was touched: the devices paired with it are all there.
    expect((await home.devices()).map((device) => device.id).sort()).toEqual(devices);
    // The other gateway carries on, linked and online.
    expect(await cabin.status()).toMatchObject({
      enabled: true,
      tunnel: { state: "online" },
      account: { linked: true },
    });

    // Connected again from scratch, from its own settings, it is back on the relay and the page.
    const again = await connectGatewayBySignIn(home, person, "existing");
    expect(again).toMatchObject({ connect: { state: "done" }, account: { linked: true } });
    expect((again as Status).notice).toBeUndefined();
    await waitFor(
      async () => (await home.throughRelay("/health").catch(() => undefined))?.status === 200,
      "home to be reachable through the relay again",
      60_000,
    );
    await page.goto(`${world.relayOrigin}/_relay/account`);
    await expectPresence(page, home.hostname, "Online");
    expect(person.errors).toEqual([]);
  }, 240_000);

  test(
    "a gateway unlinked while it is stopped resets the first time it starts, once, and the last unlink leaves an empty list",
    async () => {
      const page = person.page;
      const refusals = () =>
        world
          .relayLog()
          .split("\n")
          .filter((line) => line.includes("unlinked from its account")).length;
      let said = "";
      await cabin.harness.restartGateway(async () => {
        await expectPresence(page, cabin.hostname, "Offline");
        said = await unlinkOnAccountPage(page, cabin.hostname);
        expect(await presence(page, cabin.hostname)).toBeUndefined();
      });
      // The page told the person the gateway finds out later.
      expect(said).toMatch(
        /was unlinked from your account\. It shows as not connected the next time it comes online\.$/,
      );

      // Started again, it proves its keys, is told it was unlinked, and resets.
      const after = await waitFor(
        async () => {
          const status = (await cabin.status()) as Status;
          return status.notice === "gateway-removed" ? status : undefined;
        },
        "cabin to learn it was unlinked while stopped",
        gatewayBootBudgetMs() + 60_000,
      );
      expect(after).toMatchObject(disconnected);
      // It stops there: no more registrations, and the relay is not asked again.
      const told = refusals();
      expect(told).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(refusals()).toBe(told);
      expect(await cabin.status()).toMatchObject({ ...disconnected, notice: "gateway-removed" });

      // Unlinking the last gateway leaves an empty list that says how to connect one.
      await unlinkOnAccountPage(page, home.hostname);
      await expectText(
        page,
        "No gateways are connected to your Omnesis account. Connect one from its settings.",
      );
      await waitFor(
        async () => ((await home.status()) as Status).notice === "gateway-removed",
        "home to learn it was unlinked",
        60_000,
      );
      expect(person.errors).toEqual([]);
    },
    gatewayBootBudgetMs() + 240_000,
  );
});

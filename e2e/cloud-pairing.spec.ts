// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

const fingerprint = "a".repeat(64);
const codeNonce = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () =>
  readFileSync(join(process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR!, "token"), "utf8").trim();
function challenge() {
  const value = {
    requestId: randomUUID(),
    name: "Fictional test browser",
    secret: randomBytes(32).toString("hex"),
    gatewayFingerprint: fingerprint,
    expiresAt: Date.now() + 600_000,
  };
  // The code the gateway and the browser both work out, from docs/device-enrollment.md.
  const number = createHash("sha256")
    .update(
      JSON.stringify([
        "omnesis-pairing-code-v3",
        fingerprint,
        value.requestId,
        digest(value.secret),
        codeNonce,
      ]),
    )
    .digest()
    .readUIntBE(0, 6);
  const digits = String(number % 1_000_000).padStart(6, "0");
  const verificationCode = `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return { value, verificationCode };
}
async function configured(page: Page) {
  await page.route("**/devices/google/config", (route) =>
    route.fulfill({
      json: {
        clientId: "fictional-web-client",
        gatewayFingerprint: fingerprint,
        webSignIn: true,
      },
    }),
  );
}
/**
 * Answers with the gateway's own reply, amended. A page that moves on drops the request under way
 * and the reply with it; that is not a failure of the test.
 */
async function amend(
  route: Route,
  change: (body: Record<string, unknown>) => Record<string, unknown>,
) {
  try {
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) });
  } catch {
    await route.abort().catch(() => {});
  }
}
/** The gateway under test runs without the flag; the portal sees it on, as an opted-in gateway reports. */
async function relayOn(page: Page) {
  await page.route("**/status", (route) => amend(route, (body) => ({ ...body, cloudRelay: true })));
}
/** The same for a signed-out browser, which learns it from its session check. */
async function relayOnSignedOut(page: Page) {
  await page.route("**/portal/api/session", (route) =>
    amend(route, (body) => ({ ...body, cloudRelay: true })),
  );
}
async function pendingBrowser(page: Page, pairingCode: string, replaceCode = false) {
  await configured(page);
  await relayOnSignedOut(page);
  const { value, verificationCode } = challenge();
  await page.addInitScript((pending) => {
    if (new URL(location.href).searchParams.get("googlePairing") === pending.requestId)
      sessionStorage.setItem("omnesis.google-pairing", JSON.stringify(pending));
  }, value);
  await page.route("**/devices/google/poll", (route) =>
    route.fulfill({
      json: {
        status: "approved",
        // A substitute answers with the right code for a nonce of its own choosing.
        verificationCode,
        codeNonce: replaceCode ? "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY" : codeNonce,
        expiresAt: Date.now() + 60_000,
        pairingCode,
      },
    }),
  );
  await page.goto(`/portal/?googlePairing=${value.requestId}`);
  return { value, verificationCode };
}

test("without the flag the login page offers no sign-in and never asks for its configuration", async ({
  page,
}) => {
  let asked = false;
  await page.route("**/devices/google/config", (route) => {
    asked = true;
    return route.fulfill({
      json: { clientId: "fictional-web-client", gatewayFingerprint: fingerprint, webSignIn: true },
    });
  });
  await page.goto("/portal/");
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toHaveCount(0);
  expect(asked).toBe(false);
});

test("optional Google sign-in stays hidden when configuration is absent", async ({ page }) => {
  await relayOnSignedOut(page);
  await page.route("**/devices/google/config", (route) =>
    route.fulfill({ status: 404, body: "Not Found" }),
  );
  await page.goto("/portal/");
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toHaveCount(0);
});

test("device approval presents the complete comparison code and takes one explicit action", async ({
  page,
}) => {
  await configured(page);
  const { value, verificationCode } = challenge();
  let decided = false;
  await page.route("**/admin/cloud-pairing/requests", (route) =>
    route.fulfill({
      json: {
        items: decided
          ? []
          : [
              {
                requestId: value.requestId,
                name: "Fictional phone with a long device name for comparison",
                kind: "android",
                signIn: "google",
                status: "pending",
                verificationCode,
                expiresAt: value.expiresAt,
              },
            ],
      },
    }),
  );
  await page.route("**/admin/cloud-pairing/decision", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ requestId: value.requestId, approve: true });
    decided = true;
    await route.fulfill({ json: { ok: true } });
  });
  await relayOn(page);
  await page.goto(`/portal/?token=${encodeURIComponent(token())}`);
  await page.locator("nav.sidebar-nav").waitFor();
  await page.goto("/portal/settings/devices");
  const section = page.getByRole("region", { name: "Devices waiting for approval" });
  const card = section.getByRole("article");
  await expect(card).toHaveCount(1);
  // The card says one thing: who is waiting, the one sentence, the code as the gateway sent it.
  await expect(card.locator(":scope > *")).toHaveText([
    "Fictional phone with a long device name for comparison",
    "Android app · Google",
    "A device signed in to your Omnesis account and is waiting for your approval to pair to this gateway. Approve if the code below matches the code shown on the device.",
    verificationCode,
    /^\s*Approve\s*Deny\s*$/,
  ]);
  const approve = section.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled();
  await expect(section.getByRole("button")).toHaveText(["Approve", "Deny"]);
  await expect(section.getByRole("checkbox")).toHaveCount(0);
  // The same space above the first line and below the last one.
  const space = await card.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const first = node.firstElementChild!.getBoundingClientRect();
    const last = node.lastElementChild!.getBoundingClientRect();
    return { top: first.top - box.top, bottom: box.bottom - last.bottom };
  });
  expect(Math.abs(space.top - space.bottom)).toBeLessThanOrEqual(1);
  // On its own page the cards are the notice: no strip above them.
  await expect(page.locator(".cloud-pairing-notice")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("approval-card-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath("approval-card-mobile.png"),
    fullPage: true,
  });
  await section.screenshot({ path: "/tmp/omnesis-cloud-pairing-owner.png" });
  await approve.click();
  // Nothing left waiting: the section steps out of the way.
  await expect(section).toHaveCount(0);
  expect(decided).toBe(true);
});

test("a request the gateway still lists as approved, denied or out of time is not waiting", async ({
  page,
}) => {
  await configured(page);
  const row = (name: string, more: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    name,
    kind: "ios",
    status: "pending",
    verificationCode: "000 111",
    expiresAt: Date.now() + 600_000,
    ...more,
  });
  let items = [
    row("Fictional tablet"),
    row("Fictional laptop", { status: "approved" }),
    row("Fictional desktop", { status: "denied" }),
    row("Fictional watch", { expiresAt: Date.now() - 1 }),
  ];
  await page.route("**/admin/cloud-pairing/requests", (route) =>
    route.fulfill({ json: { items } }),
  );
  await relayOn(page);
  await page.goto(`/portal/?token=${encodeURIComponent(token())}`);
  await page.locator("nav.sidebar-nav").waitFor();
  await page.goto("/portal/settings/devices");
  const section = page.getByRole("region", { name: "Devices waiting for approval" });
  await expect(section.getByRole("article")).toHaveCount(1);
  await expect(section.getByRole("heading", { level: 3 })).toHaveText(["Fictional tablet"]);
  await expect(section.getByText("000 111", { exact: true })).toBeVisible();
  items = items.slice(1);
  await expect(section).toHaveCount(0);
});

test("a device waiting for approval is announced above every page, in the page flow, and the strip leads to its card", async ({
  page,
}) => {
  await configured(page);
  const row = (name: string) => ({
    requestId: randomUUID(),
    name,
    kind: "ios",
    status: "pending",
    verificationCode: "000 111",
    expiresAt: Date.now() + 600_000,
  });
  let items: Array<Record<string, unknown>> = [row("Fictional tablet"), row("Fictional laptop")];
  await page.route("**/admin/cloud-pairing/requests", (route) =>
    route.fulfill({ json: { items } }),
  );
  await relayOn(page);
  await page.goto(`/portal/?token=${encodeURIComponent(token())}`);
  await page.locator("nav.sidebar-nav").waitFor();
  const strip = page.getByRole("region", { name: "Devices waiting for approval" });
  for (const path of ["/portal/", "/portal/sources", "/portal/settings/access"]) {
    await page.goto(path);
    // Several requests share one strip, with a count.
    await expect(strip).toHaveCount(1);
    await expect(strip).toContainText(
      "2 devices are waiting for your approval to pair to this gateway.",
    );
    // It takes its own room at the top of the page: nothing after it starts above its bottom edge.
    const overlap = await strip.evaluate((node) => {
      const bottom = node.getBoundingClientRect().bottom;
      const main = node.parentElement!;
      if (main.firstElementChild !== node) return "not first";
      return [...main.children]
        .slice(1)
        .filter((item) => item.getBoundingClientRect().height > 0)
        .every((item) => item.getBoundingClientRect().top >= bottom)
        ? "clear"
        : "covered";
    });
    expect(overlap, path).toBe("clear");
  }
  await page.goto("/portal/sources");
  await expect(strip).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("banner-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(strip).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath("banner-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  // An access request from an MCP client uses the same strip on its own page. Both show, one under the other.
  await page.route("**/admin/access", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await amend(route, (body) => ({
      ...body,
      pendingRequests: [
        {
          id: "approval-fictional",
          clientName: "Fictional client",
          createdAt: Date.now(),
          expiresAt: Date.now() + 300_000,
        },
      ],
    }));
  });
  await page.goto("/portal/settings/access");
  const strips = page.locator("section.access-pending");
  await expect(strips).toHaveCount(2);
  await expect(strips.nth(1)).toContainText("Fictional client wants to connect");
  const boxes = await strips.evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }),
  );
  expect(boxes[1].top).toBeGreaterThanOrEqual(boxes[0].bottom);
  await page.screenshot({
    path: test.info().outputPath("banner-both-desktop.png"),
    fullPage: true,
  });
  await page.unroute("**/admin/access");

  // One request answered: the count goes, the strip stays.
  items = items.slice(1);
  await expect(strip).toContainText(
    "A device is waiting for your approval to pair to this gateway.",
    { timeout: 15_000 },
  );
  await strip.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(/\/portal\/settings\/devices$/);
  await expect(
    page.getByRole("region", { name: "Devices waiting for approval" }).getByRole("article"),
  ).toHaveCount(1);
  await expect(page.locator(".cloud-pairing-notice")).toHaveCount(0);

  // Nothing waiting any more: no strip on any page.
  items = [];
  const read = page.waitForResponse("**/admin/cloud-pairing/requests");
  await page.goto("/portal/sources");
  await read;
  await expect(strip).toHaveCount(0);
});

test("a device that joined by signing in has the same actions as any other, all under one menu", async ({
  page,
}) => {
  await configured(page);
  await page.route("**/admin/cloud-pairing/requests", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  const fixture = (id: string, name: string, more: Record<string, unknown> = {}) => ({
    id,
    name,
    kind: "ios",
    pairedAt: Date.now() - 60_000,
    lastSeenAt: Date.now() - 30_000,
    online: true,
    revokedAt: null,
    capabilities: {},
    ...more,
  });
  await page.route("**/admin/devices", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        items: [
          ...body.items,
          fixture("device_fixture_signed_in", "Fictional phone", {
            enrollment: { method: "automatic", signIn: "passkey", joinedAt: Date.now() - 60_000 },
          }),
          fixture("device_fixture_approved", "Fictional tablet", {
            enrollment: { method: "approved", signIn: "google", joinedAt: Date.now() - 60_000 },
          }),
          fixture("device_fixture_revoked", "Fictional laptop", {
            kind: "cli",
            online: false,
            revokedAt: Date.now() - 10_000,
            enrollment: { method: "automatic", signIn: "google", joinedAt: Date.now() - 60_000 },
          }),
        ],
      },
    });
  });
  await relayOn(page);
  await page.goto(`/portal/?token=${encodeURIComponent(token())}`);
  await page.locator("nav.sidebar-nav").waitFor();
  await page.goto("/portal/settings/devices");
  const card = (id: string) => page.locator(`#device-${id}`);
  await expect(card("device_fixture_signed_in").locator(".devices-card-sub")).toHaveText(
    /· Joined with Omnesis account$/,
  );
  await expect(card("device_fixture_approved").locator(".devices-card-sub")).toHaveText(
    /· Approved$/,
  );
  // One menu holds the actions; the card has no other button for them.
  const joined = card("device_fixture_signed_in");
  await expect(joined.getByRole("button", { name: /Revoke|Remove|Forget/ })).toHaveCount(0);
  await joined.getByRole("button", { name: "Device actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Repair device", "Revoke device"]);
  await page.screenshot({
    path: test.info().outputPath("device-menu-desktop.png"),
    fullPage: true,
  });
  // Revoking asks first.
  await menu.getByRole("menuitem", { name: "Revoke device" }).click();
  await expect(page.getByText('Revoke device "Fictional phone"?')).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  // A revoked device can be brought back or forgotten, and nothing else.
  await page.getByRole("button", { name: /^\s*▸?\s*Other devices/ }).click();
  await card("device_fixture_revoked").getByRole("button", { name: "Device actions" }).click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Repair device", "Forget device"]);
  // Escape closes it. The menu starts listening a frame after it opens, so press until it has.
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await page.setViewportSize({ width: 390, height: 844 });
  await joined.getByRole("button", { name: "Device actions" }).scrollIntoViewIfNeeded();
  await joined.getByRole("button", { name: "Device actions" }).click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Repair device", "Revoke device"]);
  await page.screenshot({ path: test.info().outputPath("device-menu-mobile.png") });
});

test("without the flag no page asks for waiting devices or shows the strip", async ({ page }) => {
  await configured(page);
  let asked = false;
  await page.route("**/admin/cloud-pairing/requests", (route) => {
    asked = true;
    return route.fulfill({
      json: {
        items: [
          {
            requestId: randomUUID(),
            name: "Fictional tablet",
            kind: "ios",
            status: "pending",
            verificationCode: "000 111",
            expiresAt: Date.now() + 600_000,
          },
        ],
      },
    });
  });
  await page.goto(`/portal/?token=${encodeURIComponent(token())}`);
  await page.locator("nav.sidebar-nav").waitFor();
  await page.goto("/portal/sources");
  await expect(page.locator("nav.sidebar-nav")).toBeVisible();
  await expect(page.locator(".cloud-pairing-notice")).toHaveCount(0);
  expect(asked).toBe(false);
});

test("without the flag the devices page asks for no device approvals", async ({ page }) => {
  await configured(page);
  let asked = false;
  await page.route("**/admin/cloud-pairing/requests", (route) => {
    asked = true;
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(`/portal/?token=${encodeURIComponent(token())}`);
  await page.locator("nav.sidebar-nav").waitFor();
  await page.goto("/portal/settings/devices");
  await expect(page.getByRole("button", { name: "Pair device", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Devices waiting for approval" })).toHaveCount(0);
  expect(asked).toBe(false);
});

test("remote approval cannot pair a browser until its user confirms the locally calculated code", async ({
  page,
  request,
}) => {
  const response = await request.post("/admin/devices/pair", {
    headers: { Authorization: `Bearer ${token()}` },
    data: { kind: "portal", name: "Fictional Google browser" },
  });
  expect(response.ok()).toBe(true);
  const pairing = await response.json();
  const { verificationCode } = await pendingBrowser(page, pairing.pairingCode);
  await expect(page.getByText("Approved by your gateway.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Codes match, pair this device", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("nav.sidebar-nav")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText(verificationCode, { exact: true })).toBeVisible();
  expect(verificationCode).toMatch(/^[0-9]{3} [0-9]{3}$/);
  await expect(
    page.getByText(
      "Check that this code matches the one shown on your other device, then approve it there.",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("browser-waiting-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/omnesis-cloud-pairing-browser.png", fullPage: true });
  await page.getByRole("button", { name: "Codes match, pair this device", exact: true }).click();
  await expect(page.locator("nav.sidebar-nav")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("omnesis.google-pairing"))).toBeNull();
});

test("a substituted gateway code fails closed even when a remote response says approved", async ({
  page,
}) => {
  await pendingBrowser(page, "UNTRUSTED-CODE", true);
  await expect(page.getByRole("alert")).toContainText("gateway or pairing request changed");
  // The attempt is over: no code was shown and nothing is left to pair with.
  await expect(page.locator(".cloud-pairing-code")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Codes match, pair this device", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("omnesis.google-pairing"))).toBeNull();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

test("with account sign-in the login page offers the Omnesis account, with a passkey or Google", async ({
  page,
}) => {
  await page.route("**/devices/google/config", (route) =>
    route.fulfill({
      json: {
        gatewayFingerprint: fingerprint,
        webSignIn: true,
        accountSignIn: true,
        automaticEnrollment: true,
      },
    }),
  );
  await relayOnSignedOut(page);
  await page.goto("/portal/");
  const signIn = page.getByRole("region", { name: "Omnesis account sign-in" });
  await expect(
    signIn.getByRole("heading", { name: "Sign in with your Omnesis account", exact: true }),
  ).toBeVisible();
  await expect(signIn.getByRole("button", { name: "Sign in with Passkey" })).toBeVisible();
  await expect(signIn.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  // Token login stays the first option.
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("account-login.png"), fullPage: true });
});

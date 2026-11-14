// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

function initial() {
  return {
    revision: 1,
    identities: [
      {
        id: "direct",
        names: ["direct.example.test"],
        kind: "self-signed",
        state: "valid",
        expiresAt: "2029-01-01T00:00:00Z",
        pinPolicy: "existing-device-policy",
      },
    ],
    enabled: false,
    configured: false,
    serviceConfigured: true,
    config: { termsAccepted: false, invitationRequired: true },
    enrollment: { state: "unconfigured" },
    tunnel: { state: "disabled" },
    certificate: { state: "unconfigured" },
    publicMcp: { ready: false },
    google: { configured: false },
    can: { configure: true, enable: false, disable: false, reconnect: false, renew: false },
  };
}
/** The gateway under test runs without the flag; the portal sees it on, as an opted-in gateway reports. */
async function relayOn(page: Page) {
  await page.route("**/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), experimental: false, cloudRelay: true },
    });
  });
}
async function signIn(page: Page) {
  const token = readFileSync(
    join(process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR!, "token"),
    "utf8",
  ).trim();
  await page.goto(`/portal/?token=${encodeURIComponent(token)}`);
  await page.locator("nav.sidebar-nav").waitFor();
}
const CONNECTED = {
  enabled: true,
  configured: true,
  hostname: "g-fictional.relay.example.test",
  enrollment: { state: "enrolled" },
  tunnel: { state: "online", lastConnectedAt: "2028-01-01T00:00:00Z" },
  certificate: { state: "valid", expiresAt: "2029-01-01T00:00:00Z" },
  can: { configure: false, enable: false, disable: true, reconnect: true, renew: true },
};
async function management(
  page: Page,
  google: Record<string, unknown> = { configured: false },
  overrides: Record<string, unknown> = {},
) {
  let status: Record<string, any> = { ...initial(), google, ...overrides };
  const calls: Array<{ operation: string; body: unknown }> = [];
  await relayOn(page);
  await page.route("**/admin/cloud-relay**", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").slice(3).join("/");
    if (operation) {
      const body = route.request().postDataJSON();
      calls.push({ operation, body });
      expect(route.request().headers()["x-omnesis-csrf"]).toBeTruthy();
      if (operation === "google/link") {
        await route.fulfill({
          json: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fictional" },
        });
        return;
      }
      if (operation === "account/unlink")
        status = {
          ...status,
          account: { ...status.account, linked: false, canLink: true, canUnlink: false },
          deviceEnrollment: undefined,
        };
      if (operation === "google/unlink")
        status = {
          ...status,
          google: { ...status.google, linked: false, canLink: true, canUnlink: false },
        };
      if (operation === "enrollment")
        status = {
          ...status,
          deviceEnrollment: { ...status.deviceEnrollment, policy: body.policy },
        };
      if (operation === "enable" || operation === "reconnect")
        status = {
          ...status,
          revision: 3,
          enabled: true,
          enrollment: { state: "enrolled" },
          tunnel: { state: "online", lastConnectedAt: "2028-01-01T00:00:00Z" },
          certificate: {
            state: "valid",
            expiresAt: "2028-03-01T00:00:00Z",
            lastRenewedAt: "2028-01-01T00:00:00Z",
          },
          publicMcp: { ready: true, url: "https://g-fictional.relay.example.test/mcp" },
          can: { configure: false, enable: false, disable: true, reconnect: true, renew: true },
        };
      if (operation === "disable")
        status = {
          ...status,
          revision: 4,
          enabled: false,
          tunnel: { state: "disabled" },
          publicMcp: { ready: false },
          can: { configure: true, enable: true, disable: false, reconnect: false, renew: false },
        };
    }
    await route.fulfill({ json: status });
  });
  await signIn(page);
  await page.goto("/portal/settings/account");
  await expect(page.locator(".relay-view .relay-headline")).toBeVisible();
  return {
    calls,
    setGoogle: (google: Record<string, unknown>) => {
      status = { ...status, google };
    },
    set: (patch: Record<string, unknown>) => {
      status = { ...status, ...patch };
    },
  };
}

const ACCOUNT = {
  activated: true,
  configured: true,
  linked: true,
  canLink: false,
  canUnlink: true,
  pendingUnlink: false,
};
const TURN_OFF_TIP =
  "Stops access from outside your home network. This gateway keeps its address and stays in your Omnesis account. You can turn it back on at any time.";
const TURN_ON_TIP =
  "Makes this gateway reachable from outside your home network again, at the same address.";

test("portal offers no manual setup form; connected it is three plain sections, a problem is one box with details to copy, and it turns off and on", async ({
  page,
  context,
}) => {
  const first = await management(page);
  await expect(
    page.getByRole("heading", { name: "Enroll this gateway in your Omnesis Account" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "An Omnesis account lets you reach your gateway from your phone and laptop outside your home network and pair new devices by signing in. Traffic is encrypted end to end, and the keys never leave this gateway. Connecting gives this gateway a public address and a certificate.",
      { exact: true },
    ),
  ).toBeVisible();
  // Two buttons and nothing to fill in: a self-hosted relay is set up from the environment or the CLI.
  await expect(page.locator(".relay-view").locator("details, form, input")).toHaveCount(0);
  await expect(page.locator(".relay-view")).not.toContainText("terms of service");
  await expect(page.locator(".relay-view")).not.toContainText("in preview");
  await expect(page.locator("body")).not.toContainText("relay.omnesis.app");
  expect(first.calls).toEqual([]);
  await page.unroute("**/admin/cloud-relay**");
  await page.setViewportSize({ width: 1280, height: 900 });
  const relay = await management(
    page,
    { configured: false },
    {
      ...CONNECTED,
      gatewayId: "00000000-0000-4000-8000-000000000001",
      publicOrigin: "https://g-fictional.relay.example.test",
      publicMcp: { ready: true, url: "https://g-fictional.relay.example.test/mcp" },
      config: {
        relayUrl: "https://relay.example.test",
        termsAccepted: true,
        invitationRequired: false,
      },
      account: ACCOUNT,
      deviceEnrollment: {
        policy: "automatic",
        trustedSignIns: [{ type: "passkey", id: "fictional-credential", addedAt: 1 }],
      },
    },
  );
  const view = page.locator(".relay-view");
  await expect(
    page.getByRole("heading", { name: "Connected as g-fictional.relay.example.test" }),
  ).toBeVisible();
  await expect(view.getByRole("heading", { level: 3 })).toHaveText([
    "Account",
    "Remote access",
    "New devices",
  ]);
  await expect(page.getByText("https://g-fictional.relay.example.test/mcp")).toBeVisible();
  // A ready address needs no hint under it.
  await expect(view.locator(".relay-address + .relay-hint")).toHaveCount(0);
  // The page is not a debugging record: that is `omnesis cloud status`.
  for (const gone of [
    "Connection details",
    "Sign-in methods",
    "certificate",
    "Gateway ID",
    "Recovery receipt",
  ])
    await expect(view).not.toContainText(gone);
  await expect(view.locator(".relay-problems")).toHaveCount(0);
  // The two empty names are the icon buttons that copy the portal link and the address.
  await expect(view.getByRole("button")).toHaveText(["Unlink this gateway", "", "", "Turn off"]);
  // The portal at the public address is offered as a link that opens it.
  const portal = view.locator(".relay-portal a");
  await expect(portal).toHaveAttribute("href", /^https:\/\/[^/]+\/portal\/$/);
  await expect(view).toContainText(
    "Your portal is now reachable at this link from anywhere, not only at home.",
  );
  await page.screenshot({ path: "/tmp/omnesis-relay-connected-desktop.png", fullPage: true });

  // Turn off explains itself to a pointer (title), a screen reader (description) and a keyboard (shown on focus).
  const turnOff = page.getByRole("button", { name: "Turn off", exact: true });
  await expect(turnOff).toHaveAttribute("title", TURN_OFF_TIP);
  await expect(turnOff).toHaveAccessibleDescription(TURN_OFF_TIP);
  await expect(page.getByRole("tooltip")).toBeHidden();
  await turnOff.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(turnOff).toBeFocused();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveText(TURN_OFF_TIP);
  await page.keyboard.press("Shift+Tab");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/omnesis-relay-connected-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // The address is still being checked: a calm line, not an error.
  relay.set({
    publicMcp: { ready: false, url: "https://g-fictional.relay.example.test/mcp" },
  });
  await page.reload();
  await expect(
    page.getByText(
      "Checking that this address answers. This takes up to a minute after the gateway connects.",
    ),
  ).toBeVisible();
  await expect(view.locator(".relay-problems")).toHaveCount(0);

  // Something is wrong: one box, plain sentences, details to copy.
  relay.set({
    certificate: {
      state: "valid",
      expiresAt: "2029-01-01T00:00:00Z",
      lastError: "certificate-renewal-failed",
    },
    publicMcp: {
      ready: false,
      url: "https://g-fictional.relay.example.test/mcp",
      lastError: "public-endpoint-unreachable",
    },
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  const problems = view.locator(".relay-problems");
  await expect(problems).toHaveCount(1);
  await expect(problems.getByRole("alert")).toHaveText([
    "The certificate for this gateway's address could not be renewed. The gateway tries again by itself.",
    "This gateway's address does not answer from outside your home network. Check that this gateway is online. It checks again by itself.",
  ]);
  await expect(problems).toContainText("omnesis cloud status");
  await expect(page.getByText("This address does not answer right now.")).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await problems.getByRole("button", { name: "Copy details", exact: true }).click();
  await expect(problems.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  for (const line of [
    "Omnesis account details",
    "Page state: connected",
    "Error codes: certificate-renewal-failed (certificate), public-endpoint-unreachable (address)",
    "Remote access: on",
    "Address: https://g-fictional.relay.example.test/mcp (not answering)",
    "Registration: enrolled, gateway ID 00000000-0000-4000-8000-000000000001",
    "Tunnel: online, last connected 2028-01-01T00:00:00.000Z",
    "Public certificate: valid, expires 2029-01-01T00:00:00.000Z, last renewed not recorded",
    "Home certificate: self-signed, valid, expires 2029-01-01T00:00:00.000Z",
    "Account: linked",
    "New devices: automatic, 1 trusted sign-ins",
  ])
    expect(copied.split(/\r?\n/)).toContain(line);
  expect(copied).toMatch(/\nGateway version: \d+\.\d+\.\d+/);
  expect(copied).not.toContain("fictional-credential");
  await page.screenshot({ path: "/tmp/omnesis-relay-problem-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/omnesis-relay-problem-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // Off: the headline turns it back on, and the account can still be managed or left.
  await page.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Remote access is off" })).toBeVisible();
  const turnOn = page.getByRole("button", { name: "Turn on", exact: true });
  await expect(turnOn).toHaveCount(1);
  await expect(turnOn).toBeEnabled();
  await expect(turnOn).toHaveAttribute("title", TURN_ON_TIP);
  await expect(turnOn).toHaveAccessibleDescription(TURN_ON_TIP);
  await expect(page.getByRole("link", { name: "Manage your account" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Unlink this gateway", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/omnesis-relay-off-mobile.png", fullPage: true });
  await turnOn.click();
  await expect(
    page.getByRole("heading", { name: "Connected as g-fictional.relay.example.test" }),
  ).toBeVisible();
  expect(relay.calls.map((x) => x.operation)).toEqual(["disable", "enable"]);
});

test("an unavailable installation service disables setup without offering a relay URL override", async ({
  page,
}) => {
  const { calls } = await management(page, { configured: false }, { serviceConfigured: false });
  await expect(page.getByRole("heading", { name: "Remote access isn't available" })).toBeVisible();
  await expect(
    page.getByText(
      "This installation is not set up for Omnesis accounts. Direct connections and QR pairing keep working.",
    ),
  ).toBeVisible();
  for (const name of ["Connect", "Create an Omnesis account", "I already have one"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.locator(".relay-view").locator("details, form, input")).toHaveCount(0);
  expect(calls).toEqual([]);
});

test("portal keeps setup actionable after errors and does not render server secrets", async ({
  page,
}) => {
  const { calls } = await management(page);
  await page.route("**/admin/cloud-relay/connect", (route) =>
    route.fulfill({ status: 503, json: { error: "private-key-secret /private/path" } }),
  );
  await page.getByRole("button", { name: "Create an Omnesis account", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn't load or update your Omnesis account settings. Check the connection and try again.",
  );
  await expect(page.getByText("private-key-secret", { exact: false })).toHaveCount(0);
  for (const name of ["Create an Omnesis account", "I already have one"])
    await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
  expect(calls).toEqual([]);
});

test("creating an account and using one are two explicit choices, and each tells the gateway which", async ({
  page,
}) => {
  const { calls } = await management(page);
  // A relay that is not invite-only adds nothing to the two choices.
  await expect(page.locator(".relay-invite")).toHaveCount(0);
  // One "Connect" that might create an account as a side effect is gone.
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  const create = page.getByRole("button", { name: "Create an Omnesis account", exact: true });
  const existing = page.getByRole("button", { name: "I already have one", exact: true });
  await create.click();
  await expect
    .poll(() => calls)
    .toEqual([{ operation: "connect", body: { termsAccepted: true, intent: "create" } }]);
  await expect(existing).toBeEnabled();
  await existing.click();
  await expect
    .poll(() => calls.at(-1))
    .toEqual({ operation: "connect", body: { termsAccepted: true, intent: "existing" } });
  expect(calls).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(create).toBeVisible();
  await expect(existing).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("account-choices-mobile.png"),
    fullPage: true,
  });
});

test("an invite-only relay says so above the two choices, with where to request access and its host", async ({
  page,
}) => {
  const requestAccessUrl = "https://groups.example.com/g/fictional-testers";
  const { calls } = await management(
    page,
    { configured: false },
    { signup: { inviteOnly: true, requestAccessUrl } },
  );
  const notice = page.locator(".relay-hero .relay-invite");
  await expect(notice).toHaveText(
    "Omnesis accounts are invite-only for now. Request access (groups.example.com) — you can create your account once it's approved.",
  );
  const request = notice.getByRole("link", { name: "Request access", exact: true });
  await expect(request).toHaveAttribute("href", requestAccessUrl);
  await expect(request).toHaveAttribute("target", "_blank");
  await expect(request).toHaveAttribute("rel", "noopener noreferrer");
  const create = page.getByRole("button", { name: "Create an Omnesis account", exact: true });
  await expect(create).toBeEnabled();
  await expect(page.getByRole("button", { name: "I already have one", exact: true })).toBeEnabled();
  // The notice sits above the choices.
  const noticeBox = (await notice.boundingBox())!;
  expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual((await create.boundingBox())!.y);
  await page.screenshot({
    path: test.info().outputPath("account-invite-only.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(request).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("account-invite-only-mobile.png"),
    fullPage: true,
  });
  expect(calls).toEqual([]);
});

test("Google management navigates only to the real authorization endpoint, then unlinks without changing relay enrollment", async ({
  page,
  baseURL,
}) => {
  const configuration = { configured: true, canLink: true, linkOrigin: baseURL };
  const { calls, setGoogle } = await management(page, configuration, CONNECTED);
  await page.route("https://accounts.google.com/o/oauth2/v2/auth**", async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({
      contentType: "text/html",
      body: "<main>Isolated Google authorization fixture</main>",
    });
  });
  await page.getByRole("button", { name: "Connect with Google", exact: true }).click();
  await expect(page).toHaveURL("https://accounts.google.com/o/oauth2/v2/auth?state=fictional");
  expect(calls.at(-1)?.operation).toBe("google/link");
  setGoogle({
    configured: true,
    linked: true,
    canLink: true,
    canUnlink: true,
    linkOrigin: baseURL,
  });
  await page.goto("/portal/settings/account");
  await expect(
    page.getByText("This gateway is linked with Google.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unlink this gateway", exact: true }).click();
  // Nothing happens until the second, explicit press.
  expect(calls.map((x) => x.operation)).toEqual(["google/link"]);
  await page.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unlink this gateway", exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Connect with Google", exact: true }),
  ).toBeVisible();
  expect(calls.map((x) => x.operation)).toEqual(["google/link", "google/unlink"]);
  await expect(
    page.getByRole("heading", { name: "Connected as g-fictional.relay.example.test" }),
  ).toBeVisible();
});

const PATH_DEVICES = [
  "Fictional local collector",
  "Fictional relay phone",
  "Fictional reconnecting phone",
  "Fictional direct legacy",
];
async function pathDevices(page: Page) {
  await page.route("**/admin/devices", (route) =>
    route.fulfill({
      json: {
        items: PATH_DEVICES.map((name, index) => ({
          id: `device-${index}`,
          name,
          kind: index === 0 ? "collector" : "android",
          capabilities: {},
          pairedAt: 1,
          lastSeenAt: Date.now(),
          online: index !== 2,
          connectionPath: ["local", "relay", "reconnecting", undefined][index],
        })),
      },
    }),
  );
}

test("device pills distinguish reported local, relay and reconnecting paths while legacy devices retain ordinary presence", async ({
  page,
}) => {
  await relayOn(page);
  await pathDevices(page);
  await signIn(page);
  await page.goto("/portal/settings/devices");
  await page.getByRole("button", { name: /^Other devices/ }).click();
  for (const [name, label] of PATH_DEVICES.slice(0, 3).map((name, index) => [
    name,
    ["Local", "Remote", "Reconnecting"][index],
  ])) {
    const card = page
      .locator(".devices-card")
      .filter({ has: page.getByText(name, { exact: true }) });
    await expect(card.locator(".device-connection-pill")).toHaveText(label!);
  }
  await expect(
    page
      .locator(".devices-card")
      .filter({ has: page.getByText(PATH_DEVICES[3]!, { exact: true }) })
      .locator(".device-connection-pill"),
  ).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/omnesis-device-connection-pills-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.screenshot({
    path: "/tmp/omnesis-device-connection-pills-mobile.png",
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("without the flag the devices page shows no connection pills", async ({ page }) => {
  await pathDevices(page);
  await signIn(page);
  await page.goto("/portal/settings/devices");
  await page.getByRole("button", { name: /^Other devices/ }).click();
  for (const name of PATH_DEVICES)
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator(".device-connection-pill")).toHaveCount(0);
});

test("the account row offers the account page and a disconnect that asks first, says what happens and avoids conflicting Google actions", async ({
  page,
}) => {
  const relay = await management(
    page,
    { configured: true, linked: true, canLink: true, canUnlink: true },
    {
      ...CONNECTED,
      publicMcp: { ready: true, url: "https://gateway.example.test/mcp" },
      config: {
        relayUrl: "https://relay.example.test",
        termsAccepted: true,
        invitationRequired: false,
      },
      account: ACCOUNT,
    },
  );
  await expect(
    page.getByText("This gateway is linked to your Omnesis account.", { exact: true }),
  ).toBeVisible();
  const disconnect = page.getByRole("button", { name: "Unlink this gateway", exact: true });
  await expect(disconnect).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Connect with Google", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("This gateway is linked with Google.")).toHaveCount(0);
  // One button to the account page replaces the old sign-in methods row.
  const manage = page.getByRole("link", { name: "Manage your account", exact: true });
  await expect(manage).toHaveAttribute("href", "https://relay.example.test/_relay/account");
  await expect(manage).toHaveAttribute("target", "_blank");
  await expect(page.getByText("Sign-in methods")).toHaveCount(0);
  await expect(page.getByText("https://relay.example.test", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("gateway-account-desktop.png"),
    fullPage: true,
  });

  let dialogs = 0;
  page.on("dialog", () => dialogs++);
  await disconnect.click();
  const confirm = page.getByRole("group", {
    name: "Unlink this gateway from your Omnesis account?",
  });
  await expect(confirm).toContainText(
    "This gateway leaves your Omnesis account. It can no longer be reached from outside your home network, and devices can no longer join by signing in. Devices already paired keep working on your home network.",
  );
  expect(relay.calls).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/omnesis-relay-disconnect-confirm-mobile.png",
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(relay.calls).toEqual([]);
  await disconnect.click();
  await confirm.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(
    page.getByText("This gateway is not linked to an Omnesis account.", { exact: true }),
  ).toBeVisible();
  expect(relay.calls.map((x) => x.operation)).toEqual(["account/unlink"]);
  expect(dialogs).toBe(0);
  // Leaving the account leaves remote access as it was.
  await expect(
    page.getByRole("heading", { name: "Connected as g-fictional.relay.example.test" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn off", exact: true })).toBeEnabled();
});

test("a freshly linked gateway shows its settings at once with automatic joining selected, and Ask me first is one click", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // What a gateway reports right after linking: no stored choice, so the policy is automatic.
  const relay = await management(
    page,
    { configured: false },
    {
      ...CONNECTED,
      publicMcp: { ready: true, url: "https://gateway.example.test/mcp" },
      config: {
        relayUrl: "https://relay.example.test",
        termsAccepted: true,
        invitationRequired: false,
      },
      account: {
        activated: true,
        configured: true,
        linked: true,
        canLink: false,
        canUnlink: true,
        pendingUnlink: false,
      },
      deviceEnrollment: {
        policy: "automatic",
        trustedSignIns: [
          {
            type: "passkey",
            id: "fictional-credential",
            addedAt: Date.UTC(2028, 0, 3),
            source: "link-page",
          },
          {
            type: "passkey",
            id: "fictional-added-credential",
            addedAt: Date.UTC(2028, 0, 5),
            source: "endorsed",
          },
        ],
      },
    },
  );
  // No first step stands in front of the settings.
  await expect(
    page.getByText("This gateway is linked to your Omnesis account.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "When a new device signs in" })).toHaveCount(1);
  // The tab and its sections are named for the account, not for the relay.
  await expect(page.getByRole("button", { name: "Omnesis account", exact: true })).toBeVisible();
  for (const name of ["Account", "Remote access", "New devices"])
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const automatic = page.getByRole("radio", { name: /^Join automatically/ });
  const ask = page.getByRole("radio", { name: /^Ask me first/ });
  await expect(automatic).toBeChecked();
  await expect(ask).not.toBeChecked();
  // The sign-ins this gateway trusts are listed with where each came from and whether the owner
  // confirmed it here; they are managed on the account page, so there is nothing to remove here.
  await expect(page.getByText("Trusted sign-ins", { exact: true })).toBeVisible();
  await expect(page.locator(".relay-sign-in")).toHaveCount(2);
  await expect(page.locator(".relay-sign-in").first()).toContainText(
    "Used to connect this gateway · Not confirmed on this gateway",
  );
  await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  expect(relay.calls).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("new-devices-default-desktop.png"),
    fullPage: true,
  });

  // The radios follow the gateway's saved policy, so each settles once the save returns.
  await ask.click();
  await expect(ask).toBeChecked();
  await expect(automatic).not.toBeChecked();
  expect(relay.calls).toEqual([{ operation: "enrollment", body: { policy: "ask" } }]);
  await automatic.click();
  await expect(automatic).toBeChecked();
  expect(relay.calls.at(-1)).toEqual({ operation: "enrollment", body: { policy: "automatic" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath("new-devices-default-mobile.png"),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

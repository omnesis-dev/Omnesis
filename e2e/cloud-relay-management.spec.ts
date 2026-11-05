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
async function management(
  page: Page,
  google: Record<string, unknown> = { configured: false },
  overrides: Record<string, unknown> = {},
) {
  let status: Record<string, any> = { ...initial(), google, ...overrides };
  const calls: Array<{ operation: string; body: unknown }> = [];
  await page.route("**/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), experimental: true } });
  });
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
      if (operation === "google/unlink")
        status = {
          ...status,
          google: { ...status.google, linked: false, canLink: true, canUnlink: false },
        };
      if (operation === "configure")
        status = {
          ...status,
          revision: 2,
          configured: true,
          gatewayId: "00000000-0000-4000-8000-000000000001",
          hostname: "g-fictional.relay.example.test",
          publicOrigin: "https://g-fictional.relay.example.test",
          config: { ...body, invitationRequired: true },
          enrollment: { state: "pending" },
          can: { ...status.can, enable: true },
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
      if (operation === "renew")
        status = {
          ...status,
          revision: 5,
          certificate: { ...status.certificate, lastError: "certificate-renewal-failed" },
        };
    }
    await route.fulfill({ json: status });
  });
  const token = readFileSync(
    join(process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR!, "token"),
    "utf8",
  ).trim();
  await page.goto(`/portal/?token=${encodeURIComponent(token)}`);
  await page.locator("nav.sidebar-nav").waitFor();
  await page.goto("/portal/settings/relay");
  await expect(page.getByRole("heading", { name: "Cloud relay", exact: true })).toBeVisible();
  return {
    calls,
    setGoogle: (google: Record<string, unknown>) => {
      status = { ...status, google };
    },
  };
}

test("portal configures, enrolls, monitors, retries and disables without requiring Google", async ({
  page,
}) => {
  const { calls } = await management(page);
  await expect(page.getByText("not configured (optional)", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Relay URL", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("relay.omnesis.app");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText("00000000-0000-4000-8000-000000000001", { exact: true }),
  ).toBeVisible();
  expect(calls[0]).toEqual({
    operation: "configure",
    body: { termsAccepted: true },
  });
  await page.getByLabel("Relay invitation", { exact: true }).fill("fictional-bound-invitation");
  await page.getByRole("button", { name: "Enable relay", exact: true }).click();
  await expect(
    page.getByText("Public certificate and endpoint verified.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Relay invitation", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) =>
        value.includes("fictional-bound-invitation"),
      ),
    ),
  ).toBe(false);
  await page.screenshot({ path: "/tmp/omnesis-relay-management-desktop-dark.png", fullPage: true });
  await page.getByRole("button", { name: "Renew certificate", exact: true }).click();
  await expect(
    page.getByText("Certificate renewal failed. Check DNS and try renewal again.", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.screenshot({ path: "/tmp/omnesis-relay-management-mobile-light.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(
    page.getByText("Public certificate and endpoint verified.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Disable relay", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable relay", exact: true })).toBeEnabled();
  expect(calls.map((x) => x.operation)).toEqual([
    "configure",
    "enable",
    "renew",
    "reconnect",
    "disable",
  ]);
});

test("an unavailable installation service disables setup without offering a relay URL override", async ({
  page,
}) => {
  const { calls } = await management(page, { configured: false }, { serviceConfigured: false });
  await expect(page.getByRole("status")).toHaveText(
    "Relay setup is unavailable. Ask the installation administrator to configure the service.",
  );
  await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Enable relay", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox")).toBeDisabled();
  await expect(page.getByLabel("Relay URL", { exact: true })).toHaveCount(0);
  expect(calls).toEqual([]);
});

test("portal keeps setup actionable after errors and does not render server secrets", async ({
  page,
}) => {
  await management(page);
  await page.route("**/admin/cloud-relay/configure", (route) =>
    route.fulfill({ status: 503, json: { error: "private-key-secret /private/path" } }),
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn't load or update the relay. Check the connection and try again.",
  );
  await expect(page.getByText("private-key-secret", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save settings" })).toBeEnabled();
});

test("Google management navigates only to the real authorization endpoint, then unlinks without changing relay enrollment", async ({
  page,
  baseURL,
}) => {
  const configuration = { configured: true, canLink: true, linkOrigin: baseURL };
  const { calls, setGoogle } = await management(page, configuration);
  await page.route("https://accounts.google.com/o/oauth2/v2/auth**", async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({
      contentType: "text/html",
      body: "<main>Isolated Google authorization fixture</main>",
    });
  });
  await page.getByRole("button", { name: "Link Google account", exact: true }).click();
  await expect(page).toHaveURL("https://accounts.google.com/o/oauth2/v2/auth?state=fictional");
  expect(calls.at(-1)?.operation).toBe("google/link");
  setGoogle({
    configured: true,
    linked: true,
    canLink: true,
    canUnlink: true,
    linkOrigin: baseURL,
  });
  await page.goto("/portal/settings/relay");
  await expect(
    page.getByText("A Google discovery association is saved", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unlink Google account", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unlink Google account", exact: true }),
  ).toHaveCount(0);
  expect(calls.at(-1)?.operation).toBe("google/unlink");
  await expect(page.getByText("Generated when you save settings", { exact: true })).toBeVisible();
});

test("device pills distinguish reported local, relay and reconnecting paths while legacy devices retain ordinary presence", async ({
  page,
}) => {
  const names = [
    "Fictional local collector",
    "Fictional relay phone",
    "Fictional reconnecting phone",
    "Fictional direct legacy",
  ];
  await page.route("**/admin/devices", (route) =>
    route.fulfill({
      json: {
        items: names.map((name, index) => ({
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
  const token = readFileSync(
    join(process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR!, "token"),
    "utf8",
  ).trim();
  await page.goto(`/portal/?token=${encodeURIComponent(token)}`);
  await page.locator("nav.sidebar-nav").waitFor();
  await page.goto("/portal/settings/devices");
  await page.getByRole("button", { name: /^Other devices/ }).click();
  for (const [name, label] of names
    .slice(0, 3)
    .map((name, index) => [name, ["Local", "Relay", "Reconnecting"][index]])) {
    const card = page
      .locator(".devices-card")
      .filter({ has: page.getByText(name, { exact: true }) });
    await expect(card.locator(".device-connection-pill")).toHaveText(label!);
  }
  await expect(
    page
      .locator(".devices-card")
      .filter({ has: page.getByText(names[3]!, { exact: true }) })
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

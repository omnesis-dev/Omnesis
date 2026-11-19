// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Connectivity in a real browser. The gateway under test runs without the cloud relay
// or its own Tailscale device, so where a test needs them the portal is told they are on and every
// route the page uses is answered here by a small in-memory gateway. Fictional data throughout.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, any>;

function relayNone(): Json {
  return {
    revision: 1,
    enabled: false,
    configured: false,
    serviceConfigured: true,
    gatewayId: "gw-fictional",
    config: {
      termsAccepted: false,
      invitationRequired: false,
      relayUrl: "https://relay.example.test",
    },
    enrollment: { state: "unconfigured" },
    tunnel: { state: "disabled" },
    certificate: { state: "unconfigured" },
    publicMcp: { ready: false },
    google: { configured: false },
    can: { configure: true, enable: false, disable: false, reconnect: false, renew: false },
  };
}
function relayLinked(): Json {
  return {
    ...relayNone(),
    enabled: true,
    configured: true,
    hostname: "g-maple.relay.example.test",
    enrollment: { state: "enrolled" },
    tunnel: { state: "online" },
    certificate: { state: "valid", expiresAt: "2029-01-01T00:00:00Z" },
    publicMcp: { ready: true, url: "https://g-maple.relay.example.test/mcp" },
    account: {
      activated: true,
      configured: true,
      linked: true,
      canLink: false,
      canUnlink: true,
      pendingUnlink: false,
    },
    deviceEnrollment: {
      policy: "ask",
      trustedSignIns: [
        {
          type: "passkey",
          id: "pk-fictional-0001",
          addedAt: 0,
          source: "link-page",
          confirmed: true,
        },
      ],
      confirmedSignIns: [
        { type: "passkey", id: "pk-fictional-0001", at: 0, via: "gateway-origin" },
      ],
      confirmOrigin: "https://g-maple.relay.example.test",
    },
    can: { configure: false, enable: false, disable: true, reconnect: true, renew: true },
  };
}
function tailscaleOff(): Json {
  return {
    enabled: false,
    deviceName: "omnesis",
    joinPolicy: "ask",
    helper: { state: "off" },
    connection: "off",
    signInUrl: null,
    url: null,
    node: null,
    owner: null,
    certificate: null,
    public: { wanted: false, state: "off" },
    joinRequests: [],
  };
}
function tailscaleConnected(): Json {
  return {
    ...tailscaleOff(),
    enabled: true,
    helper: { state: "running" },
    connection: "connected",
    url: "https://omnesis.example-net.ts.net",
    node: { dnsName: "omnesis.example-net.ts.net", tailnet: "example-net.ts.net", ips: [] },
    owner: { login: "maya@example.com", displayName: "Maya Reeves" },
    certificate: { source: "tailscale" },
  };
}

async function signIn(page: Page) {
  const token = readFileSync(
    join(process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR!, "token"),
    "utf8",
  ).trim();
  await page.goto(`/portal/?token=${encodeURIComponent(token)}`);
  await page.locator("nav.sidebar-nav").waitFor();
}

/** Answers with the gateway's own reply, amended; a request the page dropped is not a failure. */
async function amend(route: Route, change: (body: Json) => Json) {
  try {
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) });
  } catch {
    await route.abort().catch(() => {});
  }
}

/** The in-memory gateway: the state each route answers from, and every change the page asked for. */
async function remoteGateway(page: Page, flags: { tailscaleEmbed: boolean }) {
  const state: Json = {
    remote: {
      setupCompletedAt: null,
      first: "tailscale",
      features: flags,
      publicBaseUrl: { configured: null, setByEnvironment: false, way: null },
      mcpAddresses: [] as Json[],
    },
    relay: relayNone(),
    tailscale: tailscaleOff(),
    host: {
      state: "available",
      dnsName: "studio.example-net.ts.net",
      port: 443,
      url: "https://studio.example-net.ts.net",
      servesGateway: false,
      publicGateway: false,
    },
    publish: { ok: true, url: "https://studio.example-net.ts.net" },
  };
  const calls: Array<[string, string, unknown]> = [];
  await page.route("**/status", (route) => amend(route, (body) => ({ ...body, ...flags })));
  await page.route("**/admin/remote-access**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const body = route.request().postDataJSON?.() ?? null;
    if (method !== "GET") calls.push(["remote", path, body]);
    if (path.endsWith("/host-tailscale")) return route.fulfill({ json: state.host });
    if (path.endsWith("/publish")) {
      if (state.publish.ok)
        state.host = { ...state.host, servesGateway: true, publicGateway: body.public };
      return route.fulfill({ json: state.publish });
    }
    if (path.endsWith("/check-address"))
      return route.fulfill({
        json: {
          url: "https://omnesis.example.org",
          ok: true,
          steps: [
            { id: "resolves", ok: true, detail: "omnesis.example.org resolves to 203.0.113.24." },
            {
              id: "certificate",
              ok: true,
              detail: "The certificate is valid for omnesis.example.org.",
            },
            { id: "answers", ok: true, detail: "This gateway answered at that address." },
          ],
        },
      });
    if (method === "PATCH") {
      if (body.first) state.remote.first = body.first;
      for (const [id, reach] of Object.entries((body.mcp ?? {}) as Record<string, string>))
        state.remote.mcpAddresses = state.remote.mcpAddresses.map((row: Json) =>
          row.id === id ? { ...row, reach } : row,
        );
      if (body.setupCompleted !== undefined)
        state.remote.setupCompletedAt = body.setupCompleted ? "2028-01-01T00:00:00Z" : null;
    }
    return route.fulfill({ json: state.remote });
  });
  await page.route("**/admin/config", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON();
    calls.push(["config", "PATCH", body]);
    state.remote.publicBaseUrl = {
      configured: body.gateway.publicBaseUrl,
      setByEnvironment: false,
      way: null,
    };
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/admin/cloud-relay**", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").slice(3).join("/");
    if (operation === "account/refresh") return route.fulfill({ json: {} });
    const body = route.request().postDataJSON?.() ?? null;
    if (operation) calls.push(["relay", operation, body]);
    if (operation === "enable")
      state.relay = { ...state.relay, enabled: true, tunnel: { state: "online" } };
    if (operation === "disable")
      state.relay = { ...state.relay, enabled: false, tunnel: { state: "disabled" } };
    if (operation === "enrollment")
      state.relay = {
        ...state.relay,
        deviceEnrollment: { ...state.relay.deviceEnrollment, policy: body.policy },
      };
    return route.fulfill({ json: state.relay });
  });
  await page.route("**/admin/tailscale**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/admin\/tailscale/, "");
    const body = route.request().postDataJSON?.() ?? null;
    if (path === "/join-requests") return route.fulfill({ json: [] });
    if (route.request().method() !== "GET") calls.push(["tailscale", path, body]);
    if (path === "/enable")
      state.tailscale = body.enabled
        ? {
            ...tailscaleOff(),
            enabled: true,
            helper: { state: "running" },
            connection: "needs-sign-in",
            signInUrl: "https://login.tailscale.com/a/fictional0",
          }
        : tailscaleOff();
    if (path === "/settings") state.tailscale = { ...state.tailscale, ...body };
    return route.fulfill({ json: state.tailscale });
  });
  return { state, calls };
}

const heading = (page: Page) => page.locator(".remote-access-view .access-wizard-copy h3");
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

test("with no account and no Tailscale device, Connectivity offers the account, this computer's Tailscale, a domain and MCP", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (/\/admin\/tailscale/.test(request.url())) requested.push(request.url());
  });
  // A gateway that never linked an account, installed without the Tailscale helper program.
  await page.route("**/status", (route) =>
    amend(route, (body) => ({ ...body, tailscaleEmbed: false })),
  );
  await signIn(page);
  // The tab's earlier address leads to it.
  await page.goto("/portal/settings/remote-access");
  await expect(page).toHaveURL(/\/portal\/settings\/connectivity$/);
  await expect(page.locator(".config-tab.active")).toHaveText("Connectivity");
  await expect(heading(page)).toHaveText("Connectivity");
  await expect(page.locator(".remote-access-item-title")).toHaveText([
    "Omnesis accounts",
    "Omnesis relay",
    "Tailscale on this computer",
    "Your own domain or reverse proxy",
    "MCP server",
    "Only with a pairing code",
  ]);
  expect(requested).toEqual([]);
});

test("the guided setup with both: account, connection, devices, then the summary and a review", async ({
  page,
}) => {
  const gateway = await remoteGateway(page, { tailscaleEmbed: true });
  await signIn(page);
  await page.goto("/portal/settings/connectivity");
  await expect(heading(page)).toHaveText("Connectivity");
  await button(page, "Set up step by step").click();
  await expect(heading(page)).toHaveText("Do you want an Omnesis account?");
  await expect(page.getByText("None of your data goes to Omnesis", { exact: false })).toBeVisible();
  await button(page, "Skip for now").click();

  // Step 2: the relay waits for an account; the way back keeps the choices and returns here.
  await expect(heading(page)).toHaveText(
    "How should your devices reach this gateway when they are away from home?",
  );
  await expect(page.locator("#remote-access-way-relay")).toBeDisabled();
  await page.locator("#remote-access-way-tailscale").click();
  await expect(page.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute(
    "href",
    "https://login.tailscale.com/a/fictional0",
  );
  await expect(page.locator(".tailscale-qr-canvas")).toBeVisible();
  await button(page, "Set one up in step 1").click();
  await expect(heading(page)).toHaveText("Do you want an Omnesis account?");

  // Signing in happens elsewhere; the page comes back to the same step after a reload.
  gateway.state.relay = relayLinked();
  gateway.state.tailscale = tailscaleConnected();
  await page.reload();
  await expect(heading(page)).toHaveText("This gateway is linked to your Omnesis account");
  await button(page, "Continue").click();
  await expect(heading(page)).toHaveText(
    "How should your devices reach this gateway when they are away from home?",
  );
  await expect(page.locator("#remote-access-way-relay")).toBeChecked();
  await expect(page.locator("#remote-access-way-tailscale")).toBeChecked();
  await expect(page.getByText("Connected as omnesis.example-net.ts.net")).toBeVisible();
  await page.getByRole("radio", { name: /^Omnesis relay/ }).check();
  await expect.poll(() => gateway.state.remote.first).toBe("relay");
  await button(page, "Continue").click();

  // Step 3: one answer sets the account's policy and the Tailscale device's.
  await expect(heading(page)).toHaveText("When a new device asks to join, what should happen?");
  await expect(page.getByRole("radio", { name: /^Pairing code only/ })).toHaveCount(0);
  await page.getByRole("radio", { name: /^My devices join automatically/ }).check();
  await expect(page.getByRole("radio", { name: /^My devices join automatically/ })).toBeChecked();
  await expect
    .poll(() =>
      gateway.calls.filter(([, change]) => change === "enrollment" || change === "/settings"),
    )
    .toEqual([
      ["relay", "enrollment", { policy: "automatic" }],
      ["tailscale", "/settings", { joinPolicy: "automatic" }],
    ]);
  await button(page, "Finish").click();

  await expect(heading(page)).toHaveText("Connectivity");
  await expect(page.locator(".remote-access-summary")).toContainText(
    "Linked to your Omnesis account",
  );
  expect(gateway.state.remote.setupCompletedAt).not.toBeNull();

  await button(page, "Run the setup again").click();
  await expect(heading(page)).toHaveText("This gateway is linked to your Omnesis account");
  await expect(button(page, "Unlink this gateway")).toBeVisible();
  await button(page, "Continue").click();
  await button(page, "Continue").click();
  await button(page, "Finish").click();
  await expect(heading(page)).toHaveText("Connectivity");

  // The detail pages stay one click away and lead back.
  await page.getByRole("button", { name: "Omnesis account", exact: true }).click();
  await expect(page).toHaveURL(/\/portal\/settings\/account$/);
  await expect(page.locator(".config-tab.active")).toHaveText("Connectivity");
  await button(page, "← Connectivity").click();
  await expect(page).toHaveURL(/\/portal\/settings\/connectivity$/);
  await page
    .getByRole("button", { name: "This gateway's own Tailscale device", exact: true })
    .click();
  await expect(page.locator(".tailscale-view h2")).toHaveText("Tailscale");
  await expect(page.locator(".config-tab.active")).toHaveText("Connectivity");
});

test("my own setup: Tailscale on this computer refused with its command, and my own address checked", async ({
  page,
}) => {
  const gateway = await remoteGateway(page, { tailscaleEmbed: true });
  gateway.state.publish = {
    ok: false,
    reason:
      "This gateway is not allowed to change Tailscale on this computer. Run the command below as root or as the computer's Tailscale operator.",
    command: "tailscale serve --bg https+insecure://localhost:7600",
  };
  await signIn(page);
  await page.goto("/portal/settings/connectivity");
  await button(page, "Set up step by step").click();
  await expect(page.locator(".access-wizard-steps button")).toHaveText([
    "1Your Omnesis account",
    "2Remote connection",
  ]);
  await button(page, "Skip for now").click();
  await page.locator("#remote-access-way-host").check();
  await expect(
    page.getByText("Found: this computer is on your Tailscale network as"),
  ).toBeVisible();
  await button(page, "Set it up for me").click();
  await expect(page.getByRole("alert")).toContainText(
    "not allowed to change Tailscale on this computer",
  );
  await expect(page.locator(".copy-block-code")).toHaveText(
    "tailscale serve --bg https+insecure://localhost:7600",
  );
  // A public address needs nothing set on the gateway first.
  const internet = page.getByText(
    "Also reachable from the Internet, for the portal and devices without Tailscale (Tailscale Funnel)",
  );
  await internet.click();
  await expect(button(page, "Set it up for me")).toBeEnabled();
  await internet.click();

  await page.locator("#remote-access-way-domain").check();
  await page.locator("#remote-access-own-url").fill("https://omnesis.example.org");
  await button(page, "Check it").click();
  await expect(page.locator(".remote-access-checks li")).toHaveCount(4);
  await expect(page.locator(".remote-access-checks")).toContainText(
    "can't tell whether the address is reachable from outside",
  );
  await button(page, "Use this address").click();
  // Saved, the address is in use at once: no restart to ask for.
  await expect(page.getByText("This gateway uses this address.")).toBeVisible();
  await expect(page.getByText("Restart the gateway")).toHaveCount(0);
  await expect
    .poll(() => gateway.calls.filter(([kind]) => kind === "config"))
    .toEqual([["config", "PATCH", { gateway: { publicBaseUrl: "https://omnesis.example.org" } }]]);

  // On a phone the setup fits the screen: nothing scrolls sideways but the tab bar.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the MCP server: the setup's last step and its own page set how far each address answers", async ({
  page,
}) => {
  const gateway = await remoteGateway(page, { tailscaleEmbed: true });
  gateway.state.host = { ...gateway.state.host, servesGateway: true };
  gateway.state.remote.mcpAddresses = [
    {
      id: "host",
      url: "https://studio.example-net.ts.net",
      reach: "private",
      choices: ["off", "private", "public"],
      available: true,
    },
  ];
  await signIn(page);
  await page.goto("/portal/settings/connectivity");
  await expect(page.locator(".remote-access-summary")).toContainText(
    "On Tailscale on this computer (your Tailscale network only).",
  );
  await button(page, "Run the setup again").click();
  await expect(page.locator(".access-wizard-steps button")).toHaveText([
    "1Your Omnesis account",
    "2Remote connection",
    "3MCP server",
  ]);
  await button(page, "Skip for now").click();
  await button(page, "Continue").click();
  await expect(heading(page)).toHaveText("Where may agents reach your MCP server?");
  await expect(page.getByText("https://studio.example-net.ts.net/mcp")).toBeVisible();
  const choice = (reach: string) =>
    page.locator(`input[name="remote-access-mcp-host"][value="${reach}"]`);
  await expect(choice("private")).toBeChecked();
  await choice("off").check();
  await expect
    .poll(() => gateway.calls.filter(([, path]) => path === "/admin/remote-access"))
    .toEqual([["remote", "/admin/remote-access", { mcp: { host: "off" } }]]);
  await button(page, "Finish").click();
  await expect(page.locator(".remote-access-summary")).toContainText(
    "Off on every address away from home.",
  );
  await page.goto("/portal/settings/mcp");
  await expect(page.locator(".config-tab.active")).toHaveText("Connectivity");
  await expect(choice("off")).toBeChecked();
});

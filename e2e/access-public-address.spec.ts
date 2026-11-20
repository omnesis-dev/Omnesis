// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Access page's connect dialog: the addresses it offers and what a hosted
// app is told about the selected one, without the cloud relay and with a relay
// address that is ready or turned off.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const RELAY = "https://g-fictional.relay.example.test/mcp";
const HOSTED = [
  ["claude-apps", "Claude apps", "Claude connects from Anthropic's servers"],
  ["chatgpt", "ChatGPT", "ChatGPT connects from OpenAI's servers"],
] as const;

async function signIn(page: Page) {
  const token = readFileSync(
    join(process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR!, "token"),
    "utf8",
  ).trim();
  await page.goto(`/portal/?token=${encodeURIComponent(token)}`);
  await page.locator("nav.sidebar-nav").waitFor();
}

const OWN = "https://gateway.example.org/mcp";
const READY = {
  enabled: true,
  tunnel: { state: "online" },
  publicMcp: { ready: true, url: RELAY },
};
const OFF = {
  enabled: false,
  tunnel: { state: "disabled" },
  publicMcp: { ready: false, url: RELAY },
};

/**
 * The gateway under test is not connected to an account. The portal is shown
 * what a gateway connected to an account reports: the relay's status, and the
 * addresses it authorizes. `lead` replaces the
 * localhost address the test gateway leads with; `"keep"` lists the relay
 * address beside it.
 */
async function connectedGateway(page: Page, relay: Record<string, unknown>, lead: string) {
  await page.route("**/admin/cloud-relay", async (route) => {
    await route.fulfill({
      json: {
        revision: 2,
        configured: true,
        serviceConfigured: true,
        hostname: new URL(RELAY).hostname,
        enrollment: { state: "enrolled" },
        certificate: { state: "valid" },
        google: { configured: false },
        can: {},
        ...relay,
      },
    });
  });
  await page.route("**/admin/access", async (route) => {
    const response = await route.fetch();
    const overview = await response.json();
    const listed = (resource: string) => ({
      resource,
      servedByGateway: false,
      direct: false,
      publiclyTrusted: true,
    });
    const resources = [...new Set([lead === "keep" ? overview.oauth.resource : lead, RELAY])];
    await route.fulfill({
      response,
      json: {
        ...overview,
        oauth: {
          ...overview.oauth,
          ...(lead === "keep" ? {} : { resource: lead, loopbackOnly: undefined }),
          resources:
            lead === "keep" ? [...overview.oauth.resources, listed(RELAY)] : resources.map(listed),
        },
      },
    });
  });
}

async function openConnectDialog(page: Page) {
  await signIn(page);
  await page.goto("/portal/settings/access/connect");
  await expect(page.locator(".access-connect-dialog")).toBeVisible();
}

const notice = (page: Page) => page.locator(".access-agent-steps .access-agent-public");
const shownAddress = (page: Page) =>
  page.locator(".access-connect-step .access-mcp-resource code").first();
const addressSelect = (page: Page) => page.locator("select#access-mcp-address");
const agentCard = (page: Page, id: string) => page.locator(`button[data-agent='${id}']`);
const commands = (page: Page) => page.locator(".access-agent-steps .access-agent-command code");

const location = (page: Page, id: "machine" | "home" | "away") =>
  page.locator(`input[name='access-agent-location'][value='${id}']`);

test("a gateway with no address away from home opens on this computer, and hosted apps are sent to Somewhere else", async ({
  page,
}) => {
  const relayQuestions: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/admin/cloud-relay") && url.searchParams.has("signup"))
      relayQuestions.push(url.href);
  });
  await openConnectDialog(page);
  await expect(location(page, "machine")).toBeChecked();
  await expect(page.locator("#access-mcp-address")).toHaveCount(0);
  expect(new URL((await shownAddress(page).textContent())!).hostname).toBe("localhost");
  // Hosted apps can never reach this computer's address, so they are not offered here.
  for (const [id] of HOSTED) await expect(agentCard(page, id)).toHaveCount(0);
  await page.getByRole("button", { name: "Set them up under Somewhere else" }).click();
  await expect(location(page, "away")).toBeChecked();
  await expect(page.locator(".access-connect-dialog")).toContainText(
    "This gateway has no address away from home yet.",
  );
  const dialog = page.locator(".access-connect-dialog");
  await expect(dialog).not.toContainText("Omnesis account");
  await expect(dialog).not.toContainText("Omnesis address");
  await expect(dialog).not.toContainText("Settings, Account");
  // Reading the gateway's own account state asks the relay nothing.
  expect(relayQuestions).toEqual([]);
});

test("the owner's public address and a ready relay address: a drop-down that starts on the owner's and drives the setup", async ({
  page,
}) => {
  await connectedGateway(page, READY, OWN);
  await openConnectDialog(page);
  const select = addressSelect(page);
  await expect(select).toBeVisible();
  // The address is picked where it is shown and copied: the field holds the addresses themselves.
  await expect(select.locator("option")).toHaveText([OWN, RELAY]);
  await expect(select).toHaveValue(OWN);
  await expect(page.getByRole("combobox", { name: "MCP server address" })).toHaveCount(1);

  await agentCard(page, "claude-apps").click();
  await expect(notice(page).locator("p")).toHaveText([
    "Claude connects from Anthropic's servers, so the address above must be reachable from the Internet.",
  ]);
  await expect(notice(page)).not.toHaveClass(/is-warning/u);
  await expect(page.locator(".access-agent-steps")).not.toContainText("Funnel");

  // The keyboard alone changes the address, and everything below follows it.
  await select.focus();
  await select.press("ArrowDown");
  await expect(select).toHaveValue(RELAY);
  await expect(notice(page).locator("p")).toHaveText([
    "Claude connects from Anthropic's servers, and this address is reachable from the Internet.",
  ]);
  for (const id of ["chatgpt", "claude-apps"]) {
    await expect(agentCard(page, id).locator(".access-agent-warning")).toHaveCount(0);
  }
  await agentCard(page, "codex").click();
  await expect(commands(page).first()).toContainText(`--url ${RELAY}`);
  await select.selectOption(OWN);
  await expect(commands(page).first()).toContainText(`--url ${OWN}`);
  await expect(page.locator(".access-agent-steps .access-agent-public")).toHaveCount(0);

  // At phone width the drop-down and the address stay inside the dialog.
  await page.setViewportSize({ width: 390, height: 800 });
  const dialogBox = (await page.locator(".access-connect-dialog").boundingBox())!;
  for (const target of [
    select,
    page.locator(".access-connect-step .access-mcp-resource").first(),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(dialogBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
  }
});

test("a ready relay address as the only address: plain display, usable by a hosted app with no warning", async ({
  page,
}) => {
  await connectedGateway(page, READY, RELAY);
  await openConnectDialog(page);
  await expect(page.locator("#access-mcp-address")).toHaveCount(0);
  await expect(shownAddress(page)).toHaveText(RELAY);
  for (const [id, , needs] of HOSTED) {
    await expect(agentCard(page, id).locator(".access-agent-warning")).toHaveCount(0);
    await agentCard(page, id).click();
    await expect(notice(page).locator("p")).toHaveText([
      `${needs}, and this address is reachable from the Internet.`,
    ]);
    await expect(notice(page)).not.toHaveClass(/is-warning/u);
    const steps = page.locator(".access-agent-steps");
    await expect(steps).toContainText("with the address above");
    await expect(steps).not.toContainText("Funnel");
    await expect(steps).not.toContainText("must be reachable");
    await agentCard(page, id).click();
  }
});

test("a ready relay address beside the localhost address: the dialog starts on the relay address", async ({
  page,
}) => {
  await connectedGateway(page, READY, "keep");
  await openConnectDialog(page);
  // The relay is the one address away from home; the localhost one is this computer's.
  await expect(location(page, "away")).toBeChecked();
  await expect(addressSelect(page)).toHaveCount(0);
  await expect(shownAddress(page)).toHaveText(RELAY);
  await agentCard(page, "chatgpt").click();
  await expect(notice(page).locator("p")).toHaveText([
    "ChatGPT connects from OpenAI's servers, and this address is reachable from the Internet.",
  ]);
  await location(page, "machine").check();
  expect(new URL((await shownAddress(page).textContent())!).hostname).toBe("localhost");
  await expect(agentCard(page, "chatgpt")).toHaveCount(0);
});

test("a relay address with remote access turned off says so, and leads to the relay's page", async ({
  page,
}) => {
  await connectedGateway(page, OFF, "keep");
  await openConnectDialog(page);
  await expect(location(page, "away")).toBeChecked();
  await expect(shownAddress(page)).toHaveText(RELAY);
  for (const [id, , needs] of HOSTED) {
    await expect(agentCard(page, id).locator(".access-agent-warning")).toBeVisible();
    await agentCard(page, id).click();
    await expect(notice(page).locator("p")).toHaveText([
      `Remote access is turned off. ${needs}, so it cannot reach this address right now.`,
      "Turn it on in Settings, Connectivity.",
    ]);
    await expect(notice(page)).toHaveClass(/is-warning/u);
    await expect(page.locator(".access-agent-steps")).not.toContainText("Funnel");
    await agentCard(page, id).click();
  }
  // An agent on the owner's network is told the same.
  await agentCard(page, "codex").click();
  await expect(notice(page).locator("p")).toHaveText([
    "Remote access is turned off. This address does not answer right now.",
    "Turn it on in Settings, Connectivity.",
  ]);
  await expect(commands(page)).toHaveCount(0);
  await notice(page).getByRole("link", { name: "Settings, Connectivity" }).click();
  await expect(page).toHaveURL(/\/portal\/settings\/relay$/u);
  await expect(page.locator(".relay-view")).toBeVisible();
});

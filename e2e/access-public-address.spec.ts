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
 * The gateway under test runs without the flag. The portal is shown what an
 * opted-in gateway connected to an account reports: the feature on `/status`,
 * the relay's status, and the addresses it authorizes. `lead` replaces the
 * localhost address the test gateway leads with; `"keep"` lists the relay
 * address beside it.
 */
async function connectedGateway(page: Page, relay: Record<string, unknown>, lead: string) {
  await page.route("**/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), cloudRelay: true } });
  });
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

test("without the cloud relay there is one address and a hosted app is told to publish the gateway, as before", async ({
  page,
}) => {
  let relayReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/admin/cloud-relay")) relayReads += 1;
  });
  await openConnectDialog(page);
  await expect(page.locator("#access-mcp-address")).toHaveCount(0);
  expect(new URL((await shownAddress(page).textContent())!).hostname).toBe("localhost");
  for (const [id, , needs] of HOSTED) {
    await agentCard(page, id).click();
    await expect(notice(page).locator("p")).toHaveText([
      `This address is private. ${needs}, so it cannot reach this gateway until you publish it.`,
      "Publish the gateway with Tailscale Funnel or use a domain of your own.",
    ]);
    await expect(agentCard(page, id).locator(".access-agent-warning")).toBeVisible();
    await agentCard(page, id).click();
  }
  const dialog = page.locator(".access-connect-dialog");
  await expect(dialog).not.toContainText("Omnesis account");
  await expect(dialog).not.toContainText("Omnesis address");
  await expect(dialog).not.toContainText("Settings, Account");
  expect(relayReads).toBe(0);
});

test("the owner's public address and a ready relay address: a drop-down that starts on the owner's and drives the setup", async ({
  page,
}) => {
  await connectedGateway(page, READY, OWN);
  await openConnectDialog(page);
  const select = addressSelect(page);
  await expect(select).toBeVisible();
  await expect(select.locator("option")).toHaveText([
    `Your public address: ${OWN}`,
    `Omnesis address (remote access): ${RELAY}`,
  ]);
  await expect(select).toHaveValue(OWN);
  await expect(shownAddress(page)).toHaveText(OWN);
  await expect(page.getByRole("combobox", { name: /^Address/u })).toHaveCount(1);

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
  await expect(shownAddress(page)).toHaveText(RELAY);
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
  const select = addressSelect(page);
  await expect(select.locator("option")).toHaveText([
    /^This machine only: https:\/\/localhost:/u,
    `Omnesis address (remote access): ${RELAY}`,
  ]);
  await expect(select).toHaveValue(RELAY);
  await agentCard(page, "chatgpt").click();
  await expect(notice(page).locator("p")).toHaveText([
    "ChatGPT connects from OpenAI's servers, and this address is reachable from the Internet.",
  ]);
  await select.selectOption({ index: 0 });
  await expect(notice(page).locator("p")).toHaveText([
    "This address is private. ChatGPT connects from OpenAI's servers, so it cannot reach this gateway until you publish it.",
    "Pick another address from the list above.",
  ]);
});

test("a relay address with remote access turned off is marked, says so and leads to the account settings", async ({
  page,
}) => {
  await connectedGateway(page, OFF, "keep");
  await openConnectDialog(page);
  const select = addressSelect(page);
  await expect(select.locator("option").nth(1)).toHaveText(
    `Omnesis address (turned off): ${RELAY}`,
  );
  await expect(select).not.toHaveValue(RELAY);
  for (const [id, , needs] of HOSTED) {
    await expect(agentCard(page, id).locator(".access-agent-warning")).toBeVisible();
    await agentCard(page, id).click();
    await expect(notice(page).locator("p")).toHaveText([
      `This address is private. ${needs}, so it cannot reach this gateway until you publish it.`,
      "This gateway has an Omnesis address. Remote access is turned off. Turn it on in Settings, Account.",
    ]);
    await expect(page.locator(".access-agent-steps")).not.toContainText("Funnel");
    await agentCard(page, id).click();
  }
  await select.selectOption(RELAY);
  await agentCard(page, "claude-apps").click();
  await expect(notice(page).locator("p")).toHaveText([
    "Remote access is turned off. Claude connects from Anthropic's servers, so it cannot reach this address right now.",
    "Turn it on in Settings, Account.",
  ]);
  await expect(notice(page)).toHaveClass(/is-warning/u);
  // An agent on the owner's network is told the same, and has the localhost address to fall back on.
  await agentCard(page, "claude-apps").click();
  await agentCard(page, "codex").click();
  await expect(notice(page).locator("p")).toHaveText([
    "Remote access is turned off. This address does not answer right now.",
    "Turn it on in Settings, Account.",
    "Or pick another address from the list above.",
  ]);
  await expect(commands(page)).toHaveCount(0);
  await notice(page).getByRole("link", { name: "Settings, Account" }).click();
  await expect(page).toHaveURL(/\/portal\/settings\/account$/u);
  await expect(page.locator(".relay-view")).toBeVisible();
});

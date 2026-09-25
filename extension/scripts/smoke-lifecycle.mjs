// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
/* global chrome, document */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "omnesis-extension-smoke-"));
const deliveries = { documents: [], visits: [] };
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });

  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await context.route("https://gateway.example.com/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/devices/pair") {
      if (request.postDataJSON().pairingCode === "expired-code") {
        await json(route, { error: "invalid or expired pairing code" }, 400);
        return;
      }
      await json(route, {
        device: { id: "device-browser-smoke", name: "Browser smoke", kind: "browser" },
        token: "fictional-smoke-token",
        scopes: ["write:web"],
      });
    } else if (path === "/documents") {
      const body = request.postDataJSON();
      deliveries.documents.push(...(body.documents ?? []));
      await json(route, { ingested: body.documents?.length ?? 0, deleted: 0 });
    } else if (path === "/analytics/ingest") {
      const body = request.postDataJSON();
      deliveries.visits.push(...(body.records ?? []));
      await json(route, { ingested: body.records?.length ?? 0, deleted: 0 });
    } else if (path === "/owned-web-domains") {
      await json(route, { domains: [] });
    } else {
      await json(route, {});
    }
  });
  await context.route("https://reader.example.com/**", (route) => {
    const ordinal = new URL(route.request().url()).pathname.includes("two") ? "Two" : "One";
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Fictional Article ${ordinal}</title></head><body><main><h1>Fictional Article ${ordinal}</h1><p>This invented article contains enough readable text to exercise browser capture. It discusses a generic observatory visit, a notebook, and a quiet evening sky.</p><p>Additional fictional details make extraction stable for the lifecycle smoke test.</p></main></body></html>`,
    });
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const articleOne = await context.newPage();
  await articleOne.goto("https://reader.example.com/article-one");

  await options.bringToFront();
  await options.fill("#profile-label", "Personal");
  await options.fill("#gateway-url", "https://gateway.example.com");
  await options.fill("#pairing-code", "fictional-pairing-code");
  await options.check("#capture-consent");
  console.log("Approve Chrome's HTTPS page-access dialog to continue the smoke test.");
  await options.click("#pair-submit");
  await waitForPermission(options, true);
  await options.waitForFunction(() => document.querySelector("#paired")?.style.display === "block");

  await articleOne.bringToFront();
  await articleOne.reload();
  await articleOne.waitForTimeout(7_000);
  assertDelivered(deliveries, 1, "initial capture");

  await options.bringToFront();
  await options.evaluate(() => chrome.permissions.remove({ origins: ["https://*/*"] }));
  await waitForPermission(options, false);
  await options.reload();
  await options.waitForFunction(
    () => document.querySelector("#capture-permission-missing")?.hidden === false,
  );

  console.log("Approve a second Chrome access dialog if the browser displays one.");
  await options.click("#grant-capture-permission");
  await waitForPermission(options, true);
  await options.waitForFunction(
    () => document.querySelector("#capture-permission-missing")?.hidden === true,
  );

  const articleTwo = await context.newPage();
  await articleTwo.goto("https://reader.example.com/article-two");
  await articleTwo.bringToFront();
  await articleTwo.waitForTimeout(7_000);
  assertDelivered(deliveries, 2, "capture after permission repair");

  await options.bringToFront();
  await options.click("#unpair");
  await waitForPermission(options, false);
  await options.waitForFunction(
    () => document.querySelector("#pair-form")?.style.display === "block",
  );
  const state = await worker.evaluate(() => chrome.storage.local.get(null));
  const pending = Object.keys(state).filter((key) => key.startsWith("omnesis.capture.pending.v1."));
  if (state["omnesis.config.v1"] !== undefined || pending.length !== 0) {
    throw new Error("Unpair did not clear the credential and staged captures");
  }

  await options.fill("#profile-label", "Personal");
  await options.fill("#gateway-url", "https://gateway.example.com");
  await options.fill("#pairing-code", "expired-code");
  await options.check("#capture-consent");
  await options.click("#pair-submit");
  await waitForPermission(options, true);
  await options.waitForFunction(() =>
    document.querySelector("#status")?.textContent?.includes("invalid or expired pairing code"),
  );
  await options.waitForFunction(
    () => document.querySelector("#unpaired-capture-access")?.hidden === false,
  );
  await options.click("#revoke-capture-access");
  await waitForPermission(options, false);

  console.log(
    JSON.stringify({
      documentsDelivered: deliveries.documents.length,
      visitsDelivered: deliveries.visits.length,
      finalPendingHandoffs: pending.length,
      finalPaired: false,
      finalPermission: false,
    }),
  );
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}

async function waitForPermission(page, expected) {
  await page.waitForFunction(
    async (wanted) =>
      ((await chrome.permissions.getAll()).origins?.includes("https://*/*") === true) === wanted,
    expected,
    { timeout: 120_000 },
  );
}

function assertDelivered(actual, expected, stage) {
  if (actual.documents.length < expected || actual.visits.length < expected) {
    throw new Error(`${stage} failed: ${JSON.stringify(actual)}`);
  }
}

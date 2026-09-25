// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Shared core for headless portal screenshots. Both the landing-page showcase
// capture (scripts/capture-portal.mjs) and the on-demand route screenshot loop
// (scripts/shot-portal.mjs, behind scripts/shot-portal.sh) build on this so the
// boot → auth → navigate → wait-on-selector → shoot round-trip lives in ONE
// place. There is no networkidle anywhere here: the portal holds long-lived
// SSE/WS connections, so the network is never idle (see docs/agent-gotchas.md).
//
// Privacy: this module only drives a browser; the corpus it shoots comes from
// whatever gateway the caller points it at. The agent loop always points it at
// an isolated SYNTHETIC gateway (invented universe data), never the live one.

import { chromium } from "playwright";

// The single ready selector that proves the portal SPA booted and is authed:
// the sidebar only renders once a valid session exists. Used as the default
// wait target by every consumer; callers may wait on a more specific selector
// AFTER this.
export const PORTAL_READY_SELECTOR = ".app-sidebar";

// Launch a headless Chromium that trusts the gateway's self-signed cert and
// is pre-seeded with the requested theme. Returns the browser + a page; the
// caller is responsible for `browser.close()` (use a finally block).
//
// opts:
//   appearance         "dark" | "light"            (default "dark")
//   viewport           { width, height }            (default 1440x980)
//   deviceScaleFactor  device pixel ratio           (default 2 — retina-sharp)
export async function launchPortal({
  appearance = "dark",
  viewport = { width: 1440, height: 980 },
  deviceScaleFactor = 2,
} = {}) {
  const theme = appearance === "light" ? "light" : "dark";
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, // the gateway serves a self-signed cert
    viewport,
    deviceScaleFactor,
  });

  // Seed the theme before any page script runs. The portal reads the
  // "omnesis.theme" localStorage key in an inline pre-paint script and sets
  // <html data-theme>, so the very first paint is already the right palette.
  // addInitScript runs in the page world via CDP (not an inline <script>), so
  // the portal's strict CSP doesn't block it.
  await context.addInitScript((t) => {
    try {
      globalThis.localStorage.setItem("omnesis.theme", t);
    } catch {
      /* storage blocked — a later assertion catches the miss */
    }
  }, theme);

  const page = await context.newPage();
  // Surface page-side failures (CSP violations, module load errors): the
  // portal renders nothing useful if its SPA can't boot, so a silent blank
  // page would otherwise be screenshotted as "success".
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`PAGE ERROR: ${m.text()}`);
  });
  page.on("pageerror", (e) => console.log(`PAGE EXCEPTION: ${e.message}`));

  return { browser, context, page, theme };
}

// Sign in with the one-click ?token path, falling back to the token field if
// the auto-login doesn't take. Either way the gateway sets a session cookie,
// so a later hard navigation stays authed. Waits on the sidebar selector —
// never networkidle. Throws (fail-loud) if neither path produces an authed
// sidebar within the timeout, so a blank/login page is never mistaken for a
// rendered portal.
export async function signIn(page, { url, token, timeout = 15000 } = {}) {
  await page.goto(`${url}/portal/?token=${encodeURIComponent(token)}`, {
    waitUntil: "domcontentloaded",
  });
  const nav = page.locator(PORTAL_READY_SELECTOR);
  const tokenField = page.locator('input[type="password"]');
  const state = await Promise.race([
    nav.waitFor({ state: "visible", timeout }).then(() => "authed"),
    tokenField.waitFor({ state: "visible", timeout }).then(() => "login"),
  ]).catch(() => "timeout");
  if (state === "authed") return;
  if (state === "timeout") {
    throw new Error(
      `Portal sign-in failed: neither the sidebar nor the token field appeared within ${timeout}ms at ${url}/portal/ — the SPA did not boot.`,
    );
  }
  // The token field showed instead of auto-login: fill it directly.
  await tokenField.fill(token);
  await page.locator('button[type="submit"]').click();
  await nav.waitFor({ state: "visible", timeout });
}

// Force the requested theme to actually apply (headless can otherwise paint
// the default palette) and assert it took. Throws if it never flips.
export async function ensureTheme(page, appearance) {
  let applied = await page.evaluate(() => globalThis.document.documentElement.dataset.theme);
  if (applied !== appearance) {
    await page.evaluate((t) => {
      globalThis.document.documentElement.dataset.theme = t;
    }, appearance);
    await page.waitForTimeout(300);
    applied = await page.evaluate(() => globalThis.document.documentElement.dataset.theme);
  }
  if (applied !== appearance) {
    throw new Error(`Theme ${appearance} did not apply (got ${applied})`);
  }
  return applied;
}

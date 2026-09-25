// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// On-demand portal route screenshot. The Playwright half of
// scripts/shot-portal.sh: signs into a running gateway, navigates to an
// arbitrary /portal/<route>, waits on a SELECTOR (never networkidle — the
// portal holds SSE/WS connections, so the network is never idle; see
// docs/agent-gotchas.md), optionally clicks a selector, then writes a single
// full-page PNG the agent can Read and self-critique.
//
// This shares its auth/theme/launch plumbing with the landing-page showcase
// capture (scripts/capture-portal.mjs) via scripts/lib/portal-capture.mjs.
//
// Fail-loud: a sign-in that never authenticates, a wait selector that never
// appears, or a click target that never shows throws a NAMED error and exits
// non-zero — it never writes a blank or partial PNG and claims success.
//
// Env (set by scripts/shot-portal.sh):
//   PORTAL_URL        base gateway URL (e.g. https://localhost:17600)
//   PORTAL_TOKEN      read-scope token for one-click sign-in
//   PORTAL_OUT        output PNG path (under /tmp)
//   PORTAL_ROUTE      portal route, slash-relative (e.g. "people", "" for search)
//   PORTAL_WAIT       selector to wait for after navigation (default .app-sidebar)
//   PORTAL_CLICK      optional newline-separated steps, applied in order. A
//                     bare selector is clicked; `<selector>=<value>` picks
//                     that option in a <select> (a native option cannot be
//                     clicked, so a select-driven panel needs this form).
//   PORTAL_APPEARANCE "dark" | "light" (default dark)
//   PORTAL_W/H        viewport in CSS px (defaults 1440x980)
//   PORTAL_WAIT_TIMEOUT  ms to wait on the selector (default 20000)

import { launchPortal, signIn, ensureTheme, PORTAL_READY_SELECTOR } from "./lib/portal-capture.mjs";

const url = process.env.PORTAL_URL;
const token = process.env.PORTAL_TOKEN;
const out = process.env.PORTAL_OUT;
const route = (process.env.PORTAL_ROUTE ?? "").replace(/^\/+/, "");
const waitSelector = process.env.PORTAL_WAIT || PORTAL_READY_SELECTOR;
const clickSteps = (process.env.PORTAL_CLICK || "").split("\n").filter(Boolean);
const appearance = process.env.PORTAL_APPEARANCE === "light" ? "light" : "dark";
const width = Number(process.env.PORTAL_W ?? 1440);
const height = Number(process.env.PORTAL_H ?? 980);
const waitTimeout = Number(process.env.PORTAL_WAIT_TIMEOUT ?? 20000);

if (!url || !token || !out) {
  console.error("PORTAL_URL, PORTAL_TOKEN and PORTAL_OUT are required");
  process.exit(1);
}

const { browser, page } = await launchPortal({
  appearance,
  viewport: { width, height },
  deviceScaleFactor: 2,
});
try {
  await signIn(page, { url, token });

  // Hard-navigate to the requested route (the session cookie keeps us authed).
  const target = `${url}/portal/${route}`;
  await page.goto(target, { waitUntil: "domcontentloaded" });

  // Wait on a SELECTOR proving the route's content rendered — never
  // networkidle. A miss is fail-loud: the route didn't render, so a screenshot
  // would be a blank/partial page falsely reported as success.
  try {
    await page.locator(waitSelector).first().waitFor({ state: "visible", timeout: waitTimeout });
  } catch {
    throw new Error(
      `Wait selector "${waitSelector}" never became visible at ${target} within ${waitTimeout}ms — the route did not render. Refusing to write a blank PNG.`,
    );
  }

  for (const step of clickSteps) {
    // `<selector>=<value>` selects an option; anything else is a click. The
    // split is on the LAST `=` so an attribute selector may carry one.
    const separator = step.lastIndexOf("=");
    const value = separator === -1 ? null : step.slice(separator + 1);
    const selector = separator === -1 ? step : step.slice(0, separator);
    try {
      if (value === null) {
        await page.locator(selector).first().click({ timeout: waitTimeout });
      } else {
        await page.locator(selector).first().selectOption(value, { timeout: waitTimeout });
      }
    } catch {
      throw new Error(
        value === null
          ? `Click selector "${selector}" never became actionable at ${target} within ${waitTimeout}ms.`
          : `Could not select "${value}" in "${selector}" at ${target} within ${waitTimeout}ms.`,
      );
    }
    // Give the step's effect (modal/panel open, re-render) a beat to paint.
    await page.waitForTimeout(500);
  }

  // Assert the theme actually applied before shooting (headless can otherwise
  // paint the default palette).
  await ensureTheme(page, appearance);

  await page.screenshot({ path: out, fullPage: true });
  console.log(`Wrote ${out} (route "/portal/${route}", waited on "${waitSelector}")`);
} catch (err) {
  // Dump what the page looked like at failure so the cause is visible. The
  // debug frame is clearly named so it is never mistaken for the real asset.
  const debug = out.replace(/\.png$/, "-debug.png");
  try {
    await page.screenshot({ path: debug });
    console.log(`Capture failed (${err.message}); debug frame at ${debug}`);
  } catch {
    /* page may already be gone */
  }
  throw err;
} finally {
  await browser.close();
}

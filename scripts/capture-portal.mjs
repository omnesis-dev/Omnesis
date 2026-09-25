// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Headless portal screenshot for the landing page's "Manage from anywhere"
// showcase. Drives the web portal of a running gateway with Playwright and
// captures the Sources page with the "+ Add source" modal open. Because it
// screenshots the page viewport (not the OS window), the result carries no
// browser chrome or macOS window furniture.
//
// The boot → auth → theme → wait-on-selector plumbing is shared with the
// on-demand route screenshot loop (scripts/shot-portal.mjs) via
// scripts/lib/portal-capture.mjs; this file keeps only the landing-page-
// specific steps (open the Add-source modal, clip below the last source row).
//
// Env:
//   PORTAL_URL        base gateway URL (e.g. https://localhost:27600)
//   PORTAL_TOKEN      read-scope token for one-click sign-in
//   PORTAL_OUT        output PNG path
//   PORTAL_APPEARANCE "dark" | "light" (default dark)
//   PORTAL_W/H        window size in CSS px at zoom 1 (defaults 1440x980)
//   PORTAL_ZOOM       page-zoom factor (default 1; e.g. 1.5 = 150%)
//
// Invoked by scripts/record-portal-screenshot.sh against the synthetic demo
// gateway, so the captured corpus is the John Smith persona — no personal data.

import { launchPortal, signIn, ensureTheme } from "./lib/portal-capture.mjs";

const url = process.env.PORTAL_URL;
const token = process.env.PORTAL_TOKEN;
const out = process.env.PORTAL_OUT;
const appearance = process.env.PORTAL_APPEARANCE === "light" ? "light" : "dark";
const width = Number(process.env.PORTAL_W ?? 1440);
const height = Number(process.env.PORTAL_H ?? 980);
const zoom = Number(process.env.PORTAL_ZOOM ?? 1);

if (!url || !token || !out) {
  console.error("PORTAL_URL, PORTAL_TOKEN and PORTAL_OUT are required");
  process.exit(1);
}

// Emulate real browser page-zoom (Ctrl/Cmd-+) by re-rendering, not pixel
// scaling. A browser window `width` px wide showing the page at `zoom` lays
// the document out across `width / zoom` CSS px (so it reflows exactly as it
// would at that zoom level), then paints those CSS px back into the full
// window. We reproduce that by shrinking the layout viewport by `zoom` and
// raising the device scale factor by the same factor: the page reflows at the
// reduced CSS width while the captured pixel density — and therefore the
// output resolution — is identical to zoom 1, so the asset drops into the same
// showcase slot unchanged. (At 1440 / 1.5 = 960 CSS px we stay clear of the
// portal's 900px narrow-layout breakpoint, so the desktop layout is kept.)
const RETINA = 2; // base density for a retina-sharp <img> asset
const layoutWidth = Math.round(width / zoom);
const layoutHeight = Math.round(height / zoom);
const deviceScaleFactor = RETINA * zoom;

const { browser, page } = await launchPortal({
  appearance,
  viewport: { width: layoutWidth, height: layoutHeight },
  deviceScaleFactor,
});
try {
  await signIn(page, { url, token });

  await page.goto(`${url}/portal/sources`, { waitUntil: "domcontentloaded" });
  // Wait for the synthetic sources to populate the table. Generous timeout:
  // the self-hosted CI runner is a shared box, so gateway boot + first source
  // sync can lag well past 25s under load and flake this screenshot smoke test.
  await page.locator(".source-row-v2").first().waitFor({ state: "visible", timeout: 90000 });
  await page.waitForTimeout(1000);

  // Assert the theme actually applied (headless can otherwise paint the
  // default palette) before we shoot.
  const applied = await ensureTheme(page, appearance);
  const bg = await page.evaluate(
    () => globalThis.getComputedStyle(globalThis.document.body).backgroundColor,
  );
  console.log(`Theme: requested=${appearance} applied=${applied} bg=${bg}`);

  // Open the "+ Add source" modal and let its descriptor catalogue load
  // (the "Loading descriptors…" placeholder detaches once it's ready).
  await page.locator(".sources-add-btn").click();
  await page.locator(".add-source-modal").waitFor({ state: "visible", timeout: 10000 });
  await page
    .locator(".add-source-loading")
    .waitFor({ state: "detached", timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(800);

  // Trim the empty space below the sources list: clip the frame to a little
  // below the last source row (or the modal, whichever sits lower), so the
  // bottom edge lands just under the final "WhatsApp Messages" row rather
  // than the full viewport.
  const clipHeight = await page.evaluate((margin) => {
    const rows = globalThis.document.querySelectorAll(".source-row-v2");
    const lastRow = rows[rows.length - 1];
    const modal = globalThis.document.querySelector(".add-source-modal");
    const lastBottom = lastRow ? lastRow.getBoundingClientRect().bottom : 0;
    const modalBottom = modal ? modal.getBoundingClientRect().bottom : 0;
    return Math.ceil(Math.max(lastBottom, modalBottom) + margin);
  }, 28);
  // Clip coordinates are CSS px (getBoundingClientRect above is CSS px too), so
  // they're in the zoomed layout space — width is the reduced layout width and
  // the cap is the layout height. The deviceScaleFactor turns these into the
  // same physical pixel count as a zoom-1 capture.
  const shotHeight = Math.min(clipHeight, layoutHeight);
  await page.screenshot({
    path: out,
    clip: { x: 0, y: 0, width: layoutWidth, height: shotHeight },
  });
  console.log(`Wrote ${out} (zoom ${zoom}, clip ${layoutWidth}x${shotHeight} CSS px)`);
} catch (err) {
  // Dump what the page looked like at failure so the cause is visible.
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

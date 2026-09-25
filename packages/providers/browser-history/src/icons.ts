// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Per-browser icon overrides for the browser-history source.
//
// Today the source only ingests Chrome and Safari history. Other browser
// IDs in `BrowserId` are placeholders for future support — they fall
// through to the catalog-level Lucide globe glyph below.

import type { BrowserId } from "./types.js";

// ── Catalog-level glyph (pre-add picker) ──────────────────────────────
//
// Lucide `globe` (ISC-licensed, see `TRADEMARKS.md`) tinted to iOS
// system blue. This is what shows in the "Add Source" picker before any
// browser has been discovered.

const GLOBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#007AFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;

export const browserHistoryCatalogIconDataUri = `data:image/svg+xml;base64,${Buffer.from(GLOBE_SVG).toString("base64")}`;

// ── Per-instance overrides ────────────────────────────────────────────

const CHROME_ICON_URL =
  "https://www.google.com/chrome/static/images/favicons/android-icon-192x192.png";

// Apple's brand guidelines forbid third-party use of the Safari app icon,
// even via hotlink. Use a Lucide `compass` SVG (Safari's signature visual
// is a compass) tinted to Safari's accent blue.
const COMPASS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1F88FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/></svg>`;

const SAFARI_ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(COMPASS_SVG).toString("base64")}`;

/**
 * Returns the visual fields (`url` or `imageDataUri`) for a browser.
 * Caller composes the full `SourceIcon` by adding `sfSymbol` and `color`.
 * Browsers without a custom icon fall through to the source's default
 * (a globe glyph), satisfied by an empty object spread.
 */
export function getBrowserIconImage(browserId: BrowserId): { url?: string; imageDataUri?: string } {
  switch (browserId) {
    case "chrome":
      return { url: CHROME_ICON_URL };
    case "safari":
      return { imageDataUri: SAFARI_ICON_DATA_URI };
    default:
      return {};
  }
}

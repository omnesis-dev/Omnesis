// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Capability icons for the Models view. The capability metadata served by
 * `GET /admin/models` (`overview.capabilities`) carries an `icon` slug per
 * capability; this component maps that slug to an inline SVG glyph.
 *
 * The glyphs are Lucide icons (https://lucide.dev, ISC-licensed) inlined
 * as raw path markup — no runtime icon library is pulled in, matching how the
 * sidebar nav and file-type glyphs already inline their SVGs. They stroke in
 * `currentColor` so they inherit the surrounding text colour and theme.
 *
 * If a slug has no entry here the component renders a neutral fallback dot, so
 * a future capability that ships before its glyph still renders cleanly.
 */

import { html } from "htm/preact";

// Inner markup for each Lucide slug (the `<path>`/`<rect>`/… children only).
// Keep these in sync with the `icon` slugs in `CAPABILITY_METADATA`
// (packages/core/src/models/capabilities.ts).
const GLYPHS = {
  // embedder — "binary": text reduced to numeric vectors.
  binary: html`<rect x="14" y="14" width="4" height="6" rx="2" /><rect x="6" y="4" width="4" height="6" rx="2" /><path d="M6 20h4" /><path d="M14 10h4" /><path d="M6 14h2v6" /><path d="M14 4h2v6" />`,
  // agent — "bot".
  bot: html`<path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />`,
  // privacy reviewer and entailment verifier — "shield-check": a claim
  // guarded before it passes.
  "shield-check": html`<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" />`,
  // "telescope" — the Deep Research slash command / run.
  telescope: html`<path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44" /><path d="m13.56 11.747 4.332-.924" /><path d="m16 21-3.105-6.21" /><path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z" /><path d="m6.158 8.633 1.114 4.456" /><path d="m8 21 3.105-6.21" /><circle cx="12" cy="13" r="2" />`,
  // transcriber — "mic".
  mic: html`<path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" />`,
  // ocr — "scan-text".
  "scan-text": html`<path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 8h8" /><path d="M7 12h10" /><path d="M7 16h6" />`,
  // Watch judge — "scan-search": inspect a bounded nomination precisely.
  "scan-search": html`<path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><circle cx="11" cy="11" r="3" /><path d="m16 16-2.5-2.5" />`,
};

/**
 * True when `slug` resolves to a real glyph (not the fallback dot). Used by the
 * drift guard so a new capability icon slug can't silently fall back to the dot.
 */
export function hasCapabilityGlyph(slug) {
  return Object.prototype.hasOwnProperty.call(GLYPHS, slug);
}

/**
 * @param {{ icon?: string, size?: number }} props
 *   `icon` is a Lucide slug from `CAPABILITY_METADATA`; `size` is the px box
 *   (default 22).
 */
export function CapabilityIcon({ icon, size = 22 }) {
  const glyph = (icon && GLYPHS[icon]) || null;
  return html`<svg
    class="capability-icon"
    aria-hidden="true"
    viewBox="0 0 24 24"
    width=${size}
    height=${size}
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    ${glyph ?? html`<circle cx="12" cy="12" r="4" />`}
  </svg>`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The single source of truth for device-kind glyphs in the portal. Every page
// that shows a device icon (the Devices list, the Sources host chips, …) renders
// through `KindIcon` / `kindGlyph` here, so a given device kind looks identical
// everywhere. Do NOT inline device-kind SVGs anywhere else.

import { html } from "htm/preact";

/**
 * Inner markup for a device-kind glyph, drawn inside a shared 16×16 viewBox.
 * Fills use `currentColor` so the same paths work for muted/secondary/active
 * text. Returns a fresh vnode per call (never a shared instance) so sibling
 * rows of the same kind diff cleanly.
 */
export function kindGlyph(kind) {
  if (kind === "ios") {
    // Phone outline with a home-button dot.
    return html`<rect x="4.5" y="1.5" width="7" height="13" rx="1.4"/><line x1="7" y1="13" x2="9" y2="13"/>`;
  }
  if (kind === "android") {
    // Full bugdroid mascot, filled: antennae (inherited stroke), a domed head
    // with two eye holes (even-odd), a rounded body, two arms and two legs.
    // A solid silhouette reads as the Android robot even at 16px, where thin
    // strokes blur into a blob.
    return html`<path d="M6 3.1 4.9 1.3M10 3.1 11.1 1.3"/><path fill="currentColor" stroke="none" fill-rule="evenodd" d="M4.1 6.8a3.9 3.9 0 0 1 7.8 0z M6.5 4.9a0.62 0.62 0 1 0 0.001 0z M9.5 4.9a0.62 0.62 0 1 0 0.001 0z"/><rect x="4.1" y="7.3" width="7.8" height="5" rx="1.2" fill="currentColor" stroke="none"/><rect x="1.9" y="7.6" width="1.6" height="4" rx="0.8" fill="currentColor" stroke="none"/><rect x="12.5" y="7.6" width="1.6" height="4" rx="0.8" fill="currentColor" stroke="none"/><rect x="5.6" y="11.9" width="1.6" height="2.6" rx="0.6" fill="currentColor" stroke="none"/><rect x="8.8" y="11.9" width="1.6" height="2.6" rx="0.6" fill="currentColor" stroke="none"/>`;
  }
  if (kind === "cli") {
    // Terminal: window with a prompt caret and a line.
    return html`<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M4 6l2 2-2 2M8 10h4"/>`;
  }
  if (kind === "portal") {
    // Browser: window with three dots in a tab bar.
    return html`<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M1.5 6h13"/><circle cx="3.5" cy="4.25" r="0.4" fill="currentColor"/><circle cx="5" cy="4.25" r="0.4" fill="currentColor"/><circle cx="6.5" cy="4.25" r="0.4" fill="currentColor"/>`;
  }
  if (kind === "agent") {
    // Circle with a play-triangle inside — first-party agent integration.
    return html`<circle cx="8" cy="8" r="6"/><path d="M6.5 5.5l4 2.5-4 2.5z" fill="currentColor" stroke="none"/>`;
  }
  if (kind === "integration") {
    // Plug: two prongs into a rounded body, a cord leaving below — something
    // outside plugged into Omnesis.
    return html`<path d="M6 1.5v3M10 1.5v3"/><rect x="4" y="4.5" width="8" height="4.5" rx="1.2"/><path d="M8 9v2.5a2 2 0 0 1-2 2H4.5"/>`;
  }
  if (kind === "browser") {
    // Jigsaw piece — the universal "extension" glyph: a knob bulging up on
    // top and a notch cut into the right edge (the classic puzzle silhouette).
    return html`<path d="M3.5 4 H6.4 A1.6 1.6 0 0 1 9.6 4 H12.5 V6.4 A1.6 1.6 0 0 0 12.5 9.6 V13 H3.5 Z"/>`;
  }
  // Collector (the desktop/laptop host running the sync engine) and any
  // unknown kind: a laptop — the physical machine, not its data.
  return html`<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M1 13h14"/>`;
}

/**
 * Inline glyph for a device kind. `size` and `class` let callers match their
 * context (the 16px Devices list icon, the 12px Sources host chip, …) while the
 * glyph paths stay shared. Inherits stroke colour via `currentColor`.
 */
export function KindIcon({ kind, size = 16, class: className = "devices-kind-icon" }) {
  return html`<svg
    aria-hidden="true"
    class=${className}
    viewBox="0 0 16 16"
    width=${size}
    height=${size}
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >${kindGlyph(kind)}</svg>`;
}

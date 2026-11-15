// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

/**
 * The one mark for something waiting on the owner's decision, beside a sidebar item or a tab: an
 * "i" in a circle, in the accent color, where a model problem shows a warning triangle. `label`
 * says what waits and how many, for a screen reader and on hover (see `lib/attention.js`).
 */
export function AttentionIcon({ label }) {
  return html`<span class="attention-icon" role="img" aria-label=${label} title=${label}>
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6">
      <circle cx="10" cy="10" r="8.2"/><path d="M10 9v5" stroke-linecap="round"/><circle cx="10" cy="6.2" r=".9" fill="currentColor" stroke="none"/>
    </svg>
  </span>`;
}

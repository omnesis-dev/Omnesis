// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

/**
 * A connected segmented control — one visual unit with an active segment,
 * for mutually-exclusive filters and mode toggles. Wraps the portal-wide
 * `.segmented` styling (shared border, end-rounded corners) so views stop
 * hand-rolling rows of disconnected buttons.
 *
 * `options`: [{ value, label, count? }] — `count` renders a dim trailing
 * tally on the segment (e.g. "Failed · 3"); 0 renders like any number,
 * null/undefined renders no tally.
 */
export function Segmented({ options, value, onChange, className }) {
  return html`
    <div class=${`segmented ${className ?? ""}`.trim()} role="group">
      ${options.map(
        (o) => html`
          <button
            key=${o.value}
            type="button"
            class=${value === o.value ? "active" : ""}
            aria-pressed=${value === o.value}
            onClick=${() => onChange(o.value)}
          >
            ${o.label}${o.count != null &&
            html`<span class="segmented-count">${" "}${o.count}</span>`}
          </button>
        `,
      )}
    </div>
  `;
}

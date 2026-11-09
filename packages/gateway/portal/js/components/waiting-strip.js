// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The strip that says something is waiting on the owner and offers the one
// action it wants. Access requests from MCP clients use it on the Access page;
// devices that signed in and wait for approval use it above every page. It sits
// in the page flow, so it pushes content down and never covers it.

import { html } from "htm/preact";

/**
 * @param {object} props
 * @param {string} [props.title] heading above the rows; needs `titleId`.
 * @param {string} [props.titleId]
 * @param {string} [props.label] accessible name when there is no heading.
 * @param {string} [props.className] extra class for where the strip is placed.
 * @param {Array<{ key: string, text: unknown, meta?: string, actionLabel: string, onAction: () => void }>} props.items
 */
export function WaitingStrip({ title, titleId, label, className = "", items }) {
  return html`<section
    class=${`access-pending${className ? ` ${className}` : ""}`}
    aria-labelledby=${title ? titleId : undefined}
    aria-label=${title ? undefined : label}
  >
    ${title && html`<h3 id=${titleId}>${title}</h3>`}
    <ul class="access-pending-list">
      ${items.map((item) => html`<li key=${item.key} class="access-pending-item">
        <span class="access-pending-client">${item.text}</span>
        ${item.meta && html`<span class="access-pending-expiry">${item.meta}</span>`}
        <button type="button" class="btn-primary access-pending-review" onClick=${item.onAction}>
          ${item.actionLabel}
        </button>
      </li>`)}
    </ul>
  </section>`;
}

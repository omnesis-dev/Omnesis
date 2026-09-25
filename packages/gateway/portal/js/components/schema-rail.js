// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Shared schema rail — used by the Data view (table picker, click selects)
// and the SQL view (table list, click toggles column expansion, "+" inserts
// into the editor). Both pages render a grouped table list in a sticky left
// rail; consolidating here keeps the typography, spacing, and group/heading
// styles in lockstep so the two pages don't drift visually.

import { html } from "htm/preact";

export function SchemaRail({ title, children }) {
  return html`
    <aside class="schema-rail">
      ${title && html`<div class="schema-rail-title">${title}</div>`}
      ${children}
    </aside>
  `;
}

export function SchemaRailGroup({ label, count, children }) {
  return html`
    <div class="schema-rail-group">
      <div class="schema-rail-heading">
        <span>${label}</span>
        ${count != null && html`<span class="schema-rail-count">${count}</span>`}
      </div>
      ${children}
    </div>
  `;
}

export function SchemaRailItem({
  active,
  onClick,
  leadIcon,
  name,
  rowEnd,
  title,
  children,
}) {
  return html`
    <div class="schema-rail-item-wrap">
      <button
        class=${`schema-rail-item ${active ? "active" : ""}`}
        onClick=${onClick}
        title=${title}
      >
        ${leadIcon != null ? html`<span class="schema-rail-caret">${leadIcon}</span>` : null}
        <span class="schema-rail-name">${name}</span>
        ${rowEnd != null ? html`<span class="schema-rail-end">${rowEnd}</span>` : null}
      </button>
      ${children}
    </div>
  `;
}

export function SchemaRailEmpty({ children }) {
  return html`<div class="schema-rail-empty">${children}</div>`;
}

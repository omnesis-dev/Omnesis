// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

export function TabBar({ tabs, active, onSelect, style, className }) {
  return html`
    <div class=${`config-tabs ${className ?? ""}`.trim()} style=${style ?? ""}>
      ${tabs.map((t) => html`
        <button
          key=${t.key}
          type="button"
          class=${`config-tab ${active === t.key ? "active" : ""}`.trim()}
          onClick=${() => onSelect(t.key)}
        >${t.label}</button>
      `)}
    </div>
  `;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { sourceIcon, sourceLabel, docTypeLabel } from "../lib/format.js";

export function FacetPanel({ results, onFilter }) {
  if (!results || results.length === 0) return null;

  // Aggregate by type
  const byType = {};
  const bySource = {};
  for (const r of results) {
    const type = r.documentType || "unknown";
    byType[type] = (byType[type] || 0) + 1;

    const src = r.sourceId || "unknown";
    bySource[src] = (bySource[src] || 0) + 1;
  }

  const typeFacets = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const sourceFacets = Object.entries(bySource).sort((a, b) => b[1] - a[1]);

  return html`
    <div class="facets-sidebar">
      <div class="facet-section">
        <div class="facet-title">By Type</div>
        ${typeFacets.map(([type, count]) => html`
          <div class="facet-item" onClick=${() => onFilter("type", type)}>
            <span>${docTypeLabel(type)}</span>
            <span class="facet-count">${count}</span>
          </div>
        `)}
      </div>
      <div class="facet-section">
        <div class="facet-title">By Source</div>
        ${sourceFacets.map(([src, count]) => html`
          <div class="facet-item" onClick=${() => onFilter("source", src)}>
            <span>${sourceIcon(src)} ${sourceLabel(src)}</span>
            <span class="facet-count">${count}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}

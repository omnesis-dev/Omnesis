// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";

const MAX_CELL_LENGTH = 200;

function formatCell(value) {
  if (value === null || value === undefined) return html`<span class="cell-null">NULL</span>`;
  const str = String(value);
  if (str.length > MAX_CELL_LENGTH) return str.slice(0, MAX_CELL_LENGTH) + "...";
  return str;
}

// Semantic links are driven by the schema's `references` field on each
// column (see ColumnDefinition in @omnesis/core). Link rendering reads
// from that — never from column name heuristics or value-shape regex —
// so a UUID-shaped value in a column that doesn't reference a document
// (e.g. `health_workouts.id`) won't get a broken `/portal/doc/...` link.

function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  return value.startsWith("http://") || value.startsWith("https://");
}

function renderReferenceLink(reference, value) {
  const display = formatCell(value);
  switch (reference) {
    case "document": {
      const href = "/portal/doc/" + encodeURIComponent(value);
      return html`<a class="cell-doc-link" href=${href} onClick=${(e) => {
        e.preventDefault();
        navigate(href);
      }}>${display}</a>`;
    }
    case "person": {
      const href = "/portal/people/" + encodeURIComponent(value);
      return html`<a class="cell-doc-link" href=${href} onClick=${(e) => {
        e.preventDefault();
        navigate(href);
      }}>${display}</a>`;
    }
    case "source": {
      const href = "/portal/sources/" + encodeURIComponent(value) + "/recent";
      return html`<a class="cell-doc-link" href=${href} onClick=${(e) => {
        e.preventDefault();
        navigate(href);
      }}>${display}</a>`;
    }
    case "url": {
      if (!isHttpUrl(value)) return display;
      return html`<a class="cell-doc-link" href=${value} target="_blank" rel="noopener noreferrer">${display}</a>`;
    }
    default:
      return display;
  }
}

/**
 * Render a tabular preview.
 *
 * Props:
 *   columns     — array of column names (strings)
 *   rows        — array of row arrays (cells indexed by column position)
 *   columnDefs  — optional ColumnDefinition[] (full schema). When provided,
 *                 cells whose column carries a `references` field render as
 *                 a typed link (document / person / source / url). When
 *                 absent (e.g. arbitrary SQL-view results), no auto-links.
 */
export function DataTable({ columns, rows, columnDefs }) {
  if (!columns || columns.length === 0) {
    return html`<div class="empty-state">No columns</div>`;
  }

  const refByName = new Map();
  if (Array.isArray(columnDefs)) {
    for (const def of columnDefs) {
      if (def?.name && def.references) refByName.set(def.name, def.references);
    }
  }

  function renderCell(cell, colIdx) {
    if (cell === null || cell === undefined) return formatCell(cell);
    const colName = columns[colIdx];
    const reference = refByName.get(colName);
    if (reference && cell !== "") return renderReferenceLink(reference, cell);
    return formatCell(cell);
  }

  return html`
    <div class="data-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            ${columns.map((col) => html`<th key=${col}>${col}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, i) => html`
            <tr key=${i}>
              ${row.map((cell, j) => html`<td key=${j}>${renderCell(cell, j)}</td>`)}
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { storageBytes, storageReconciliation } from "./storage-data.js";

/** One file breakdown and one reconciliation, alongside the existing physical pie. */
export function StorageFootprint({ snapshot, slices, active, setHover, setFocus, colors }) {
  const data = storageReconciliation(snapshot);
  return html`<div class="storage-reconciliation">
    <div class="storage-reconciliation-scroll"><table class="storage-reconciliation-table">
      <caption class="sr-only">How Omnesis files relate to the source totals</caption>
      <thead><tr><th scope="col">Stored in</th><th scope="col">On disk</th><th scope="col">In sources</th><th scope="col">Other storage</th></tr></thead>
      <tbody onPointerLeave=${() => setHover(null)}>
        ${data.rows.filter((row) => row.bytes !== 0 || row.sourceBytes > 0).map((row) => {
          const index = slices.findIndex((slice) => slice.id === row.id);
          return html`<tr key=${row.id} class=${active === index && index >= 0 ? "storage-legend-active" : ""}
            onPointerEnter=${() => setHover(index < 0 ? null : index)} onFocus=${() => setFocus(index < 0 ? null : index)} onBlur=${() => setFocus(null)}>
            <th scope="row"><div class="storage-store-label">${index >= 0 && html`<span class="storage-swatch" aria-hidden="true" style=${`background:${colors[index % colors.length]}`}></span>`}${row.components?.length ? html`<details class="storage-file-details">
              <summary><span>${row.label}</span></summary>
              <dl>${row.components.map((part) => html`<div key=${part.id}><dt>${part.label}</dt><dd>${storageBytes(part.bytes)}</dd></div>`)}</dl>
            </details>` : html`<span tabindex="0">${row.label}</span>`}</div></th>
            <td>${storageBytes(row.bytes)}</td>
            <td>${row.attributed ? html`${storageBytes(row.sourceBytes)}${row.partial && row.sourceBytes !== null ? html`<small class="storage-note"> partial</small>` : ""}` : html`<span title="Outside the per-source totals">—</span>`}</td>
            <td>${row.state === "ready" ? storageBytes(row.remainderBytes) : html`<span class="storage-note">${row.state === "updating" ? "Updating" : "Not measured"}</span>`}</td>
          </tr>`;
        })}
      </tbody>
      <tfoot><tr><th scope="row">Total</th><td>${storageBytes(data.physicalBytes)}</td><td>${storageBytes(data.sourceBytes)}</td><td>${storageBytes(data.remainderBytes)}</td></tr></tfoot>
    </table></div>
    <p class="storage-note storage-reconciliation-explanation"><strong>On disk = In sources + Other storage.</strong> Other storage includes shared database space, reusable pages, write logs, search graphs and files outside sources. Estimates update separately, so recent changes can temporarily appear in Other storage. Expand a store to see its files.</p>
    ${data.state !== "ready" && html`<p class="storage-note" role="status">${data.state === "updating" ? "Measurements are updating. Source estimates and files were measured separately, so their difference is not shown yet." : "Some measurements are unavailable. The source total and remaining storage will appear when the breakdown is complete."}</p>`}
  </div>`;
}

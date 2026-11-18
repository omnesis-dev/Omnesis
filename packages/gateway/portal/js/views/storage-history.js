// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

const MAX_BUCKETS = 120;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function ordinal(value) {
  const match = typeof value === "string" ? MONTH.exec(value) : null;
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

function monthOf(value) {
  return `${String(Math.floor(value / 12)).padStart(4, "0")}-${String(value % 12 + 1).padStart(2, "0")}`;
}

function bytes(value) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value, unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

function monthLabel(value) {
  return new Date(`${monthOf(value)}-01T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: "short", year: "numeric", timeZone: "UTC",
  });
}

/** Calendar gaps are represented by at most 120 buckets, never an array per elapsed month. */
export function storageHistoryData(months, now = new Date()) {
  const instant = new Date(now);
  const validNow = Number.isFinite(instant.getTime()) ? instant : new Date();
  const today = validNow.toISOString().slice(0, 10);
  const current = validNow.getUTCFullYear() * 12 + validNow.getUTCMonth();
  const dated = new Map();
  let undatedBytes = 0, futureBytes = 0;
  for (const entry of months ?? []) {
    const amount = Number.isFinite(entry?.bytes) ? Math.max(0, entry.bytes) : 0;
    const month = ordinal(entry?.month);
    if (month === null) undatedBytes += amount;
    else if (month > current) futureBytes += amount;
    else dated.set(month, (dated.get(month) ?? 0) + amount);
  }
  let first = current;
  for (const month of dated.keys()) first = Math.min(first, month);
  const span = current - first + 1;
  const count = Math.min(MAX_BUCKETS, span);
  const buckets = Array.from({ length: count }, (_, index) => {
    const start = first + Math.floor(index * span / count);
    const end = first + Math.floor((index + 1) * span / count);
    return { startMonth: monthOf(start), endMonth: monthOf(end - 1), startOrdinal: start, endOrdinal: end, bytes: 0 };
  });
  for (const [month, amount] of dated) {
    const index = Math.min(count - 1, Math.ceil((month - first + 1) * count / span) - 1);
    buckets[index].bytes += amount;
  }
  let cumulativeBytes = 0;
  for (const bucket of buckets) {
    cumulativeBytes += bucket.bytes;
    bucket.cumulativeBytes = cumulativeBytes;
    bucket.cutoff = bucket.endOrdinal > current ? today : `${monthOf(bucket.endOrdinal)}-01`;
    bucket.label = bucket.startOrdinal === bucket.endOrdinal - 1
      ? monthLabel(bucket.startOrdinal)
      : `${monthLabel(bucket.startOrdinal)} – ${monthLabel(bucket.endOrdinal - 1)}`;
  }
  return {
    buckets, totalBytes: cumulativeBytes, undatedBytes, futureBytes, coarsened: span > count,
    start: new Date(`${monthOf(first)}-01T00:00:00.000Z`).getTime(),
    end: validNow.getTime(), today,
  };
}

/**
 * Shared by source details and retention dialogs; selection only updates the cutoff.
 * SVG handlers use native lowercase event names across browser and DOM adapters.
 */
export function StorageHistory({ months = [], selectedCutoff = null, onSelectCutoff, now = new Date(), label = "Storage by source date" } = {}) {
  const data = storageHistoryData(months, now);
  const left = 66, right = 742, top = 20, bottom = 182;
  const duration = Math.max(1, data.end - data.start);
  const x = (timestamp) => left + Math.max(0, Math.min(1, (timestamp - data.start) / duration)) * (right - left);
  const y = (amount) => bottom - amount / Math.max(1, data.totalBytes) * (bottom - top);
  const points = data.buckets.map((bucket) => ({
    ...bucket,
    x: x(Math.min(data.end, new Date(`${monthOf(bucket.endOrdinal)}-01T00:00:00.000Z`).getTime())),
    startX: x(new Date(`${bucket.startMonth}-01T00:00:00.000Z`).getTime()),
    y: y(bucket.cumulativeBytes),
  }));
  const cutoffTime = typeof selectedCutoff === "string" && /^\d{4}-\d{2}-\d{2}$/.test(selectedCutoff)
    ? Date.parse(`${selectedCutoff}T00:00:00.000Z`) : NaN;
  const cutoffVisible = Number.isFinite(cutoffTime)
    && new Date(cutoffTime).toISOString().slice(0, 10) === selectedCutoff
    && cutoffTime >= data.start && cutoffTime <= data.end;
  const chosen = points.findIndex((point) => point.cutoff === selectedCutoff);
  const tabPoint = chosen < 0 ? points.length - 1 : chosen;
  const description = (point) => `${point.label}: ${bytes(point.bytes)} in this period, ${bytes(point.cumulativeBytes)} cumulative.${onSelectCutoff ? ` Select cutoff ${point.cutoff}.` : ""}`;
  function keyboard(event, index) {
    const keys = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: points.length - 1 };
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); onSelectCutoff?.(points[index].cutoff); return;
    }
    if (!Object.hasOwn(keys, event.key)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(points.length - 1, keys[event.key]));
    const targets = [...event.currentTarget.parentElement.querySelectorAll("[data-history-point]")];
    targets.forEach((target, position) => target.setAttribute("tabindex", position === next ? "0" : "-1"));
    targets[next]?.focus();
  }
  return html`<figure class="storage-history" aria-label=${label}>
    <div class="storage-history-legend"><span class="storage-history-line-key">Cumulative storage</span><span class="storage-history-bar-key">${data.coarsened ? "Storage per period" : "Monthly storage"}</span></div>
    ${data.totalBytes > 0 ? html`<div class="storage-history-canvas" style="overflow-x:auto;max-width:100%">
      <svg class="storage-history-svg" viewBox="0 0 760 232" width="100%" height="232" style="display:block;min-width:560px" aria-label=${label} role="group">
        ${[0, 0.5, 1].map((fraction) => html`<g key=${fraction}><line x1=${left} x2=${right} y1=${y(data.totalBytes * fraction)} y2=${y(data.totalBytes * fraction)} stroke="var(--border)" stroke-dasharray="3 4" /><text x=${left - 10} y=${y(data.totalBytes * fraction) + 4} text-anchor="end" fill="var(--text-secondary)" font-size="11">${bytes(data.totalBytes * fraction)}</text></g>`)}
        ${points.map((point) => html`<rect key=${`bar:${point.startMonth}`} class="storage-history-bar" x=${point.startX + 1} y=${y(point.bytes)} width=${Math.max(1, point.x - point.startX - 2)} height=${bottom - y(point.bytes)} fill="var(--accent)" opacity=${point.cutoff === selectedCutoff ? "0.5" : "0.2"}><title>${point.label}: ${bytes(point.bytes)}</title></rect>`)}
        <path class="storage-history-line" d=${`M ${left} ${bottom} ${points.map((point) => `L ${point.x} ${point.y}`).join(" ")}`} fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" />
        ${cutoffVisible && html`<line class="storage-history-cutoff" x1=${x(cutoffTime)} x2=${x(cutoffTime)} y1=${top} y2=${bottom} stroke="var(--text-secondary)" stroke-dasharray="4 4" pointer-events="none" />`}
        <g class="storage-history-points">${points.map((point, index) => html`<g key=${point.startMonth} data-history-point=${index} class=${`storage-history-point${point.cutoff === selectedCutoff ? " is-selected" : ""}`} role=${onSelectCutoff ? "button" : "img"} tabindex=${onSelectCutoff ? (index === tabPoint ? 0 : -1) : null} aria-label=${description(point)} aria-pressed=${onSelectCutoff ? point.cutoff === selectedCutoff : null} onclick=${onSelectCutoff ? () => onSelectCutoff(point.cutoff) : null} onkeydown=${onSelectCutoff ? (event) => keyboard(event, index) : null}>
          <circle cx=${point.x} cy=${point.y} r=${Math.min(11, (right - left) / points.length / 2)} fill="transparent" />
          <circle class="storage-history-point-dot" cx=${point.x} cy=${point.y} r=${point.cutoff === selectedCutoff ? "5" : "3"} fill=${point.cutoff === selectedCutoff ? "var(--text-primary)" : "var(--accent)"} stroke="var(--bg-primary)" stroke-width="1.5" />
          <title>${description(point)}</title>
        </g>`)}</g>
        <text x=${left} y="212" fill="var(--text-secondary)" font-size="11">${monthLabel(data.buckets[0].startOrdinal)}</text><text x=${right} y="212" text-anchor="end" fill="var(--text-secondary)" font-size="11">Now</text>
      </svg>
    </div>` : html`<p class="storage-history-empty">No dated storage to plot.</p>`}
    <figcaption class="storage-history-caption">${onSelectCutoff ? "Choose a point, or focus the graph and use arrow keys, then Enter, to set a cutoff. " : ""}${data.coarsened ? "Long histories are grouped into periods. " : ""}Current storage grouped by source date. Amounts estimate the selected history; database file sizes can remain unchanged.${selectedCutoff && html`<span class="storage-history-selection"> Cutoff: ${selectedCutoff}.</span>`}</figcaption>
    ${data.undatedBytes > 0 && html`<p class="storage-history-unplaced">${bytes(data.undatedBytes)} has no usable month and is outside this timeline.</p>`}
    ${data.futureBytes > 0 && html`<p class="storage-history-unplaced">${bytes(data.futureBytes)} is dated after the current month and is outside this timeline.</p>`}
  </figure>`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useId, useRef, useState } from "preact/hooks";

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

/** Interpolate the displayed cumulative curve at an exact UTC cutoff. */
export function storageHistoryArea(data, cutoff) {
  if (typeof cutoff !== "string") return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(cutoff);
  const timestamp = Date.parse(day ? `${cutoff}T00:00:00.000Z` : cutoff);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  if (day ? normalized.slice(0, 10) !== cutoff : normalized !== cutoff) return null;
  if (timestamp <= data.start) return null;
  const end = Math.min(timestamp, data.end);
  const points = [{ time: data.start, bytes: 0 }];
  let previousTime = data.start, previousBytes = 0;
  for (const bucket of data.buckets) {
    const time = Math.min(data.end, Date.parse(`${monthOf(bucket.endOrdinal)}-01T00:00:00.000Z`));
    if (end >= time) {
      points.push({ time, bytes: bucket.cumulativeBytes });
      previousTime = time; previousBytes = bucket.cumulativeBytes;
      if (time === end) break;
    } else {
      const fraction = (end - previousTime) / Math.max(1, time - previousTime);
      points.push({ time: end, bytes: previousBytes + fraction * (bucket.cumulativeBytes - previousBytes) });
      break;
    }
  }
  return { points, time: end, bytes: points[points.length - 1].bytes };
}

/**
 * Shared by source details and retention dialogs; selection only updates the cutoff.
 * SVG handlers use native lowercase event names across browser and DOM adapters.
 */
export function StorageHistory({ months = [], selectedCutoff = null, cutoffInstant = null, onSelectCutoff, scheduledCutoff = null, now = new Date(), label = "Storage by source date" } = {}) {
  const plot = useRef(null);
  const tooltipId = useId();
  const [hovered, setHovered] = useState(null);
  const [focused, setFocused] = useState(null);
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
  const cutoff = cutoffInstant || selectedCutoff || scheduledCutoff;
  const scheduled = !cutoffInstant && !selectedCutoff && !!scheduledCutoff;
  const shade = scheduled ? "var(--storage-scheduled, #f97316)" : "var(--danger, #f85149)";
  const pendingMonths = scheduled ? months.filter((month) => MONTH.test(month.month) && month.month <= cutoff.slice(0, 7)) : [];
  const hasTrimmableHistory = !scheduled || pendingMonths.some((month) =>
    month.trimmableDocuments === undefined || month.trimmableDocuments > 0);
  const area = hasTrimmableHistory ? storageHistoryArea(data, cutoff) : null;
  const selected = (point) => !cutoffInstant && point.cutoff === selectedCutoff;
  const chosen = points.findIndex((point) => point.cutoff === selectedCutoff);
  const tabPoint = chosen < 0 ? points.length - 1 : chosen;
  const active = hovered ?? focused;
  const activePoint = active ? points[active.index] : null;
  const description = (point) => `${point.label}: ${bytes(point.bytes)} in this period, ${bytes(point.cumulativeBytes)} cumulative.${onSelectCutoff ? ` Select cutoff ${point.cutoff}.` : ""}`;

  function show(event, index, setter) {
    const bounds = plot.current?.getBoundingClientRect();
    const target = event.currentTarget.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0 };
    const width = bounds?.width || 560;
    const anchorX = target.left + target.width / 2 - (bounds?.left ?? 0);
    const plotTop = bounds?.top ?? 0;
    const pointBottom = target.bottom ?? target.top + (target.height ?? 0);
    const cardHeight = 128, margin = 12;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
    let top = pointBottom - plotTop + margin;
    if (viewportHeight > 0) {
      if (viewportHeight - pointBottom < cardHeight + margin)
        top = target.top - plotTop - cardHeight - margin;
      top = Math.max(margin - plotTop, Math.min(viewportHeight - cardHeight - margin - plotTop, top));
    }
    setter({ index, left: Math.max(8, Math.min(width - 232, anchorX - 112)), top });
  }

  function keyboard(event, index) {
    const keys = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: points.length - 1 };
    if ((event.key === "Enter" || event.key === " ") && onSelectCutoff) {
      event.preventDefault(); onSelectCutoff(points[index].cutoff); return;
    }
    if (!Object.hasOwn(keys, event.key)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(points.length - 1, keys[event.key]));
    const targets = [...event.currentTarget.parentElement.querySelectorAll("[data-history-point]")];
    targets.forEach((target, position) => target.setAttribute("tabindex", position === next ? "0" : "-1"));
    targets[next]?.focus?.();
  }

  return html`<figure class="storage-history" aria-label=${label}>
    <div class="storage-history-legend"><span class="storage-history-line-key">Cumulative storage</span><span class="storage-history-bar-key">${data.coarsened ? "Storage per period" : "Monthly storage"}</span>${area && html`<span class=${scheduled ? "storage-history-scheduled-key" : "storage-history-trim-key"}>${scheduled ? "Scheduled for trimming" : "Selected history"}</span>`}</div>
    ${data.totalBytes > 0 ? html`<div class="storage-history-plot" ref=${plot} onpointerleave=${() => setHovered(null)}>
      <div class="storage-history-canvas" style="overflow-x:auto;max-width:100%" onscroll=${() => { setHovered(null); setFocused(null); }}>
      <svg class="storage-history-svg" viewBox="0 0 760 232" width="100%" height="232" style="display:block;min-width:560px" aria-label=${label} role="group">
        ${[0, 0.5, 1].map((fraction) => html`<g key=${fraction}><line x1=${left} x2=${right} y1=${y(data.totalBytes * fraction)} y2=${y(data.totalBytes * fraction)} stroke="var(--border)" stroke-dasharray="3 4" /><text x=${left - 10} y=${y(data.totalBytes * fraction) + 4} text-anchor="end" fill="var(--text-secondary)" font-size="11">${bytes(data.totalBytes * fraction)}</text></g>`)}
        ${points.map((point) => html`<rect key=${`bar:${point.startMonth}`} class="storage-history-bar" x=${point.startX + 1} y=${y(point.bytes)} width=${Math.max(1, point.x - point.startX - 2)} height=${bottom - y(point.bytes)} fill="var(--accent)" opacity="0.2" pointer-events="none" />`)}
        ${area && html`<path class=${`storage-history-trim-area${scheduled ? " storage-history-scheduled-area" : ""}`} d=${`M ${left} ${bottom} ${area.points.map((point) => `L ${x(point.time)} ${y(point.bytes)}`).join(" ")} L ${x(area.time)} ${bottom} Z`} fill=${shade} opacity=${scheduled ? "0.3" : "0.2"} pointer-events="none" data-cutoff=${cutoff} />`}
        <path class="storage-history-line" d=${`M ${left} ${bottom} ${points.map((point) => `L ${point.x} ${point.y}`).join(" ")}`} fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" pointer-events="none" />
        ${area && html`<g class="storage-history-cutoff" pointer-events="none"><line x1=${x(area.time)} x2=${x(area.time)} y1=${y(area.bytes)} y2=${bottom} stroke=${shade} stroke-dasharray="4 4" /><circle cx=${x(area.time)} cy=${y(area.bytes)} r="4" fill=${shade} /></g>`}
        <g class="storage-history-points">${points.map((point, index) => html`<g key=${point.startMonth} data-history-point=${index} class=${`storage-history-point${selected(point) ? " is-selected" : ""}`} role=${onSelectCutoff ? "button" : "img"} tabindex=${index === tabPoint ? 0 : -1} aria-label=${description(point)} aria-describedby=${active?.index === index ? tooltipId : undefined} aria-pressed=${onSelectCutoff ? selected(point) : null} onclick=${onSelectCutoff ? () => onSelectCutoff(point.cutoff) : null} onkeydown=${(event) => keyboard(event, index)} onpointerenter=${(event) => show(event, index, setHovered)} onpointerleave=${() => setHovered(null)} onfocus=${(event) => show(event, index, setFocused)} onblur=${() => setFocused(null)}>
          <circle cx=${point.x} cy=${point.y} r=${Math.min(11, (right - left) / points.length / 2)} fill="transparent" />
          <circle class="storage-history-point-dot" cx=${point.x} cy=${point.y} r=${selected(point) ? "5" : "3"} fill=${selected(point) ? "var(--text-primary)" : "var(--accent)"} stroke="var(--bg-primary)" stroke-width="1.5" />
        </g>`)}</g>
        <text x=${left} y="212" fill="var(--text-secondary)" font-size="11">${monthLabel(data.buckets[0].startOrdinal)}</text><text x=${right} y="212" text-anchor="end" fill="var(--text-secondary)" font-size="11">Now</text>
      </svg>
      </div>
      ${activePoint && html`<div class="storage-history-hover" id=${tooltipId} role="tooltip" style=${`left:${active.left}px;top:${active.top}px`}>
        <span class="storage-history-hover-period">${activePoint.label}</span><strong>${bytes(activePoint.cumulativeBytes)}</strong><span>Cumulative storage</span><small>${bytes(activePoint.bytes)} in this period</small>
      </div>`}
    </div>` : html`<p class="storage-history-empty">No dated storage to plot.</p>`}
    <figcaption class="storage-history-caption">${onSelectCutoff ? "Choose a point, or focus the graph and use arrow keys, then Enter, to set a cutoff. " : ""}${data.coarsened ? "Long histories are grouped into periods. " : ""}Current storage grouped by source date. Protected documents are kept. Amounts estimate the selected history; database file sizes can remain unchanged.${selectedCutoff && html`<span class="storage-history-selection"> Cutoff: ${selectedCutoff}.</span>`}</figcaption>
    ${data.undatedBytes > 0 && html`<p class="storage-history-unplaced">${bytes(data.undatedBytes)} has no usable month and is outside this timeline.</p>`}
    ${data.futureBytes > 0 && html`<p class="storage-history-unplaced">${bytes(data.futureBytes)} is dated after the current month and is outside this timeline.</p>`}
  </figure>`;
}

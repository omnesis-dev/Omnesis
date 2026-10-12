// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { Segmented } from "../components/segmented.js";

const BANDS = [
  { key: "considered", color: "var(--success)", label: "Reviewed" },
  { key: "gated", color: "var(--type-event)", label: "Skipped by gate" },
  { key: "deferred", color: "var(--warning)", label: "Deferred" },
  { key: "failed", color: "var(--danger)", label: "Needs retry" },
  { key: "pending", color: "var(--accent)", label: "Not reviewed" },
];
const PHASES = [
  { value: "interpretation", label: "Read evidence" },
  { value: "organization", label: "Connect context" },
];
const fmt = (n) => n.toLocaleString();

export function coverageTotals(months, phase) {
  const counts = Object.fromEntries(BANDS.map(({ key }) => [key, 0]));
  for (const month of months ?? []) {
    for (const { key } of BANDS) counts[key] += month[phase]?.[key] ?? 0;
  }
  return { ...counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) };
}

export function coverageMonthLabel(month) {
  if (!month) return "Undated";
  const [year, number] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(number) - 1] ?? number} ${year}`;
}

export function CoverageColumns({ months, phase }) {
  return html`<div class="tl-chart kh-chart" aria-label="Monthly discovery coverage">
    ${months.map((month) => {
      const counts = month[phase] ?? {};
      const total = BANDS.reduce((sum, { key }) => sum + (counts[key] ?? 0), 0);
      const description = [coverageMonthLabel(month.month), `${fmt(total)} source documents`,
        ...BANDS.map(({ key, label }) => `${label}: ${fmt(counts[key] ?? 0)}`)].join(" · ");
      return html`<div class="tl-col kh-col" key=${month.month ?? "undated"}
        tabindex="0" role="img" aria-label=${description} title=${description}>
        <div class="tl-stack" style=${`height:${total > 0 ? 100 : 0}%;`}>
          ${BANDS.filter(({ key }) => counts[key] > 0).map(({ key, color }) => html`
            <div key=${key} class="tl-seg" style=${`flex-grow:${counts[key]};background:${color};`}></div>`)}
        </div>
      </div>`;
    })}
  </div>`;
}

export function KnowledgeHistoryTimeline({ timeline, loading, error, onRefresh, phase = "interpretation", onPhaseChange }) {
  const months = timeline?.mode === "knowledge" ? timeline.months ?? [] : [];
  const totals = coverageTotals(months, phase);
  const dated = months.filter((month) => month.month);
  return html`<section class="cognition-timeline" aria-label="Historical discovery coverage">
    <div class="tl-head">
      <div>
        <div class="debug-card-label">Your history, month by month</div>
        <div class="tl-headline">${fmt(totals.considered)} of ${fmt(totals.total)} documents${" "}
          ${phase === "interpretation" ? "read" : "reviewed for connections"}</div>
      </div>
      <${Segmented} options=${PHASES} value=${phase} onChange=${onPhaseChange} />
    </div>
    <p class="debug-sub">
      ${phase === "interpretation"
        ? "Has the brain read this evidence and considered what it means?"
        : "Has the brain considered how this evidence belongs with existing knowledge? A review need not create a wiki page."}
    </p>
    ${error && html`<p class="debug-error" role="alert">${error}</p>`}
    ${!timeline && loading ? html`<p role="status">Loading historical coverage…</p>`
      : totals.total === 0 ? html`<p class="debug-empty">No imported source documents measured yet.</p>`
      : html`
        <${CoverageColumns} months=${months} phase=${phase} />
        <div class="tl-axis">
          <span>${coverageMonthLabel(dated[0]?.month)}</span>
          <span>${dated.length ? coverageMonthLabel(dated[dated.length - 1].month) : ""}${dated.length && months.some((m) => !m.month) ? " · Undated" : ""}</span>
        </div>
        <div class="tl-legend">${BANDS.map(({ key, color, label }) => html`
          <span class="tl-key" key=${key}><i style=${`background:${color};`}></i>${label}
            <span class="tl-key-n">${fmt(totals[key])}</span></span>`)}</div>`}
    <div class="kh-footer">
      <span>Current imported versions only. Skipped sources were not read by the synthesis agent.
        History outside your source sync range is not shown. Each column is a month with imported evidence.
        ${timeline?.computedAt && html`<br />Measured ${new Date(timeline.computedAt).toLocaleString()}.`}</span>
      ${onRefresh && html`<button class="btn-secondary" disabled=${loading} onClick=${onRefresh}>Refresh coverage</button>`}
    </div>
  </section>`;
}

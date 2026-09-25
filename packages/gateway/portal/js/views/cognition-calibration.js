// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Calibration — the measurement-only reliability panel on the Cognition
// debug page. Renders, per confidence-carrying artifact family (briefs,
// doc annotations, person annotations), the 10-bin reliability table the
// gateway computes from ground-truth signals it already collects, plus the
// family's ECE and label-class counts. Strictly read-only: nothing here (or
// anywhere) mutates a confidence or recalibrates from these numbers — the
// operator is accumulating a v1 baseline first.
//
// Self-contained module (own loader, own formatting) so its host,
// cognition.js, carries only an import and a mount line.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getCognitionCalibration } from "../api.js";

// ── Pure helpers (exported for tests) ────────────────────────────────

/** Human label for a family key; unknown keys render as themselves. */
export function familyDisplayName(family) {
  const names = {
    brief: "Briefs",
    "doc-annotation": "Doc annotations",
    "person-annotation": "Person annotations",
  };
  return names[family] ?? family;
}

/** "0.6–0.7" for a bin's confidence range. */
export function formatBinRange(bin) {
  return `${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)}`;
}

/** Two-decimal number, or an em dash for null (empty bin / empty family). */
export function fmt2(value) {
  return typeof value === "number" ? value.toFixed(2) : "—";
}

/** Signed two-decimal gap ("+0.12" / "-0.30"), or an em dash for null. */
export function formatGap(gap) {
  if (typeof gap !== "number") return "—";
  return `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}`;
}

/** Only the bins that hold labeled artifacts — an all-zero table is noise. */
export function occupiedBins(family) {
  return (family?.bins ?? []).filter((b) => b.n > 0);
}

/** "verified 3 · superseded 1" — class counts as a stable, compact line. */
export function formatClassCounts(classCounts) {
  return Object.entries(classCounts ?? {})
    .sort(([, a], [, b]) => b - a)
    .map(([cls, n]) => `${cls} ${n}`)
    .join(" · ");
}

// ── Panel ────────────────────────────────────────────────────────────

function FamilyCard({ family }) {
  const bins = occupiedBins(family);
  return html`
    <section>
      <h3 class="cognition-section">
        ${familyDisplayName(family.family)} · ${family.labeled} labeled of ${family.total} · ECE
        ${" "}${fmt2(family.ece)}
      </h3>
      ${family.total > 0 &&
      html`<div class="debug-sub" style="margin: 0 0 8px;">
        ${formatClassCounts(family.classCounts)}
      </div>`}
      ${bins.length === 0
        ? html`<div class="debug-empty">No labeled data yet.</div>`
        : html`
            <table class="debug-table">
              <thead>
                <tr>
                  <th>Confidence</th>
                  <th class="num">n</th>
                  <th class="num">Mean stated</th>
                  <th class="num">Empirical</th>
                  <th class="num">Gap</th>
                </tr>
              </thead>
              <tbody>
                ${bins.map(
                  (b) => html`
                    <tr key=${b.lo}>
                      <td>${formatBinRange(b)}</td>
                      <td class="num">${b.n}</td>
                      <td class="num">${fmt2(b.meanConfidence)}</td>
                      <td class="num">${fmt2(b.empiricalCorrectness)}</td>
                      <td class="num">${formatGap(b.gap)}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    </section>
  `;
}

export function CalibrationTab() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getCognitionCalibration()
      .then((r) => {
        if (!cancelled) {
          setReport(r);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message ?? String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return html`<div class="debug-error">⚠️ ${error}</div>`;
  if (loading) return html`<div class="debug-loading">Loading…</div>`;

  const families = report?.families ?? [];
  return html`
    <div>
      <p class="debug-sub" style="margin: 0 0 16px;">
        Reliability of stated confidence against the ground-truth signals the
        system already collects (dismissals, verification stamps,
        supersessions, developer annotations). Measurement only — nothing
        recalibrates from these numbers.
      </p>
      ${families.length === 0
        ? html`<div class="debug-empty">No calibration data.</div>`
        : families.map((f) => html`<${FamilyCard} key=${f.family} family=${f} />`)}
    </div>
  `;
}

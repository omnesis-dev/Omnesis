// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where the Brain stands, drawn against the operator's own history.
 *
 * The retrospective lane walks recent-first, so its progress is a frontier
 * sweeping BACKWARDS through the past. A count of documents owed says how much
 * is left; this says how far back it has read, which is the question people
 * actually have — and it shows the shape of their corpus while answering it.
 *
 * Every month is one column, oldest on the left, divided into the five things
 * a document can be to this lane:
 *
 *   reviewed   — read, and something was written or deliberately not written
 *   failed     — given up on after repeated failures; permanently skipped
 *   owed       — a candidate the lane has not reached yet
 *   discarded  — read the dates, found nothing still ahead; not its business
 *   unscanned  — date extraction has not run, so nothing is known yet
 *
 * `unscanned` is a band rather than a footnote because date extraction is a
 * recognizer pass over the text, not an instant property: on a corpus still
 * being ingested a real share of documents genuinely have no verdict. Folding
 * them into `discarded` would claim the lane had considered and dismissed
 * them, which is the false completeness this whole surface exists to avoid.
 *
 * `discarded` is usually the overwhelming majority, and showing it is the
 * point. The lane reads documents carrying a date that is still ahead — that
 * is its candidate heuristic — which is why a corpus of 170,000 documents
 * produces a backlog of a few thousand rather than 170,000. Nobody guesses
 * that from a number.
 */

import { html } from "htm/preact";

/**
 * The bands drawn in the chart: the lane's own population.
 *
 * `discarded` is deliberately NOT among them. On a real corpus it is ~95% of
 * every month, so stacking it flattens everything else into a one-pixel line
 * and the chart ends up answering "how large is my corpus" instead of "how far
 * has the Brain read" — which is the only question it exists to answer. The
 * fact that most documents are not the lane's business is worth teaching, but
 * a number in the legend teaches it; it does not need most of the pixels.
 *
 * `unscanned` IS drawn, because an unscanned document may yet turn out to be a
 * candidate. It is work possibly ahead, not work ruled out.
 *
 * Order is stacking order: settled at the bottom, unknown at the top.
 */
const CHART_BANDS = [
  {
    key: "reviewed",
    label: "Reviewed",
    color: "var(--success)",
    hint: "The lane read these and recorded what it found.",
  },
  {
    key: "failed",
    label: "Given up on",
    color: "var(--danger)",
    hint: "Repeated failures exhausted the retries. These are permanently skipped.",
  },
  {
    key: "owed",
    label: "Still to read",
    color: "var(--accent)",
    hint: "A date still ahead was found in these, which is what makes a document worth reading — the lane just has not reached them yet.",
  },
  {
    key: "unscanned",
    label: "Not looked at yet",
    color: "var(--warning)",
    hint: "Date extraction has not run on these, so it is not yet known whether they are worth reading.",
  },
];

/** Shown in the legend only — see the note on CHART_BANDS. */
const DISCARDED_BAND = {
  key: "discarded",
  label: "Nothing ahead",
  color: "var(--border)",
  hint: "Scanned, and carrying no date still in the future. Not the lane's business — and usually the great majority of a corpus, which is why a library of 170,000 documents leaves a backlog of a few thousand.",
};

const LEGEND_BANDS = [...CHART_BANDS, DISCARDED_BAND];

/**
 * A month's drawn height: the lane's own population, excluding `discarded`.
 * Scaling on the full corpus would make every column the same shape.
 */
export function monthTotal(m) {
  return CHART_BANDS.reduce((n, b) => n + (m?.[b.key] ?? 0), 0);
}

/** Every document in the month, including the ones the lane will never read. */
export function monthCorpusTotal(m) {
  return monthTotal(m) + (m?.discarded ?? 0);
}

/** Totals across every month, for the legend. */
export function timelineTotals(months) {
  const out = { reviewed: 0, failed: 0, owed: 0, discarded: 0, unscanned: 0, total: 0 };
  for (const m of months ?? []) {
    for (const b of LEGEND_BANDS) out[b.key] += m[b.key] ?? 0;
    out.total += monthCorpusTotal(m);
  }
  return out;
}

/**
 * How far back the lane has actually swept.
 *
 * NOT the oldest month holding a reviewed document. The lane's cross-arc
 * fetches can mark a document in any month, and a corpus contains stray
 * timestamps — an epoch default, a mis-parsed header — so a single 1976
 * document would otherwise let the panel claim the Brain had read back fifty
 * years. Measured live, that is exactly what happened.
 *
 * The lane walks recent-first and CONTIGUOUSLY, so the honest frontier is the
 * oldest month in an unbroken swept run back from the present: step backwards
 * while each month is either reviewed or had nothing to review, and stop at the
 * first month still holding unread candidates. A stray old document does not
 * extend it, because the unread months between it and the present break the
 * run.
 */
export function frontierMonth(months) {
  const list = months ?? [];
  let frontier = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const reviewed = m.reviewed ?? 0;
    const pending = (m.owed ?? 0) + (m.unscanned ?? 0);
    // Nothing here to read: the sweep passes straight over it without that
    // saying anything about how far it has got.
    if (reviewed === 0 && pending === 0) continue;
    if (reviewed > 0 && pending === 0) {
      frontier = m.month;
      continue;
    }
    // Unread candidates remain: the sweep has not cleared this month, so the
    // run ends here.
    break;
  }
  return frontier;
}

function pretty(month) {
  const [y, mo] = String(month).split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(mo) - 1] ?? mo} ${y}`;
}

const fmt = (n) => (typeof n === "number" ? n.toLocaleString() : "—");

/**
 * One month as a full-height stacked column: composition, not volume.
 *
 * The question is where the Brain has got to, and that is a question about
 * proportion — what share of each month it has read. Scaling columns by volume
 * answers a different question badly: one heavy month (a bulk import, a stretch
 * still being date-scanned) then towers over everything and flattens the rest
 * into a line, which is exactly where the frontier lives.
 *
 * At full height the frontier is unmistakable — a wall of read months giving
 * way to unread ones — and the absolute counts, which do still matter, are one
 * hover away.
 *
 * A month the lane has no business with at all draws as an empty slot rather
 * than a full bar of nothing.
 */
function MonthColumn({ m }) {
  const total = monthTotal(m);
  const height = total > 0 ? 100 : 0;
  const title = [
    pretty(m.month),
    `${fmt(monthCorpusTotal(m))} documents`,
    ...LEGEND_BANDS.filter((b) => (m[b.key] ?? 0) > 0).map((b) => `${b.label}: ${fmt(m[b.key])}`),
  ].join("\n");
  return html`
    <div class="tl-col" title=${title}>
      <div class="tl-stack" style=${`height:${height}%;`}>
        ${CHART_BANDS.map((b) => {
          const v = m[b.key] ?? 0;
          if (v === 0) return null;
          return html`<div
            class="tl-seg"
            style=${`flex-grow:${v}; background:${b.color};`}
          ></div>`;
        })}
      </div>
    </div>
  `;
}

export function TimelineHero({ timeline, status, loading, error }) {
  if (error && !timeline) {
    return html`<section class="cognition-card">
      <div class="debug-card-label">History</div>
      <div class="debug-err" style="margin-top:6px;">${error}</div>
    </section>`;
  }
  if (!timeline) {
    return html`<section class="cognition-card">
      <div class="debug-card-label">History</div>
      <div class="debug-sub" style="margin-top:6px;">
        ${loading ? "Reading the shape of your corpus…" : "Not measured yet."}
      </div>
    </section>`;
  }
  const months = timeline.months ?? [];
  const totals = timelineTotals(months);
  const frontier = frontierMonth(months);
  return html`
    <section class="cognition-timeline">
      <div class="tl-head">
        <div>
          <div class="debug-card-label">History</div>
          <div class="tl-headline">
            ${frontier
              ? html`Read back to <strong>${pretty(frontier)}</strong>`
              : html`Nothing read yet`}
          </div>
        </div>
        <div class="tl-summary">
          ${fmt(totals.owed)} still to read
          ${totals.unscanned > 0 &&
          html`<span class="tl-caveat"> · ${fmt(totals.unscanned)} not looked at yet</span>`}
        </div>
      </div>

      <div class="tl-chart">
        ${months.map((m) => html`<${MonthColumn} m=${m} />`)}
      </div>
      <div class="tl-axis">
        <span>${months.length > 0 ? pretty(months[0].month) : ""}</span>
        <span class="tl-now">now →</span>
      </div>

      <div class="tl-legend">
        ${LEGEND_BANDS.map(
          (b) => html`<span class="tl-key" title=${b.hint}>
            <i style=${`background:${b.color};`}></i>${b.label}
            <span class="tl-key-n">${fmt(totals[b.key])}</span>
          </span>`,
        )}
      </div>
      ${status?.state === "unstarted" &&
      html`<p class="debug-sub" style="margin:10px 0 0;">
        This is what the Brain would work through. Nothing has been read yet.
      </p>`}
    </section>
  `;
}

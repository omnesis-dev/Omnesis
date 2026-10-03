// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The origin and kind pills that identify a time index entry wherever the
// portal lists one. Hover help is the native title, which never opens on
// modal focus.
import { html } from "htm/preact";
import { ORIGIN_LABELS, kindMeta } from "../lib/time-index-labels.js";

function OriginBadge({ origin }) {
  const meta = ORIGIN_LABELS[origin] ?? { row: origin, icon: "○", description: origin };
  return html`<span class=${`calendar-origin-pill calendar-origin-pill--${origin}`} title=${meta.description}>
    <span aria-hidden="true">${meta.icon}</span>${meta.row}
  </span>`;
}

function KindPill({ kind }) {
  const meta = kindMeta(kind);
  return html`<span
    class="calendar-kind"
    title=${meta.description}
    style=${`--calendar-kind:${meta.color}`}
  >
    <span aria-hidden="true">${meta.icon}</span>${meta.label}
  </span>`;
}

/** An entry's origin followed by its kind; an absent kind shows the origin alone. */
export function TimeIndexPills({ origin, kind, class: className = "" }) {
  return html`<span class=${`time-index-pills ${className}`.trim()}>
    <${OriginBadge} origin=${origin} />
    ${kind && html`<${KindPill} kind=${kind} />`}
  </span>`;
}

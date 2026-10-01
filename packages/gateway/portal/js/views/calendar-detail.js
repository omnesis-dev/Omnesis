// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { Modal } from "../components/modal.js";
import { DevAnnotateButton } from "../components/dev-annotate-button.js";
import { sourceIconUrl } from "../lib/format.js";
import {
  CALENDAR_KINDS,
  kindMeta,
  ORIGIN_LABELS,
  calendarDateLabel,
  evidenceDocumentIds,
} from "./calendar-model.js";

const PRECISION_LABELS = {
  instant: "Exact time",
  day: "Calendar day",
  month: "Month",
  year: "Year",
  range: "Date range",
};

export function evidenceSourceId(document) {
  return document?.sourceId ?? document?.source_id ?? document?.sourceType ?? null;
}

function EvidenceLink({ evidence }) {
  const doc = evidence.document;
  const icon = sourceIconUrl(evidenceSourceId(doc));
  return html`<a class="calendar-evidence" href=${`/portal/doc/${encodeURIComponent(evidence.id)}`}>
    ${icon
      ? html`<img class="source-icon" src=${icon} alt="" />`
      : html`<span class="calendar-evidence-fallback" aria-hidden="true">▤</span>`}
    <span>${doc?.title ?? "Open supporting document"}</span>
  </a>`;
}

function whyHere(entry, timeZone) {
  const date = calendarDateLabel(entry, timeZone);
  if (entry.origin === "mention") {
    return `This document contains a date expression resolved to ${date}. It may not describe an event or an obligation.`;
  }
  if (entry.origin === "annotation") {
    return `The agent recorded this interpretation for ${date}. Check the supporting information to understand its basis.`;
  }
  return `A structured date supplied by the source places this record on ${date}.`;
}

export function CalendarEntryDetail({
  entry,
  documents = {},
  timeZone = "UTC",
  developer = false,
  evidenceQuotes = [],
  evidenceLoading = false,
  evidenceError = null,
  relatedEntries = [],
  onOpenRelated,
  onClose,
}) {
  if (!entry) return null;
  const evidence = evidenceDocumentIds(entry).map((id) => ({
    id,
    document: documents[id] ?? null,
  }));
  const projection = entry.projection;
  const annotation = entry.annotation;
  const mention = entry.mention;
  const origin = ORIGIN_LABELS[entry.origin] ?? { row: entry.origin, heading: entry.origin };
  const kind = kindMeta(entry.kind);
  const sourceIcon = projection ? sourceIconUrl(projection.sourceId) : null;
  const sourceDocument = evidence.find((item) => item.document)?.document;
  const sourceName = sourceDocument?.sourceName ?? sourceDocument?.sourceType;
  return html`<${Modal} open=${true} onClose=${onClose} title=${entry.label} size="lg">
    <div class=${`calendar-detail calendar-detail--${entry.origin}`}>
      <section class="calendar-provenance">
        <strong>${origin.heading}</strong>
        <p>${whyHere(entry, timeZone)}</p>
        ${mention && html`<blockquote class="calendar-mentioned-quote">${mention.text}</blockquote>`}
        ${mention?.relative && html`<p class="debug-sub">This relative expression was resolved using the document's own date, rather than today's date.</p>`}
        ${
          projection &&
          html`<div>
            ${sourceIcon && html`<img class="source-icon" src=${sourceIcon} alt="" />`}
            <span>${sourceName ? `Recorded by ${sourceName}` : "Recorded by the source"}</span>
          </div>`
        }
        ${annotation && html`<p>${annotation.rationale ?? entry.label}</p>`}
      </section>
      <div class="calendar-detail-summary">
        <span class="calendar-kind" style=${`--calendar-kind:${kind.color}`}>
          <span aria-hidden="true">${kind.icon}</span>${kind.label}
        </span>
        <span>${
          entry.allDay || entry.origin === "mention"
            ? calendarDateLabel(entry, timeZone)
            : new Date(entry.start).toLocaleString([], { timeZone })
        }</span>
        <span>${PRECISION_LABELS[entry.precision] ?? entry.precision}</span>
        ${entry.allDay && html`<span>${entry.origin === "mention" ? "Date only" : "All day"}</span>`}
        <span>${entry.status}</span>
        ${
          developer &&
          entry.origin === "annotation" &&
          html`<${DevAnnotateButton}
            target=${{ targetType: "temporal_annotation", targetId: entry.id, label: entry.label }}
            developer=${true}
          />`
        }
      </div>
      <p class="debug-sub">Dates and times shown in ${timeZone}.${
        entry.status === "active"
          ? " Active is the stored status; it does not mean this is happening now or is confirmed."
          : ""
      }</p>
      ${annotation?.confidence != null && html`<p class="debug-sub">Agent confidence: ${Math.round(annotation.confidence * 100)}%</p>`}
      ${
        evidence.length > 0
          ? html`<section>
              <h3>
                ${entry.origin === "mention"
                  ? "Document containing this phrase"
                  : "Supporting documents"}
              </h3>
              <div class="calendar-evidence-list">
                ${evidence.map(
                  (item) =>
                    html`<div key=${item.id}>
                      <${EvidenceLink} evidence=${item} />
                      ${evidenceQuotes
                        .filter((quote) => quote.documentId === item.id && quote.quote)
                        .map(
                          (quote) =>
                            html`<blockquote class="calendar-evidence-quote">
                              ${quote.quote}
                            </blockquote>`,
                        )}
                    </div>`,
                )}
              </div>
              ${evidenceLoading &&
              html`<p class="debug-sub" role="status">Loading supporting passages…</p>`}
              ${evidenceError &&
              html`<p class="debug-sub" role="status">
                Supporting passages could not be loaded. You can still open the documents above.
              </p>`}
            </section>`
          : html`<p class="debug-sub">No supporting document is linked to this entry.</p>`
      }
      ${
        relatedEntries.length > 0 &&
        html`<section class="calendar-related-entries">
          <h3>Related entries</h3>
          <p class="debug-sub">
            Explicitly linked source records and agent interpretations. Entries stay separate.
          </p>
          ${relatedEntries.map(
            (related) =>
              html`<button
                type="button"
                key=${related.id}
                class="calendar-related-entry"
                onClick=${() => onOpenRelated?.(related)}
              >
                <strong>${related.label}</strong>
                <span
                  >${CALENDAR_KINDS[related.kind]?.label ?? related.kind} ·
                  ${ORIGIN_LABELS[related.origin]?.row ?? related.origin}</span
                >
              </button>`,
          )}
        </section>`
      }
      <details class="calendar-technical-details">
        <summary>Technical details</summary>
        <dl>
          <dt>Entry ID</dt><dd>${entry.id}</dd>
          <dt>Origin</dt><dd>${entry.origin}</dd>
          <dt>Start</dt><dd>${entry.start}</dd>
          <dt>End (exclusive)</dt><dd>${entry.endExclusive}</dd>
          ${
            projection &&
            html`
              <dt>Source ID</dt>
              <dd>${projection.sourceId}</dd>
              <dt>Projection slot</dt>
              <dd>${projection.slot}</dd>
              ${projection.tableName &&
              html`<dt>Analytics table</dt>
                <dd>${projection.tableName}</dd>`}
            `
          }
          ${
            annotation?.revision != null &&
            html`<dt>Revision</dt>
              <dd>${annotation.revision}</dd>`
          }
          ${evidence.map(
            (item) =>
              html`<dt>Document ID</dt>
                <dd>${item.id}</dd>`,
          )}
        </dl>
      </details>
    </div>
  </${Modal}>`;
}

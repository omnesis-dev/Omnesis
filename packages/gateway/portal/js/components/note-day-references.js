// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// References belong to the combined daily note document, not an individual
// capture. Keep this lookup independent of history pagination and poll while
// visible so transcription/indexing and later Brain work appear in place.
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getNotesProvenance } from "../api.js";
import { navigate } from "../lib/router.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";

const REFRESH_MS = 30_000;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function referenceDate(item) {
  const date = new Date(item.start);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString([], {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function ReferenceLink({ href, label }) {
  return html`<a
    class="note-reference-link"
    href=${href}
    onClick=${(event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(href);
    }}
  >
    ${label}
  </a>`;
}

function TimeReferences({ title, items }) {
  if (items.length === 0) return null;
  return items.map(
    (item) => html`<div class="note-reference-row" key=${item.id}>
      <span class="note-reference-heading">${title}</span>
      <${ReferenceLink}
        href=${`/portal/debug/calendar/${encodeURIComponent(item.id)}`}
        label=${item.label}
      />
      <span class="note-reference-detail">${referenceDate(item)}</span>
    </div>`,
  );
}

export function NoteDayReferences({ day, revision, experimental = false, onDocument }) {
  const [result, setResult] = useState({ data: null, error: null });
  const reloadRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    // An edited note changes the daily document's evidence. Hide its old
    // references until the gateway has checked the current document.
    setResult({ data: null, error: null });
    async function load() {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const data = await getNotesProvenance(day, TIME_ZONE);
        if (!cancelled) setResult({ data, error: null });
      } catch {
        if (!cancelled)
          setResult((current) => ({ ...current, error: "Couldn't load references." }));
      } finally {
        inFlight = false;
      }
    }
    reloadRef.current = load;
    load();
    return () => {
      cancelled = true;
    };
  }, [day, revision, experimental]);

  useVisiblePoll(() => reloadRef.current?.(), REFRESH_MS);

  useEffect(() => {
    onDocument?.(result.data?.documentId ?? null);
  }, [result.data?.documentId, onDocument]);

  const mentions = result.data?.mentions ?? [];
  const annotations = experimental ? (result.data?.annotations ?? []) : [];
  const loops = experimental ? (result.data?.loops ?? []) : [];
  const count = mentions.length + annotations.length + loops.length;
  const hasReferences = count > 0;
  const summary = result.error
    ? "Couldn't load references"
    : !result.data
      ? "Checking references…"
      : count === mentions.length && count > 0
        ? `${count} ${count === 1 ? "date" : "dates"} mentioned`
        : `${count} related ${count === 1 ? "item" : "items"}`;
  return html`<details class="note-day-references">
    <summary class="note-reference-summary">
      <span class="note-reference-chevron" aria-hidden="true">›</span>
      <span>Related to this day</span>
      <span class="note-reference-count">${summary}</span>
    </summary>
    <div class="note-reference-content">
    <${TimeReferences} title="Dates mentioned" items=${mentions} />
    <${TimeReferences} title="Related events" items=${annotations} />
    ${loops.map(
      (loop) => html`<div class="note-reference-row" key=${loop.id}>
        <span class="note-reference-heading">Open loops</span>
        <${ReferenceLink}
          href=${`/portal/debug/cognition/loops/${encodeURIComponent(loop.id)}`}
          label=${loop.title}
        />
        <span class="note-reference-detail">${loop.status}</span>
      </div>`,
    )}
    ${!result.data &&
    !result.error &&
    html`<p class="note-reference-intro">Checking references…</p>`}
    ${result.data &&
    !hasReferences &&
    !result.error &&
    html`<p class="note-reference-intro">
      No linked time index entries${experimental ? " or open loops" : ""} yet.
    </p>`}
    ${result.error &&
    html`<div class="note-reference-error" role="status">
      <span>${result.error}</span>
      <button type="button" class="btn-secondary" onClick=${() => reloadRef.current?.()}>
        Retry references
      </button>
    </div>`}
    </div>
  </details>`;
}

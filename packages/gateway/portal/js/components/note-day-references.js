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

function ReferenceLink({ href, label, detail }) {
  return html`<a
    class="note-reference-link"
    href=${href}
    onClick=${(event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(href);
    }}
  >
    <span>${label}</span>
    ${detail && html`<span class="note-reference-detail">${detail}</span>`}
  </a>`;
}

function TimeReferences({ title, items }) {
  if (items.length === 0) return null;
  return html`<div class="note-reference-group">
    <span class="note-reference-heading">${title}</span>
    <ul>
      ${items.map(
        (item) =>
          html`<li key=${item.id}>
            <${ReferenceLink}
              href=${`/portal/debug/calendar/${encodeURIComponent(item.id)}`}
              label=${item.label}
              detail=${referenceDate(item)}
            />
          </li>`,
      )}
    </ul>
  </div>`;
}

export function NoteDayReferences({ day, revision, experimental = false }) {
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

  const mentions = result.data?.mentions ?? [];
  const annotations = experimental ? (result.data?.annotations ?? []) : [];
  const loops = experimental ? (result.data?.loops ?? []) : [];
  const hasReferences = mentions.length + annotations.length + loops.length > 0;
  return html`<section class="note-day-references" aria-label=${`References for notes from ${day}`}>
    ${hasReferences &&
    html`<p class="note-reference-intro">Linked to this day's combined notes</p>`}
    <${TimeReferences} title="Time mentions" items=${mentions} />
    <${TimeReferences} title="Brain time annotations" items=${annotations} />
    ${loops.length > 0 &&
    html`<div class="note-reference-group">
      <span class="note-reference-heading">Open loops</span>
      <ul>
        ${loops.map(
          (loop) =>
            html`<li key=${loop.id}>
              <${ReferenceLink}
                href=${`/portal/debug/cognition/loops/${encodeURIComponent(loop.id)}`}
                label=${loop.title}
                detail=${loop.status}
              />
            </li>`,
        )}
      </ul>
    </div>`}
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
  </section>`;
}

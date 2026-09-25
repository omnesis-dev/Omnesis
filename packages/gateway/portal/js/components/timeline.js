// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared timeline renderer. Drives both:
 *   1. The document-detail page's "Omnesis graph" Timeline tab (events
 *      built directly from a DocumentGraph response via
 *      `buildTimeline`).
 *   2. The agent conversation's Citations ↔ Timeline side panel, fed
 *      from `event_trail.built` tool results in the transcript +
 *      annotations from `annotate` calls.
 *
 * The two consumers feed identical event shapes (see `TrailEvent` in
 * `@omnesis/core`); the only difference is the optional
 * `annotations` prop. When present, the renderer hangs each event's
 * quotes + notes off the matching row(s).
 *
 * Source-agnostic — only consumes the closed PersonRole / LinkType
 * enums plus the source registry helpers in `format.js`.
 */

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";
import {
  phraseForLinkType,
  groupPeopleByBucket,
} from "../lib/graph-timeline.js";
import { sourceIcon, sourceAccentColor } from "../lib/format.js";
import { FileTypeIcon } from "../lib/file-type-icons.js";

// Doc types that warrant a file-type icon (mirrors the rule in
// graph.js — files surfaced by a source or extracted attachments).
const FILE_LIKE_DOC_TYPES = new Set(["file", "attachment"]);
function isFileLike(doc) {
  return FILE_LIKE_DOC_TYPES.has(doc.documentType);
}

const DUP_LINK_TYPES = new Set(["duplicate-content", "same-resource", "near-duplicate"]);
export function isDuplicateLikeLinkType(linkType) {
  return DUP_LINK_TYPES.has(linkType);
}
const CONVERSATION_DOC_TYPES = new Set(["conversation"]);

/**
 * The sourceId that tints/icons an event row. A document (or deduped
 * doc+record) event carries `doc.sourceId`; a record-only event
 * (a bound DuckDB row with no co-described document) carries
 * `record.sourceId`. Both resolve through the same source-registry
 * helpers (`sourceIcon` / `sourceAccentColor`) — no per-source branch.
 */
export function eventSourceId(event) {
  return event?.doc?.sourceId ?? event?.record?.sourceId ?? null;
}

// Palette for chat-bubble author names — desaturated, high-visibility
// against dark backgrounds. Assigned in first-seen order.
const QUOTE_AUTHOR_COLORS = [
  '#7AAFCB', // soft blue
  '#C4A46C', // warm sand
  '#CB8A72', // muted coral
  '#8BB47A', // sage green
  '#A78BBF', // soft purple
  '#6BBFAE', // teal
  '#BF8BA7', // dusty rose
  '#A0A85C', // olive gold
];

/**
 * Build a Map<string, string> from author name → color by scanning all
 * quotes across every annotation bucket. Colors are assigned in first-seen
 * order from QUOTE_AUTHOR_COLORS, wrapping if there are more than 8 authors.
 */
function buildAuthorColorMap(annotations) {
  const map = new Map();
  if (!annotations) return map;
  let idx = 0;
  function scan(bucket) {
    if (!bucket) return;
    for (const slot of Object.values(bucket)) {
      for (const q of slot.quotes ?? []) {
        if (q.quoteAuthor && !map.has(q.quoteAuthor)) {
          map.set(q.quoteAuthor, QUOTE_AUTHOR_COLORS[idx % QUOTE_AUTHOR_COLORS.length]);
          idx++;
        }
      }
    }
  }
  scan(annotations.byDoc);
  return map;
}

/**
 * Top-level timeline view. Renders a vertical list of events with a
 * spine + day headers. Accepts an optional `annotations` prop:
 *
 *   {
 *     byDoc: { [docId]: { note?, quotes: [{quote, note?}] } },
 *   }
 *
 * `byDoc` may be undefined for the no-annotations case (e.g. the
 * document-detail Timeline tab). When provided, the renderer projects
 * annotations onto every matching row.
 *
 * `visibleDocIds` (optional `Set<string>` of doc ids) restricts the
 * "related" line list under each event row to entries whose target
 * documentId is in the set AND whose direction is outbound (or peer
 * for symmetric edges). The agent's Timeline passes the set of doc
 * ids it actually rendered (top-level events + attachments) so the
 * only relations a user sees on a row are *outbound* pointers to
 * OTHER rows already on the same Timeline — i.e. "this doc cites
 * that one". The reverse "cited by" relation is suppressed: it's
 * always inferable from the citing doc's outbound line, and
 * surfacing both sides reads as duplicate chrome (each pairing
 * shows up twice). Pass `undefined` (the default) to disable the
 * filter and show every relation in every direction; the
 * document-detail Timeline tab uses that mode.
 *
 * `hideRelations` (default false) overrides the filter and hides
 * the entire related section. Kept for old call sites that haven't
 * migrated to `visibleDocIds`.
 */
export function TimelineColumn({ events, annotations, hideRelations, visibleDocIds }) {
  if (!events || events.length === 0) {
    return html`
      <aside class="graph-debug-timeline">
        <div class="graph-debug-timeline-head">Timeline</div>
        <div class="graph-debug-timeline-empty">No timestamped events.</div>
      </aside>
    `;
  }
  const authorColorMap = buildAuthorColorMap(annotations);
  const dayGroups = [];
  for (const ev of events) {
    const key = dayKey(ev.at);
    const last = dayGroups[dayGroups.length - 1];
    if (last && last.key === key) {
      last.events.push(ev);
    } else {
      dayGroups.push({ key, date: ev.at, events: [ev] });
    }
  }
  return html`
    <aside class="graph-debug-timeline">
      <div class="graph-debug-timeline-head">
        Timeline · <span class="graph-debug-timeline-count">${events.length} events</span>
      </div>
      <ol class="graph-debug-timeline-list">
        ${(() => {
          // Flatten into a single row list so we can compute each
          // row's `next-accent` (the source colour of the row
          // immediately below it). Powers the 20px gradient between
          // rows when the source changes.
          const rows = [];
          for (const g of dayGroups) {
            const headerAccent =
              sourceAccentColor(eventSourceId(g.events[0])) ?? "var(--border-light)";
            rows.push({ kind: "header", date: g.date, accent: headerAccent });
            for (const ev of g.events) {
              const accent = sourceAccentColor(eventSourceId(ev)) ?? "var(--border-light)";
              rows.push({ kind: "event", event: ev, accent });
            }
          }
          for (let i = 0; i < rows.length; i++) {
            rows[i].nextAccent = i + 1 < rows.length ? rows[i + 1].accent : rows[i].accent;
          }
          return rows.map((r, i) =>
            r.kind === "header"
              ? html`<${DateHeaderRow}
                  key=${`hdr-${r.date}-${i}`}
                  date=${r.date}
                  accent=${r.accent}
                  nextAccent=${r.nextAccent}
                />`
              : html`<${TimelineBundle}
                  key=${r.event.eventId ?? r.event.doc?.documentId ?? r.event.record?.recordKey ?? `b-${i}`}
                  event=${r.event}
                  nextAccent=${r.nextAccent}
                  annotations=${annotations}
                  hideRelations=${hideRelations}
                  visibleDocIds=${visibleDocIds}
                  authorColorMap=${authorColorMap}
                />`,
          );
        })()}
      </ol>
    </aside>
  `;
}

function dayKey(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

function DateHeaderRow({ date, accent, nextAccent }) {
  return html`
    <li
      class="graph-debug-date-header"
      style=${`--event-accent: ${accent}; --next-accent: ${nextAccent ?? accent};`}
    >
      <div class="graph-debug-date-header-marker"></div>
      <div class="graph-debug-date-header-label">${formatDateHeader(date)}</div>
    </li>
  `;
}

function formatDateHeader(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const day = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${weekday} · ${day}`;
}

/**
 * One timeline row = one event + its nested attachments. 3-column
 * grid: date / spine / content. When `annotations.byDoc[docId]` is set,
 * its quotes + note hang off the matching parent doc row or
 * attachment row.
 */
function TimelineBundle({ event, nextAccent, annotations, hideRelations, visibleDocIds, authorColorMap }) {
  const attachments = event.attachments ?? [];
  const containsSeed =
    event.kind === "seed" || attachments.some((a) => a.kind === "seed");
  const accent = sourceAccentColor(eventSourceId(event)) ?? "var(--border-light)";
  const classes = ["graph-debug-event", event.kind, containsSeed ? "contains-seed" : ""]
    .filter(Boolean)
    .join(" ");
  return html`
    <li
      class=${classes}
      style=${`--event-accent: ${accent}; --next-accent: ${nextAccent ?? accent};`}
    >
      <div class="graph-debug-event-marker">
        <span class="graph-debug-event-dot">
          <span class="graph-debug-event-dot-icon">
            ${sourceIcon(eventSourceId(event), { size: 11 })}
          </span>
        </span>
      </div>
      <div class="graph-debug-event-content">
        <${EventBody}
          event=${event}
          isAttachment=${false}
          annotations=${annotations}
          hideRelations=${hideRelations}
          visibleDocIds=${visibleDocIds}
          authorColorMap=${authorColorMap}
        />
        ${attachments.map(
          (a) => html`
            <div
              class=${`graph-debug-event-child ${a.kind}`}
              key=${a.doc.documentId}
            >
              <${EventBody}
                event=${a}
                isAttachment=${true}
                annotations=${annotations}
                hideRelations=${hideRelations}
                visibleDocIds=${visibleDocIds}
                authorColorMap=${authorColorMap}
              />
            </div>
          `,
        )}
      </div>
    </li>
  `;
}

/**
 * Title row + people row + related + annotations for ONE event (top-
 * level or nested attachment). `isAttachment` switches in the
 * paperclip prefix + tighter filename formatting.
 */
function EventBody({ event, isAttachment, annotations, hideRelations, visibleDocIds, authorColorMap }) {
  // A record-only event (a bound DuckDB row with no co-described
  // document) has no `doc` to head the row — render the record body
  // instead. Records never nest as attachments, so this only fires at
  // top level.
  if (!event.doc) {
    return html`<${RecordBody} record=${event.record} time=${event.at} />`;
  }
  const { doc, people } = event;
  // Filter pipeline: `hideRelations` is the hard off-switch (kept for
  // legacy callers); `visibleDocIds`, when provided, restricts to
  // relations whose target documentId is in the set — i.e. relations
  // that point at another row already on screen. When neither is set
  // every relation surfaces (the document-detail Timeline tab's mode).
  let related = hideRelations ? [] : (event.related ?? []);
  if (visibleDocIds && !hideRelations) {
    related = related.filter(
      (r) => visibleDocIds.has(r.documentId) && r.direction !== "in",
    );
  }
  const buckets = groupPeopleByBucket(people);
  const showFileIcon = isAttachment || isFileLike(doc);

  const docAnnotations = annotations?.byDoc?.[doc.documentId] ?? null;

  return html`
    <div class="graph-debug-event-title">
      ${isAttachment ? html`<${PaperclipIcon} />` : null}
      ${showFileIcon
        ? html`<${FileTypeIcon} mimeType=${doc.mimeType} filename=${doc.title} size=${14} />`
        : null}
      ${/* See #31 — opens by documentId only; a destructive resync re-mints the id and this 404s (url fallback can't help url-less sources). */ ""}
      <a
        class="graph-debug-event-doc"
        href=${`/portal/doc/${encodeURIComponent(doc.documentId)}`}
        onClick=${navHref(`/portal/doc/${encodeURIComponent(doc.documentId)}`)}
        title=${doc.title || doc.documentId}
      >
        ${showFileIcon
          ? truncateFilename(doc.title || "(untitled)", 38)
          : truncate(doc.title || "(untitled)", 90)}
      </a>
    </div>
    ${!isAttachment
      ? html`
          <div class="graph-debug-event-people">
            ${formatTime(event.at)
              ? html`<span class="graph-debug-event-time">${formatTime(event.at)}</span>`
              : null}
            ${buckets.map(
              (b, bi) => html`
                <span class="graph-debug-event-people-group" data-bucket=${b.bucket}>
                  ${bi > 0 || formatTime(event.at) ? html`<span class="graph-debug-event-people-sep"> · </span>` : null}
                  <span class="graph-debug-event-bucket">${b.bucket}</span>${" "}
                  <${PeopleList} people=${b.people} />
                </span>
              `,
            )}
          </div>
        `
      : buckets.length > 0
        ? html`
            <div class="graph-debug-event-people">
              ${buckets.map(
                (b, bi) => html`
                  <span class="graph-debug-event-people-group" data-bucket=${b.bucket}>
                    ${bi > 0 ? html`<span class="graph-debug-event-people-sep"> · </span>` : null}
                    <span class="graph-debug-event-bucket">${b.bucket}</span>${" "}
                    <${PeopleList} people=${b.people} />
                  </span>
                `,
              )}
            </div>
          `
        : null}
    ${related.length > 0
      ? html`
          <ul class="graph-debug-event-related">
            ${related.map(
              (r) => html`
                <li class=${isDuplicateLikeLinkType(r.linkType) ? "dup-relation" : ""}>
                  ${isDuplicateLikeLinkType(r.linkType) ? html`<${LinkIcon} />` : null}
                  <span class="graph-debug-event-bucket">${phraseForLinkType(r.linkType, r.direction)}</span>${" "}
                  <span class="graph-debug-event-related-icon">${sourceIcon(r.sourceId, { size: 11 })}</span>
                  <a
                    class="graph-debug-event-doc"
                    href=${`/portal/doc/${encodeURIComponent(r.documentId)}`}
                    onClick=${navHref(`/portal/doc/${encodeURIComponent(r.documentId)}`)}
                    title=${r.title || r.documentId}
                  >
                    ${truncateFilename(r.title || "(untitled)", 38)}
                  </a>
                </li>
              `,
            )}
          </ul>
        `
      : null}
    ${/* A document that deduped with its same-entity DuckDB row (one
         timeline entity, not two) carries the row's derived key fields
         inline on the doc card. The record's title is already the doc
         title — only the declared key columns add information. */ ""}
    ${event.record && !isAttachment
      ? html`<${RecordKeyFields} keyFields=${event.record.keyFields} />`
      : null}
    ${docAnnotations ? html`<${DocAnnotationBlock} annotations=${docAnnotations} isConversation=${CONVERSATION_DOC_TYPES.has(doc.documentType)} authorColorMap=${authorColorMap} />` : null}
  `;
}

/**
 * Render a record-only trail event: a single DuckDB analytics
 * row surfaced as a point-in-time citation that binds no document. The
 * source icon/colour come from the registry keyed by `record.sourceId`
 * (resolved one level up via `eventSourceId`); the title and key fields
 * are derived gateway-side from the table's declared record-display
 * contract, so this renderer never learns a column name or branches on
 * a source.
 *
 * When `record.boundDocumentId` is non-null the title links through to
 * that document (and onward to the source app via the doc-detail "Open
 * in source"); when null it renders as plain text — no dead link.
 */
function RecordBody({ record, time }) {
  if (!record) return null;
  const title = record.title || record.tableDisplayName || "(record)";
  const titleNode = record.boundDocumentId
    ? html`<a
        class="graph-debug-event-doc"
        href=${`/portal/doc/${encodeURIComponent(record.boundDocumentId)}`}
        onClick=${navHref(`/portal/doc/${encodeURIComponent(record.boundDocumentId)}`)}
        title=${title}
        >${truncate(title, 90)}</a
      >`
    : html`<span class="graph-debug-event-doc graph-debug-event-record-title" title=${title}
        >${truncate(title, 90)}</span
      >`;
  return html`
    <div class="graph-debug-event-title">
      <${DatabaseIcon} />
      ${titleNode}
    </div>
    <div class="graph-debug-event-people">
      ${formatTime(time) ? html`<span class="graph-debug-event-time">${formatTime(time)}</span>` : null}
      ${record.tableDisplayName
        ? html`
            ${formatTime(time) ? html`<span class="graph-debug-event-people-sep"> · </span>` : null}
            <span class="graph-debug-event-bucket">${record.tableDisplayName}</span>
          `
        : null}
    </div>
    <${RecordKeyFields} keyFields=${record.keyFields} />
  `;
}

/**
 * The declared key columns of a record citation, rendered as a
 * label/value list. The gateway already redacted `sensitive` columns
 * server-side (the value arrives as the redaction placeholder), so this
 * renderer prints values verbatim and re-exposes nothing. A null value
 * shows an em-dash.
 */
function RecordKeyFields({ keyFields }) {
  if (!keyFields || keyFields.length === 0) return null;
  return html`
    <dl class="graph-debug-event-record-fields">
      ${keyFields.map(
        (f, i) => html`
          <div class="graph-debug-event-record-field" key=${i}>
            <dt>${f.label}</dt>
            <dd>${f.value === null ? "—" : String(f.value)}</dd>
          </div>
        `,
      )}
    </dl>
  `;
}

/**
 * Render the quote/note set for one doc. `annotations` carries an
 * optional `note` plus a `quotes[]` array of `{quote, note?}`.
 */
function DocAnnotationBlock({ annotations, isConversation, authorColorMap }) {
  if (!annotations) return null;
  const { note, quotes } = annotations;
  if (!note && (!quotes || quotes.length === 0)) return null;
  return html`
    <div class="graph-debug-event-annotation graph-debug-event-annotation-doc">
      ${note ? html`<div class="graph-debug-event-annotation-note"><${AstroidIcon} />${note}</div>` : null}
      ${quotes && quotes.length > 0
        ? quotes.map(
            (q, i) =>
              isConversation
                ? html`
                    <div class=${`graph-debug-event-annotation-quote graph-debug-chat-bubble${q.quoteIsSelf ? " self" : ""}`} key=${i}>
                      <div class="graph-debug-chat-bubble-body">
                        <div class="graph-debug-chat-bubble-content">
                          ${q.quoteAuthor
                            ? html`<div class="graph-debug-chat-bubble-author" style=${`color: ${authorColorMap?.get(q.quoteAuthor) ?? QUOTE_AUTHOR_COLORS[0]}`}>${q.quoteAuthor}</div>`
                            : null}
                          ${q.quote}
                        </div>
                      </div>
                      ${q.note
                        ? html`<div class="graph-debug-event-annotation-quote-note"><${AstroidIcon} />${q.note}</div>`
                        : null}
                    </div>
                  `
                : html`
                    <div class="graph-debug-event-annotation-quote" key=${i}>
                      <blockquote>${q.quote}${q.quoteAuthor ? html`<br/>\u2014 ${q.quoteAuthor}` : ''}</blockquote>
                      ${q.note
                        ? html`<div class="graph-debug-event-annotation-quote-note"><${AstroidIcon} />${q.note}</div>`
                        : null}
                    </div>
                  `,
          )
        : null}
    </div>
  `;
}

// ─── Inline glyphs ────────────────────────────────────────────────────

const PAPERCLIP_PATH =
  "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551";
function PaperclipIcon() {
  return html`<svg
    class="graph-debug-paperclip"
    xmlns="http://www.w3.org/2000/svg"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  ><path d=${PAPERCLIP_PATH} /></svg>`;
}

// A row/record glyph for record citations — a stacked-cylinder
// database mark, distinguishing a structured DuckDB row from a document.
const DATABASE_PATHS = [
  "M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0",
  "M3 5v14a9 3 0 0 0 18 0V5",
  "M3 12a9 3 0 0 0 18 0",
];
function DatabaseIcon() {
  return html`<svg
    class="graph-debug-record-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >${DATABASE_PATHS.map((d) => html`<path d=${d} />`)}</svg>`;
}

const LINK_PATHS = [
  "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
  "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
];

const ASTROID_PATH =
  "M12.983 21.186a1 1 0 0 1-1.966 0 10 10 0 0 0-8.203-8.203 1 1 0 0 1 0-1.966 10 10 0 0 0 8.203-8.203 1 1 0 0 1 1.966 0 10 10 0 0 0 8.203 8.203 1 1 0 0 1 0 1.966 10 10 0 0 0-8.203 8.203";
function AstroidIcon() {
  return html`<svg
    class="graph-debug-astroid-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  ><path d=${ASTROID_PATH} /></svg>`;
}
function LinkIcon() {
  return html`<svg
    class="graph-debug-link-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >${LINK_PATHS.map((d) => html`<path d=${d} />`)}</svg>`;
}

// ─── People list ─────────────────────────────────────────────────────

const PEOPLE_LIST_HEAD = 2;
function PeopleList({ people }) {
  if (!people || people.length === 0) return null;
  if (people.length <= PEOPLE_LIST_HEAD) {
    return html`${people.map(
      (p, i) => html`<${PersonRef} key=${p.personId} person=${p} comma=${i < people.length - 1} />`,
    )}`;
  }
  const shown = people.slice(0, PEOPLE_LIST_HEAD);
  const hidden = people.slice(PEOPLE_LIST_HEAD);
  return html`
    ${shown.map((p) => html`<${PersonRef} key=${p.personId} person=${p} comma=${true} />`)}
    <span class="graph-debug-people-overflow" tabindex="0">
      +${hidden.length} more
      <span class="graph-debug-people-overflow-popover" role="tooltip">
        ${hidden.map(
          (p) => html`
            <div class="graph-debug-people-overflow-row" key=${p.personId}>
              <${PersonRef} person=${p} comma=${false} />
            </div>
          `,
        )}
      </span>
    </span>
  `;
}

function PersonRef({ person, comma }) {
  const href = `/portal/people/${encodeURIComponent(person.personId)}`;
  return html`
    <a
      class=${`graph-debug-event-person${person.isSelf ? " self" : ""}`}
      href=${href}
      onClick=${navHref(href)}
      title=${person.name}
    >${person.name}</a>${comma ? ", " : ""}
  `;
}

// ─── Text helpers ────────────────────────────────────────────────────

function navHref(href) {
  return (e) => {
    e.preventDefault();
    navigate(href);
  };
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

/**
 * Middle-truncate a filename to keep both the start (recognisable
 * prefix) and the extension visible. UUID-y or hash-laden names
 * become readable without losing the type info.
 */
function truncateFilename(name, max = 36) {
  if (!name) return "";
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || name.length - dot > 8) return truncate(name, max);
  const ext = name.slice(dot);
  const base = name.slice(0, dot);
  const room = max - ext.length - 1;
  if (room <= 4) return truncate(name, max);
  const head = Math.max(8, Math.floor(room * 0.75));
  const tail = Math.max(2, room - head);
  return base.slice(0, head) + "…" + base.slice(-tail) + ext;
}

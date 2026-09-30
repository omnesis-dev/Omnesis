// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Debug page's Calendar: a read-only view of the time index through the
// gateway's unified temporal query. Source projections, date mentions from
// document text and — when the Brain runs — its annotations share one
// calendar, while each row and detail panel says where it came from.

import { html } from "htm/preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { getCalendarAnnotation, getCalendarWindow, getDocumentSummariesBulk } from "../api.js";
import { Modal } from "../components/modal.js";
import { DevAnnotateButton } from "../components/dev-annotate-button.js";
import { sourceIconUrl } from "../lib/format.js";
import { navigate, replaceRoute } from "../lib/router.js";

const DAY_MS = 86_400_000;
const PAGE_LIMIT = 100;
/**
 * Pages read for one view. Date mentions make the index corpus-sized, so a
 * wide view over a large mailbox stops here and says so instead of paging on.
 */
const MAX_PAGES = 20;
/** Every origin the index holds; the gateway reads mentions only when asked. */
const ORIGINS = "projection,annotation,mention";

/** How each origin is labelled on a row and headed in its detail. */
export const ORIGIN_LABELS = {
  projection: { row: "▱ Source", heading: "Source fact" },
  mention: { row: "❝ Mention", heading: "Date written in a document" },
  annotation: { row: "✦ Agent", heading: "Agent note" },
};
const UPCOMING_DAYS = 399;
const DATE_FORMATTERS = new Map();
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const CALENDAR_KINDS = {
  visit: { label: "Visit", icon: "●", color: "#38bdf8" },
  calendar_event: { label: "Calendar", icon: "▣", color: "#60a5fa" },
  event: { label: "Event", icon: "◆", color: "#818cf8" },
  deadline: { label: "Deadline", icon: "⚑", color: "#f87171", moment: true },
  reminder: { label: "Reminder", icon: "●", color: "#fbbf24", moment: true },
  expiry: { label: "Expires", icon: "⌛", color: "#fb923c", moment: true },
  appointment: { label: "Appointment", icon: "◉", color: "#34d399" },
  episode: { label: "Logged", icon: "↺", color: "#a78bfa" },
  episodic: { label: "Logged", icon: "↺", color: "#a78bfa" },
};

const MOMENT_KINDS = new Set(
  Object.keys(CALENDAR_KINDS).filter((kind) => CALENDAR_KINDS[kind].moment),
);
const UPCOMING_KINDS = [...MOMENT_KINDS];

const ZOOMS = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "day", label: "Day" },
  { value: "upcoming", label: "Upcoming" },
];

function pad(value) {
  return String(value).padStart(2, "0");
}

export function localDayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateFromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDayKey(date) === key ? date : null;
}

function addDays(date, amount) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function startOfWeek(date) {
  const mondayOffset = (date.getDay() + 6) % 7;
  return addDays(date, -mondayOffset);
}

export function visibleCalendarDays(zoom, anchor) {
  if (zoom === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  if (zoom === "week") {
    const start = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

function entryStartMs(entry) {
  return Date.parse(entry.start);
}

function entryEndMs(entry) {
  return Date.parse(entry.endExclusive) - 1;
}

export function dayKeyInTimeZone(value, timeZone) {
  let formatter = DATE_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    DATE_FORMATTERS.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isMomentWindow(entry) {
  return entry.precision === "range"
    && MOMENT_KINDS.has(entry.kind)
    && entryEndMs(entry) - entryStartMs(entry) >= DAY_MS;
}

/**
 * Spanning entries shown above the days before the rest fold away: months and
 * long spans are many on a busy mailbox, and must not push the days out of view.
 */
const BANNER_PREVIEW = 4;

/** A mention span longer than this sits in the banner row, not on each of its days. */
const MENTION_BANNER_SPAN_MS = 7 * DAY_MS;

export function isSemanticBanner(entry) {
  const span = entryEndMs(entry) - entryStartMs(entry);
  return entry.precision === "month"
    || entry.precision === "year"
    || (entry.precision === "range" && !isMomentWindow(entry) && span > 35 * DAY_MS)
    // A billing period or a statement's span names its days only at its
    // ends; repeating it on every day between would bury the days' own entries.
    || (entry.origin === "mention" && entry.precision === "range" && span > MENTION_BANNER_SPAN_MS);
}

/**
 * The entries to show together: a document that writes the same day in
 * several phrases ("Tue 29 Sep 10am–10:30am", "Tuesday 29 Sep") appears once,
 * under its first mention. `dayOf` keeps one per document per day, for a list
 * that runs across days.
 */
export function oneMentionPerDocument(entries, dayOf = null) {
  const seen = new Set();
  return entries.filter((entry) => {
    const documentId = entry.origin === "mention" ? entry.mention?.documentId : null;
    if (!documentId) return true;
    const key = dayOf ? `${documentId} ${dayOf(entry)}` : documentId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function overlapsVisibleDays(entry, visibleKeys, timeZone) {
  if (!visibleKeys || visibleKeys.size === 0) return false;
  const sorted = [...visibleKeys].sort();
  const start = dayKeyInTimeZone(entryStartMs(entry), timeZone);
  const end = dayKeyInTimeZone(entryEndMs(entry), timeZone);
  return end >= sorted[0] && start <= sorted.at(-1);
}

export function entryDayKeys(entry, visibleKeys = null, timeZone = "UTC") {
  const startMs = entryStartMs(entry);
  const endMs = entryEndMs(entry);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  if (isMomentWindow(entry)) return [dayKeyInTimeZone(endMs, timeZone)];
  if (entry.precision === "instant" || (!entry.allDay && endMs - startMs < DAY_MS)) {
    return [dayKeyInTimeZone(startMs, timeZone)];
  }
  if (isSemanticBanner(entry)) return [];
  let cursor = dateFromKey(dayKeyInTimeZone(startMs, timeZone));
  const last = dateFromKey(dayKeyInTimeZone(endMs, timeZone));
  const keys = [];
  while (cursor <= last) {
    const key = localDayKey(cursor);
    if (!visibleKeys || visibleKeys.has(key)) keys.push(key);
    cursor = addDays(cursor, 1);
  }
  return keys;
}

export function evidenceDocumentIds(entry) {
  const ids = entry.origin === "projection"
    ? [entry.projection?.documentId]
    : entry.origin === "mention"
      ? [entry.mention?.documentId]
      : (entry.annotation?.documentIds ?? []);
  return [...new Set(ids.filter(Boolean))];
}

function evidenceFor(entry, documents) {
  return evidenceDocumentIds(entry).map((id) => ({ id, document: documents[id] ?? null }));
}

export async function fetchCalendarPages(
  query,
  { fetchPage = getCalendarWindow, maxPages = MAX_PAGES } = {},
) {
  const byId = new Map();
  const seen = new Set();
  let cursor;
  let nowMs = Date.now();
  let coverage = null;
  let capped = false;
  for (let pages = 0; ; pages += 1) {
    if (pages === maxPages) {
      capped = true;
      break;
    }
    const page = await fetchPage({
      ...query,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items ?? []) byId.set(item.id, item);
    nowMs = page.nowMs ?? nowMs;
    coverage ??= page.coverage ?? null;
    const next = page.nextCursor;
    if (!next) break;
    if (seen.has(next)) throw new Error("Calendar pagination returned a cursor cycle");
    seen.add(next);
    cursor = next;
  }
  const items = [...byId.values()];
  return { items, documents: {}, nowMs, timeZone: query.timeZone, coverage, capped };
}

export async function fetchCalendarEvidence(
  items,
  { fetchDocuments = getDocumentSummariesBulk } = {},
) {
  const ids = [...new Set(items.flatMap(evidenceDocumentIds))];
  if (ids.length === 0) return {};
  return (await fetchDocuments(ids)).docs ?? {};
}

function queryFor(zoom, anchor) {
  const timeZone = LOCAL_TIME_ZONE;
  if (zoom === "upcoming") {
    const now = Date.now();
    return {
      from: now - DAY_MS,
      to: now + UPCOMING_DAYS * DAY_MS,
      timeZone,
      kinds: UPCOMING_KINDS.join(","),
      statuses: "active,completed",
      origins: ORIGINS,
    };
  }
  const days = visibleCalendarDays(zoom, anchor);
  return {
    from: addDays(days[0], -1).getTime(),
    to: addDays(days.at(-1), 2).getTime() - 1,
    timeZone,
    statuses: "active,completed",
    origins: ORIGINS,
  };
}

function kindMeta(kind) {
  return CALENDAR_KINDS[kind] ?? {
    label: kind || "Unclassified",
    icon: "○",
    color: "#94a3b8",
  };
}

function formatTime(entry, timeZone) {
  if (entry.allDay) return null;
  const start = new Date(entry.start);
  const end = new Date(entry.endExclusive);
  const options = { timeZone, hour: "numeric", minute: "2-digit" };
  if (entry.precision === "instant") return start.toLocaleTimeString([], options);
  return `${start.toLocaleTimeString([], options)}–${end.toLocaleTimeString([], options)}`;
}

export function calendarDateLabel(entry, timeZone) {
  const start = dayKeyInTimeZone(entryStartMs(entry), timeZone);
  const end = dayKeyInTimeZone(entryEndMs(entry), timeZone);
  return entry.precision === "range" && start !== end ? `${start} – ${end}` : start;
}

function periodTitle(zoom, anchor, days) {
  if (zoom === "month") return anchor.toLocaleDateString([], { month: "long", year: "numeric" });
  if (zoom === "day") return anchor.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (zoom === "upcoming") return "Deadlines, expiries and reminders";
  const first = days[0];
  const last = days.at(-1);
  const left = first.toLocaleDateString([], { day: "numeric", month: "short" });
  const right = last.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return `${left} – ${right}`;
}

function originLabel(origin) {
  return ORIGIN_LABELS[origin] ?? { row: origin, heading: origin };
}

function KindPill({ kind }) {
  const meta = kindMeta(kind);
  return html`<span class="calendar-kind" style=${`--calendar-kind:${meta.color}`}>
    <span aria-hidden="true">${meta.icon}</span>${meta.label}
  </span>`;
}

export function CalendarEntryRow({
  entry,
  documents = {},
  showDate = false,
  timeZone = "UTC",
  onOpen,
}) {
  const meta = kindMeta(entry.kind);
  const evidence = evidenceFor(entry, documents);
  const date = isMomentWindow(entry)
    ? entryDayKeys(entry, null, timeZone)[0]
    : dayKeyInTimeZone(entryStartMs(entry), timeZone);
  return html`<button
    type="button"
    class=${`calendar-entry${MOMENT_KINDS.has(entry.kind) ? " actionable" : ""}`}
    style=${`--calendar-kind:${meta.color}`}
    onClick=${() => onOpen?.(entry)}
  >
    <span class="calendar-entry-spine"></span>
    <span class="calendar-entry-body">
      <span class="calendar-entry-title">${entry.label}</span>
      <span class="calendar-entry-meta">
        ${showDate && html`<span>${date}</span>`}
        ${formatTime(entry, timeZone) && html`<span>${formatTime(entry, timeZone)}</span>`}
        <${KindPill} kind=${entry.kind} />
        <span class="calendar-origin">${originLabel(entry.origin).row}</span>
        ${evidence.length > 0 && html`<span>▤ ${evidence.length}</span>`}
      </span>
    </span>
  </button>`;
}

function DaySection({ day, entries, documents, timeZone, today, onOpen }) {
  const key = localDayKey(day);
  return html`<section class=${`calendar-day${key === today ? " today" : ""}`}>
    <header>
      <span class="calendar-day-number">${day.getDate()}</span>
      <span>${day.toLocaleDateString([], { weekday: "short", month: "short" })}</span>
      ${key === today && html`<span class="calendar-today-label">Today</span>`}
    </header>
    <div class="calendar-day-entries">
      ${entries.length === 0
        ? html`<span class="calendar-day-empty">Nothing filed for this day.</span>`
        : entries.map((entry) => html`<${CalendarEntryRow}
            key=${entry.id}
            entry=${entry}
            documents=${documents}
            timeZone=${timeZone}
            onOpen=${onOpen}
          />`)}
    </div>
  </section>`;
}

function MonthGrid({ days, anchor, byDay, selectedDay, onSelectDay }) {
  return html`<div class="calendar-month-wrap">
    <div class="calendar-weekdays">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => html`<span>${day}</span>`)}
    </div>
    <div class="calendar-month-grid">
      ${days.map((day) => {
        const key = localDayKey(day);
        const entries = byDay.get(key) ?? [];
        return html`<button
          type="button"
          class=${`calendar-month-day${day.getMonth() !== anchor.getMonth() ? " outside" : ""}${key === selectedDay ? " selected" : ""}${key === localDayKey(new Date()) ? " today" : ""}`}
          onClick=${() => onSelectDay(key)}
          aria-label=${`${day.toLocaleDateString()}, ${entries.length} entries`}
        >
          <span class="calendar-month-number">${day.getDate()}</span>
          <span class="calendar-month-marks">
            ${entries.slice(0, 3).map((entry) => {
              const meta = kindMeta(entry.kind);
              return html`<span style=${`--calendar-kind:${meta.color}`}></span>`;
            })}
            ${entries.length > 3 && html`<small>+${entries.length - 3}</small>`}
          </span>
        </button>`;
      })}
    </div>
  </div>`;
}

function EvidenceLink({ evidence }) {
  const doc = evidence.document;
  const sourceId = evidenceSourceId(doc);
  const icon = sourceIconUrl(sourceId);
  return html`<a class="calendar-evidence" href=${`/portal/doc/${encodeURIComponent(evidence.id)}`}>
    ${icon
      ? html`<img class="source-icon" src=${icon} alt="" />`
      : html`<span class="calendar-evidence-fallback" aria-hidden="true">▤</span>`}
    <span>${doc?.title ?? evidence.id}</span>
  </a>`;
}

export function evidenceSourceId(document) {
  return document?.sourceId ?? document?.source_id ?? document?.sourceType ?? null;
}

export function CalendarEntryDetail({ entry, documents, timeZone = "UTC", developer = false, onClose }) {
  if (!entry) return null;
  const evidence = evidenceFor(entry, documents);
  const projection = entry.projection;
  const annotation = entry.annotation;
  const mention = entry.mention;
  const sourceIcon = projection ? sourceIconUrl(projection.sourceId) : null;
  return html`<${Modal} open=${true} onClose=${onClose} title=${entry.label} size="lg">
    <div class="calendar-detail">
      <div class="calendar-detail-summary">
        <${KindPill} kind=${entry.kind} />
        <span>${entry.allDay
          ? calendarDateLabel(entry, timeZone)
          : new Date(entry.start).toLocaleString([], { timeZone })}</span>
        <span>${entry.status}</span>
        ${developer && entry.origin === "annotation" && html`<${DevAnnotateButton}
          target=${{
            targetType: "temporal_annotation",
            targetId: entry.id,
            label: entry.label,
          }}
          developer=${true}
        />`}
      </div>
      <section class="calendar-provenance">
        <strong>${originLabel(entry.origin).heading}</strong>
        ${projection && html`<div>
          ${sourceIcon && html`<img class="source-icon" src=${sourceIcon} alt="" />`}
          <span>Recorded by ${projection.sourceId}</span>
          <span class="debug-sub">${projection.tableName ? `${projection.tableName} · ` : ""}${projection.slot}</span>
        </div>`}
        ${mention && html`<div>
          <q>${mention.text}</q>
          ${mention.relative && html`<span class="debug-sub">counted from the document's date</span>`}
        </div>`}
        ${annotation && html`<div>
          <span>Revision ${annotation.revision}</span>
          ${annotation.confidence != null && html`<span class="debug-sub">${Math.round(annotation.confidence * 100)}% confidence</span>`}
          ${annotation.rationale && html`<p>${annotation.rationale}</p>`}
        </div>`}
      </section>
      ${evidence.length > 0 && html`<section>
        <h3>Evidence</h3>
        <div class="calendar-evidence-list">
          ${evidence.map((item) => html`<${EvidenceLink} key=${item.id} evidence=${item} />`)}
        </div>
      </section>`}
    </div>
  </${Modal}>`;
}

export function CalendarTab({ selectedId = null, developer = false } = {}) {
  const [zoom, setZoom] = useState("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => localDayKey(new Date()));
  const query = useMemo(() => queryFor(zoom, anchor), [zoom, anchor]);
  const queryKey = JSON.stringify(query);
  const [result, setResult] = useState({
    queryKey: null,
    items: [],
    documents: {},
    nowMs: Date.now(),
    timeZone: LOCAL_TIME_ZONE,
  });
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [showAllBanners, setShowAllBanners] = useState(false);
  // A new period starts with its spanning entries folded again.
  useEffect(() => setShowAllBanners(false), [queryKey]);
  const queryError = error?.queryKey === queryKey ? error.message : null;
  const loading = result.queryKey !== queryKey && queryError == null;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchCalendarPages(query)
      .then(async (next) => {
        if (cancelled) return;
        // Entries paint as soon as pagination completes. Evidence titles/icons
        // enrich them independently and never hold the Calendar behind corpus IO.
        const currentResult = { ...next, queryKey };
        setResult(currentResult);
        try {
          const documents = await fetchCalendarEvidence(next.items);
          if (!cancelled) {
            setResult((current) => current.queryKey === queryKey && current.items === next.items
              ? { ...currentResult, documents: { ...current.documents, ...documents } }
              : current);
          }
        } catch {
          // A deleted evidence row or transient summary failure must not hide
          // the temporal fact itself; ids remain usable fallback labels.
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError({ queryKey, message: reason?.message ?? String(reason) });
        }
      });
    return () => { cancelled = true; };
  }, [query, queryKey]);

  const days = useMemo(() => visibleCalendarDays(zoom === "upcoming" ? "week" : zoom, anchor), [zoom, anchor]);
  const visibleKeys = useMemo(() => new Set(days.map(localDayKey)), [days]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const entry of result.items) {
      for (const key of entryDayKeys(entry, visibleKeys, result.timeZone)) {
        const list = map.get(key) ?? [];
        list.push(entry);
        map.set(key, list);
      }
    }
    for (const [key, list] of map) {
      list.sort((a, b) => entryStartMs(a) - entryStartMs(b) || a.id.localeCompare(b.id));
      map.set(key, oneMentionPerDocument(list));
    }
    return map;
  }, [result.items, visibleKeys]);
  const banners = oneMentionPerDocument(result.items.filter(
    (entry) => isSemanticBanner(entry)
      && overlapsVisibleDays(entry, visibleKeys, result.timeZone),
  ));

  useEffect(() => {
    let cancelled = false;
    setDetailError(null);
    if (!selectedId) {
      setDetail((current) => current?.origin === "annotation" ? null : current);
      setDetailLoading(false);
      return () => { cancelled = true; };
    }
    const selected = result.items.find(
      (entry) => entry.origin === "annotation" && entry.id === selectedId,
    );
    if (selected) {
      setDetail(selected);
      setDetailLoading(false);
      return () => { cancelled = true; };
    }
    setDetail(null);
    setDetailLoading(true);
    getCalendarAnnotation(selectedId, result.timeZone)
      .then(async ({ item }) => {
        if (cancelled) return;
        setDetail(item);
        setDetailLoading(false);
        try {
          const documents = await fetchCalendarEvidence([item]);
          if (!cancelled) {
            setResult((current) => ({
              ...current,
              documents: { ...current.documents, ...documents },
            }));
          }
        } catch {
          // The detail remains addressable with evidence ids as fallbacks.
        }
      })
      .catch((reason) => {
        if (!cancelled) setDetailError(reason?.message ?? String(reason));
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, result.items, result.timeZone]);

  function selectZoom(next) {
    setZoom(next);
    if (next !== "upcoming") setSelectedDay(localDayKey(anchor));
  }

  function step(delta) {
    const next = zoom === "month"
      ? new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1)
      : addDays(anchor, delta * (zoom === "week" ? 7 : 1));
    setAnchor(next);
    setSelectedDay(localDayKey(next));
  }

  function openEntry(entry) {
    setDetail(entry);
    if (entry.origin === "annotation") {
      navigate(`/portal/debug/calendar/${encodeURIComponent(entry.id)}`);
    }
  }

  function closeDetail() {
    const wasAddressable = detail?.origin === "annotation";
    setDetail(null);
    if (wasAddressable || selectedId) replaceRoute("/portal/debug/calendar");
  }

  const upcoming = oneMentionPerDocument([...result.items].sort((a, b) => {
    const aKey = entryDayKeys(a, null, result.timeZone)[0] ?? a.start;
    const bKey = entryDayKeys(b, null, result.timeZone)[0] ?? b.start;
    return aKey.localeCompare(bKey) || entryStartMs(a) - entryStartMs(b);
  }), (entry) => entryDayKeys(entry, null, result.timeZone)[0]);

  const mentionsHidden = result.coverage?.mentions?.unworthyHidden === true;
  return html`<div class="calendar-view">
    <p class="debug-sub calendar-intro">
      The time index, read-only: facts your sources record, dates written in your
      documents, and — when the Brain runs — its own notes.
      ${mentionsHidden && " Dates in mail judged not worth recording are hidden."}
    </p>
    <div class="calendar-toolbar">
      <div class="calendar-zoom" role="group" aria-label="Calendar view">
        ${ZOOMS.map((item) => html`<button
          type="button"
          class=${zoom === item.value ? "active" : ""}
          aria-pressed=${zoom === item.value}
          onClick=${() => selectZoom(item.value)}
        >${item.label}</button>`)}
      </div>
      ${zoom !== "upcoming" && html`<div class="calendar-period-controls">
        <button type="button" aria-label="Previous period" onClick=${() => step(-1)}>‹</button>
        <button type="button" onClick=${() => { const now = new Date(); setAnchor(now); setSelectedDay(localDayKey(now)); }}>Today</button>
        <button type="button" aria-label="Next period" onClick=${() => step(1)}>›</button>
      </div>`}
    </div>
    <h2 class="calendar-period-title">${periodTitle(zoom, anchor, days)}</h2>
    ${loading && html`<div class="debug-loading">Loading calendar…</div>`}
    ${queryError && html`<div class="debug-error">⚠️ ${queryError}</div>`}
    ${detailLoading && html`<div class="debug-loading">Loading calendar entry…</div>`}
    ${detailError && html`<div class="debug-error">⚠️ ${detailError}</div>`}
    ${!loading && !queryError && result.capped && html`<div class="debug-sub calendar-capped">
      Showing the first ${result.items.length} entries — narrow the view to see them all.
    </div>`}
    ${!loading && !queryError && html`
      ${zoom !== "upcoming" && banners.length > 0 && html`<div class="calendar-banners">
        ${(showAllBanners ? banners : banners.slice(0, BANNER_PREVIEW)).map((entry) => html`<${CalendarEntryRow} key=${entry.id} entry=${entry} documents=${result.documents} timeZone=${result.timeZone} onOpen=${openEntry} />`)}
        ${banners.length > BANNER_PREVIEW && html`<button
          type="button"
          class="calendar-banners-toggle"
          onClick=${() => setShowAllBanners((shown) => !shown)}
        >${showAllBanners
          ? "Show fewer spanning entries"
          : `Show ${banners.length - BANNER_PREVIEW} more spanning entries`}</button>`}
      </div>`}
      ${zoom === "month" && html`<div>
        <${MonthGrid} days=${days} anchor=${anchor} byDay=${byDay} selectedDay=${selectedDay} onSelectDay=${setSelectedDay} />
        <${DaySection} day=${dateFromKey(selectedDay)} entries=${byDay.get(selectedDay) ?? []} documents=${result.documents} timeZone=${result.timeZone} today=${dayKeyInTimeZone(result.nowMs, result.timeZone)} onOpen=${openEntry} />
      </div>`}
      ${(zoom === "week" || zoom === "day") && html`<div class="calendar-agenda">
        ${days.map((day) => html`<${DaySection} key=${localDayKey(day)} day=${day} entries=${byDay.get(localDayKey(day)) ?? []} documents=${result.documents} timeZone=${result.timeZone} today=${dayKeyInTimeZone(result.nowMs, result.timeZone)} onOpen=${openEntry} />`)}
      </div>`}
      ${zoom === "upcoming" && (upcoming.length === 0
        ? html`<div class="calendar-upcoming-empty"><span>✓</span><strong>Nothing hanging over you</strong><p>No upcoming deadlines, expiries, or reminders.</p></div>`
        : html`<div class="calendar-upcoming">
            ${upcoming.map((entry) => html`<${CalendarEntryRow} key=${entry.id} entry=${entry} documents=${result.documents} timeZone=${result.timeZone} showDate=${true} onOpen=${openEntry} />`)}
          </div>`)}
    `}
    <${CalendarEntryDetail} entry=${detail} documents=${result.documents} timeZone=${result.timeZone} developer=${developer} onClose=${closeDetail} />
  </div>`;
}

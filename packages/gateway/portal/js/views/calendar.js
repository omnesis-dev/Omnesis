// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Calendar orchestration: window loading, navigation and detail selection.
// Pure grouping/date rules live in calendar-model; calendar-agenda and
// calendar-detail render the agenda and evidence without changing the index.

import { html } from "htm/preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { getCalendarItem, getCalendarWindow, getDocumentSummariesBulk } from "../api.js";
import { navigate, replaceRoute } from "../lib/router.js";
import {
  MOMENT_KINDS,
  entryStartMs,
  localDayKey,
  visibleCalendarDays,
  entryDayKeys,
  evidenceDocumentIds,
  isSemanticBanner,
  overlapsVisibleDays,
  dayKeyInTimeZone,
  filterCalendarEntries,
  relatedCalendarEntries,
  readCalendarPreferences,
  saveCalendarPreferences,
} from "./calendar-model.js";
import {
  CalendarEntryRow,
  DaySection,
  MonthGrid,
  CalendarGuide,
  CalendarFilters,
  MentionSection,
} from "./calendar-agenda.js";
import { CalendarEntryDetail } from "./calendar-detail.js";
export {
  CALENDAR_KINDS,
  calendarDateLabel,
  dayKeyInTimeZone,
  entryDayKeys,
  evidenceDocumentIds,
  isSemanticBanner,
  overlapsVisibleDays,
  visibleCalendarDays,
} from "./calendar-model.js";
export { CalendarEntryRow } from "./calendar-agenda.js";
export { evidenceSourceId, CalendarEntryDetail } from "./calendar-detail.js";

const DAY_MS = 86_400_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const BANNER_PREVIEW = 4;
const ORIGINS = "projection,annotation,mention";
const UPCOMING_DAYS = 399;
const UPCOMING_KINDS = [...MOMENT_KINDS];
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const ZOOMS = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "day", label: "Day" },
  { value: "upcoming", label: "Upcoming" },
];
function addDays(date, amount) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}
function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
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

function queryFor(zoom, anchor, preferences) {
  const timeZone = LOCAL_TIME_ZONE;
  if (zoom === "upcoming") {
    const now = Date.now();
    return {
      from: now - DAY_MS,
      to: now + UPCOMING_DAYS * DAY_MS,
      timeZone,
      kinds: UPCOMING_KINDS.join(","),
      statuses: "active,completed",
      origins: preferences.origin === "all" ? ORIGINS : preferences.origin,
    };
  }
  const days = visibleCalendarDays(zoom, anchor);
  return {
    from: addDays(days[0], -1).getTime(),
    to: addDays(days.at(-1), 2).getTime() - 1,
    timeZone,
    statuses: "active,completed",
    ...(preferences.dueOnly ? { kinds: UPCOMING_KINDS.join(",") } : {}),
    origins: preferences.origin === "all" ? ORIGINS : preferences.origin,
  };
}

function periodTitle(zoom, anchor, days) {
  if (zoom === "month") return anchor.toLocaleDateString([], { month: "long", year: "numeric" });
  if (zoom === "day")
    return anchor.toLocaleDateString([], {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  if (zoom === "upcoming") return "Deadlines, expiries and reminders";
  const first = days[0];
  const last = days.at(-1);
  const left = first.toLocaleDateString([], { day: "numeric", month: "short" });
  const right = last.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return `${left} – ${right}`;
}

export function CalendarTab({ selectedId = null, developer = false } = {}) {
  const [zoom, setZoom] = useState("week");
  const [preferences, setPreferences] = useState(readCalendarPreferences);
  const [quoteResult, setQuoteResult] = useState({
    id: null,
    evidence: [],
    loading: false,
    error: null,
  });
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => localDayKey(new Date()));
  const query = useMemo(() => queryFor(zoom, anchor, preferences), [zoom, anchor, preferences]);
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
            setResult((current) =>
              current.queryKey === queryKey && current.items === next.items
                ? { ...currentResult, documents: { ...current.documents, ...documents } }
                : current,
            );
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
    return () => {
      cancelled = true;
    };
  }, [query, queryKey]);

  useEffect(() => saveCalendarPreferences(preferences), [preferences]);

  const quoteId = detail?.origin === "annotation" ? detail.id : null;
  const quoteKey = quoteId
    ? `${quoteId}:${detail.annotation?.revision ?? 0}:${result.timeZone}`
    : null;
  useEffect(() => {
    let cancelled = false;
    if (!quoteId)
      return () => {
        cancelled = true;
      };
    setQuoteResult({ id: quoteKey, evidence: [], loading: true, error: null });
    Promise.resolve(getCalendarItem(quoteId, result.timeZone))
      .then((response) => {
        if (!cancelled)
          setQuoteResult({
            id: quoteKey,
            evidence: response?.evidence ?? [],
            loading: false,
            error: null,
          });
      })
      .catch((error) => {
        if (!cancelled)
          setQuoteResult({ id: quoteKey, evidence: [], loading: false, error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [quoteKey]);

  const filteredItems = useMemo(
    () => filterCalendarEntries(result.items, preferences),
    [result.items, preferences],
  );
  const filtered = preferences.origin !== "all" || preferences.dueOnly;
  const days = useMemo(
    () => visibleCalendarDays(zoom === "upcoming" ? "week" : zoom, anchor),
    [zoom, anchor],
  );
  const visibleKeys = useMemo(() => new Set(days.map(localDayKey)), [days]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const entry of filteredItems) {
      for (const key of entryDayKeys(entry, visibleKeys, result.timeZone)) {
        const list = map.get(key) ?? [];
        list.push(entry);
        map.set(key, list);
      }
    }
    for (const [key, list] of map) {
      list.sort((a, b) => entryStartMs(a) - entryStartMs(b) || a.id.localeCompare(b.id));
      map.set(key, list);
    }
    return map;
  }, [filteredItems, visibleKeys, result.timeZone]);
  const banners = filteredItems.filter(
    (entry) => isSemanticBanner(entry) && overlapsVisibleDays(entry, visibleKeys, result.timeZone),
  );
  const bannerFacts = banners.filter((entry) => entry.origin !== "mention");
  const bannerMentions = banners.filter((entry) => entry.origin === "mention");

  useEffect(() => {
    let cancelled = false;
    setDetailError(null);
    if (!selectedId) {
      setDetail((current) => current?.origin === "annotation" || current?.origin === "mention" ? null : current);
      setDetailLoading(false);
      return () => {
        cancelled = true;
      };
    }
    const selected = result.items.find(
      (entry) => entry.id === selectedId,
    );
    if (selected) {
      setDetail(selected);
      setDetailLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setDetail(null);
    setDetailLoading(true);
    getCalendarItem(selectedId, result.timeZone)
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
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, result.items, result.timeZone]);

  function selectZoom(next) {
    setZoom(next);
    if (next !== "upcoming") setSelectedDay(localDayKey(anchor));
  }

  function step(delta) {
    const next =
      zoom === "month"
        ? new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1)
        : addDays(anchor, delta * (zoom === "week" ? 7 : 1));
    setAnchor(next);
    setSelectedDay(localDayKey(next));
  }

  function openEntry(entry) {
    setDetail(entry);
    if (entry.origin === "annotation" || entry.origin === "mention") {
      navigate(`/portal/debug/calendar/${encodeURIComponent(entry.id)}`);
    } else if (selectedId) replaceRoute("/portal/debug/calendar");
  }

  function closeDetail() {
    const wasAddressable = detail?.origin === "annotation" || detail?.origin === "mention";
    setDetail(null);
    if (wasAddressable || selectedId) replaceRoute("/portal/debug/calendar");
  }

  const upcoming = [...filteredItems].sort((a, b) => {
    const aKey = entryDayKeys(a, null, result.timeZone)[0] ?? a.start;
    const bKey = entryDayKeys(b, null, result.timeZone)[0] ?? b.start;
    return aKey.localeCompare(bKey) || entryStartMs(a) - entryStartMs(b);
  });
  const upcomingFacts = upcoming.filter((entry) => entry.origin !== "mention");
  const upcomingMentions = upcoming.filter((entry) => entry.origin === "mention");

  const mentionsHidden = result.coverage?.mentions?.unworthyHidden === true;
  return html`<div class="calendar-view">
    <p class="debug-sub calendar-intro">
      Source records and agent interpretations form the agenda. Date mentions are grouped
      separately; they may not describe an event.
      ${mentionsHidden && " Dates in mail judged not worth recording are hidden."}
    </p>
    <${CalendarGuide} />
    <div class="calendar-toolbar">
      <div class="calendar-zoom" role="group" aria-label="Calendar view">
        ${ZOOMS.map(
          (item) =>
            html`<button
              type="button"
              class=${zoom === item.value ? "active" : ""}
              aria-pressed=${zoom === item.value}
              onClick=${() => selectZoom(item.value)}
            >
              ${item.label}
            </button>`,
        )}
      </div>
      ${zoom !== "upcoming" &&
      html`<div class="calendar-period-controls">
        <button type="button" aria-label="Previous period" onClick=${() => step(-1)}>‹</button>
        <button
          type="button"
          onClick=${() => {
            const now = new Date();
            setAnchor(now);
            setSelectedDay(localDayKey(now));
          }}
        >
          Today
        </button>
        <button type="button" aria-label="Next period" onClick=${() => step(1)}>›</button>
      </div>`}
    </div>
    <${CalendarFilters} preferences=${preferences} onChange=${setPreferences} />
    <h2 class="calendar-period-title">${periodTitle(zoom, anchor, days)}</h2>
    ${loading && html`<div class="debug-loading">Loading calendar…</div>`}
    ${queryError && html`<div class="debug-error">⚠️ ${queryError}</div>`}
    ${detailLoading && html`<div class="debug-loading">Loading calendar entry…</div>`}
    ${detailError && html`<div class="debug-error">⚠️ ${detailError}</div>`}
    ${!loading &&
    !queryError &&
    result.capped &&
    html`<div class="debug-sub calendar-capped">
      Showing the first ${result.items.length} entries — narrow the view to see them all.
    </div>`}
    ${!loading &&
    !queryError &&
    html`
      ${zoom !== "upcoming" &&
      bannerFacts.length > 0 &&
      html`<div class="calendar-banners">
        ${(showAllBanners ? bannerFacts : bannerFacts.slice(0, BANNER_PREVIEW)).map(
          (entry) =>
            html`<${CalendarEntryRow}
              key=${entry.id}
              entry=${entry}
              documents=${result.documents}
              timeZone=${result.timeZone}
              onOpen=${openEntry}
            />`,
        )}
        ${bannerFacts.length > BANNER_PREVIEW &&
        html`<button
          type="button"
          class="calendar-banners-toggle"
          onClick=${() => setShowAllBanners((shown) => !shown)}
        >
          ${showAllBanners
            ? "Show fewer spanning entries"
            : `Show ${bannerFacts.length - BANNER_PREVIEW} more spanning entries`}
        </button>`}
      </div>`}
      ${zoom !== "upcoming" &&
      bannerMentions.length > 0 &&
      html`<div class="calendar-banners">
        <${MentionSection}
          id="spanning"
          entries=${bannerMentions}
          documents=${result.documents}
          timeZone=${result.timeZone}
          onOpen=${openEntry}
          expanded=${preferences.origin === "mention"}
          showDate=${true}
        />
      </div>`}
      ${zoom === "month" &&
      html`<div>
        <${MonthGrid}
          days=${days}
          anchor=${anchor}
          byDay=${byDay}
          selectedDay=${selectedDay}
          onSelectDay=${setSelectedDay}
        />
        <${DaySection}
          day=${dateFromKey(selectedDay)}
          entries=${byDay.get(selectedDay) ?? []}
          documents=${result.documents}
          timeZone=${result.timeZone}
          today=${dayKeyInTimeZone(result.nowMs, result.timeZone)}
          onOpen=${openEntry}
          mentionsExpanded=${preferences.origin === "mention"}
          filtered=${filtered}
        />
      </div>`}
      ${(zoom === "week" || zoom === "day") &&
      html`<div class="calendar-agenda">
        ${days.map(
          (day) =>
            html`<${DaySection}
              key=${localDayKey(day)}
              day=${day}
              entries=${byDay.get(localDayKey(day)) ?? []}
              documents=${result.documents}
              timeZone=${result.timeZone}
              today=${dayKeyInTimeZone(result.nowMs, result.timeZone)}
              onOpen=${openEntry}
              mentionsExpanded=${preferences.origin === "mention"}
              filtered=${filtered}
            />`,
        )}
      </div>`}
      ${zoom === "upcoming" &&
      (upcoming.length === 0
        ? html`<div class="calendar-upcoming-empty">
            <span>✓</span><strong>No matching due items</strong>
            <p>No deadlines, expiries, or reminders in this window match the selected filters.</p>
          </div>`
        : html`<div class="calendar-upcoming">
            ${upcomingFacts.map(
              (entry) =>
                html`<${CalendarEntryRow}
                  key=${entry.id}
                  entry=${entry}
                  documents=${result.documents}
                  timeZone=${result.timeZone}
                  showDate=${true}
                  onOpen=${openEntry}
                />`,
            )}
            <${MentionSection}
              id="upcoming"
              entries=${upcomingMentions}
              documents=${result.documents}
              timeZone=${result.timeZone}
              onOpen=${openEntry}
              expanded=${preferences.origin === "mention"}
              showDate=${true}
            />
          </div>`)}
    `}
    <${CalendarEntryDetail}
      entry=${detail}
      documents=${result.documents}
      timeZone=${result.timeZone}
      developer=${developer}
      onClose=${closeDetail}
      evidenceQuotes=${quoteResult.id === quoteKey ? quoteResult.evidence : []}
      evidenceLoading=${!!quoteId && (quoteResult.id !== quoteKey || quoteResult.loading)}
      evidenceError=${quoteResult.id === quoteKey ? quoteResult.error : null}
      relatedEntries=${relatedCalendarEntries(detail, result.items)}
      onOpenRelated=${openEntry}
    />
  </div>`;
}

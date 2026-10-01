// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const DAY_MS = 86_400_000;

/** How each origin is labelled on a row and headed in its detail. */
export const ORIGIN_LABELS = {
  projection: {
    row: "Source record",
    heading: "Source record",
    icon: "▱",
    description:
      "Taken from a structured date field supplied by this source, such as a calendar booking or task due date.",
  },
  mention: {
    row: "Date mention",
    heading: "Date written in a document",
    icon: "❝",
    description:
      "Date mention detected in the document by Omnesis’ parser",
  },
  annotation: {
    row: "Agent interpretation",
    heading: "Agent interpretation",
    icon: "✦",
    description:
      "A dated fact recorded by the agent from supporting information. Open it to inspect the evidence.",
  },
};

export const CALENDAR_KINDS = {
  visit: {
    label: "Visit",
    icon: "●",
    color: "#38bdf8",
    description: "A visit to a place or a period of presence.",
  },
  calendar_event: {
    label: "Calendar",
    icon: "▣",
    color: "#60a5fa",
    description: "A calendar entry using an older classification.",
  },
  event: {
    label: "Event",
    icon: "◆",
    color: "#818cf8",
    description:
      "A general dated occurrence or plan. For a date mention, this is an unclassified date, not a confirmed event.",
  },
  deadline: {
    label: "Deadline",
    icon: "⚑",
    color: "#f87171",
    moment: true,
    description:
      "A date by which something is due. A date mention may only contain deadline phrasing.",
  },
  reminder: {
    label: "Reminder",
    icon: "●",
    color: "#fbbf24",
    moment: true,
    description: "A dated reminder.",
  },
  expiry: {
    label: "Expires",
    icon: "⌛",
    color: "#fb923c",
    moment: true,
    description: "When something ends or ceases to be valid.",
  },
  appointment: {
    label: "Appointment",
    icon: "◉",
    color: "#34d399",
    description: "A timed booking or scheduled engagement.",
  },
  episode: {
    label: "Activity",
    icon: "↺",
    color: "#a78bfa",
    description: "A dated episode or activity, not the time this entry was processed.",
  },
  episodic: {
    label: "Activity",
    icon: "↺",
    color: "#a78bfa",
    description: "A dated episode or activity, not the time this entry was processed.",
  },
};
export const MOMENT_KINDS = new Set(
  Object.keys(CALENDAR_KINDS).filter((kind) => CALENDAR_KINDS[kind].moment),
);
const DATE_FORMATTERS = new Map();

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

export function entryStartMs(entry) {
  return Date.parse(entry.start);
}

export function entryEndMs(entry) {
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
  return (
    entry.precision === "range" &&
    MOMENT_KINDS.has(entry.kind) &&
    entryEndMs(entry) - entryStartMs(entry) >= DAY_MS
  );
}

/** A mention span longer than this sits in the banner row, not on each of its days. */
const MENTION_BANNER_SPAN_MS = 7 * DAY_MS;

export function isSemanticBanner(entry) {
  const span = entryEndMs(entry) - entryStartMs(entry);
  return (
    entry.precision === "month" ||
    entry.precision === "year" ||
    (entry.precision === "range" && !isMomentWindow(entry) && span > 35 * DAY_MS) ||
    // A billing period or a statement's span names its days only at its
    // ends; repeating it on every day between would bury the days' own entries.
    (entry.origin === "mention" && entry.precision === "range" && span > MENTION_BANNER_SPAN_MS)
  );
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
  const ids =
    entry.origin === "projection"
      ? [entry.projection?.documentId]
      : entry.origin === "mention"
        ? [entry.mention?.documentId]
        : (entry.annotation?.documentIds ?? []);
  return [...new Set(ids.filter(Boolean))];
}

export function kindMeta(kind) {
  return (
    CALENDAR_KINDS[kind] ?? {
      label: kind || "Unclassified",
      icon: "○",
      color: "#94a3b8",
    }
  );
}

export function formatTime(entry, timeZone) {
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

export function filterCalendarEntries(entries, { origin = "all", dueOnly = false } = {}) {
  return entries.filter(
    (entry) =>
      (origin === "all" || entry.origin === origin) && (!dueOnly || MOMENT_KINDS.has(entry.kind)),
  );
}

export function groupDayEntries(entries) {
  const groups = { timed: [], allDay: [], activity: [], mentions: [] };
  for (const entry of entries) {
    if (entry.origin === "mention") groups.mentions.push(entry);
    else if (MOMENT_KINDS.has(entry.kind)) groups.allDay.push(entry);
    else if (entry.kind === "episode" || entry.kind === "episodic" || entry.kind === "visit")
      groups.activity.push(entry);
    else if (!entry.allDay) groups.timed.push(entry);
    else groups.allDay.push(entry);
  }
  return groups;
}

export function groupMentionDocuments(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.mention?.documentId ?? entry.id;
    const group = groups.get(key) ?? { documentId: entry.mention?.documentId, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function relatedCalendarEntries(entry, entries) {
  if (!entry) return [];
  return entries.filter(
    (candidate) =>
      candidate.id !== entry.id &&
      ((entry.origin === "annotation" &&
        candidate.origin === "projection" &&
        entry.annotation?.projectionIds?.includes(candidate.id)) ||
        (entry.origin === "projection" &&
          candidate.origin === "annotation" &&
          candidate.annotation?.projectionIds?.includes(entry.id))),
  );
}

const PREFERENCES_KEY = "omnesis:calendar-filters";
export function readCalendarPreferences(storage) {
  try {
    storage ??= globalThis.localStorage;
    const saved = JSON.parse(storage?.getItem(PREFERENCES_KEY) ?? "null");
    return {
      origin: ["all", "projection", "annotation", "mention"].includes(saved?.origin)
        ? saved.origin
        : "all",
      dueOnly: saved?.dueOnly === true,
    };
  } catch {
    return { origin: "all", dueOnly: false };
  }
}
export function saveCalendarPreferences(preferences, storage) {
  try {
    storage ??= globalThis.localStorage;
    storage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    /* Storage can be disabled or full. */
  }
}

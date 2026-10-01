// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { useId, useState } from "preact/hooks";
import { html } from "htm/preact";
import { sourceIconUrl } from "../lib/format.js";
import {
  ORIGIN_LABELS,
  CALENDAR_KINDS,
  MOMENT_KINDS,
  kindMeta,
  formatTime,
  dayKeyInTimeZone,
  entryStartMs,
  entryDayKeys,
  isMomentWindow,
  evidenceDocumentIds,
  localDayKey,
  groupDayEntries,
  groupMentionDocuments,
} from "./calendar-model.js";

/** A separate button keeps origin help reachable without opening the entry. */
export function OriginBadge({ origin }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const tooltipId = useId();
  const meta = ORIGIN_LABELS[origin] ?? { row: origin, icon: "○", description: origin };
  return html`<span
    class=${`calendar-origin-help calendar-origin-help--${origin}${open ? " is-open" : ""}${dismissed ? " is-dismissed" : ""}`}
    onMouseLeave=${() => {
      setOpen(false);
      setDismissed(false);
    }}
  >
    <button
      type="button"
      aria-describedby=${tooltipId}
      aria-expanded=${open}
      onFocus=${() => setDismissed(false)}
      onBlur=${() => {
        setOpen(false);
        setDismissed(false);
      }}
      onClick=${() => {
        setOpen(!open);
        setDismissed(open);
      }}
      onKeyDown=${(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          setDismissed(true);
        }
      }}
    >
      <span aria-hidden="true">${meta.icon}</span> ${meta.row} <span aria-hidden="true">ⓘ</span>
    </button>
    <span id=${tooltipId} role="tooltip" class="calendar-origin-tooltip">${meta.description}</span>
  </span>`;
}

export function KindPill({ kind }) {
  const meta = kindMeta(kind);
  return html`<span
    class="calendar-kind"
    title=${meta.description}
    style=${`--calendar-kind:${meta.color}`}
  >
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
  const ids = evidenceDocumentIds(entry);
  const document = ids.map((id) => documents[id]).find(Boolean);
  const sourceId =
    entry.projection?.sourceId ??
    entry.mention?.sourceId ??
    document?.sourceId ??
    document?.source_id ??
    document?.sourceType;
  const icon = sourceIconUrl(sourceId);
  const date = isMomentWindow(entry)
    ? entryDayKeys(entry, null, timeZone)[0]
    : dayKeyInTimeZone(entryStartMs(entry), timeZone);
  const mention = entry.origin === "mention";
  return html`<div
    class=${`calendar-item calendar-item--${entry.origin}`}
    style=${`--calendar-kind:${meta.color}`}
  >
    <button
      type="button"
      class=${`calendar-entry${MOMENT_KINDS.has(entry.kind) && !mention ? " actionable" : ""}`}
      onClick=${() => onOpen?.(entry)}
    >
      <span class="calendar-entry-spine" aria-hidden="true"></span>
      <span class="calendar-entry-body">
        <span class="calendar-entry-title"
          >${mention ? html`<q>${entry.mention?.text ?? entry.label}</q>` : entry.label}</span
        >
        <span class="calendar-entry-meta">
          ${showDate && html`<span>${date}</span>`}
          ${formatTime(entry, timeZone) && html`<span>${formatTime(entry, timeZone)}</span>`}
          <${KindPill} kind=${entry.kind} />
          ${!mention && icon && html`<img class="source-icon" src=${icon} alt="" />`}
          ${ids.length > 0 &&
          html`<span title="Linked supporting documents">▤ ${ids.length}</span>`}
        </span>
      </span>
    </button>
    <${OriginBadge} origin=${entry.origin} id=${entry.id} />
  </div>`;
}

export function CalendarGuide() {
  return html`<details class="calendar-guide">
    <summary>How to read this calendar</summary>
    <div class="calendar-guide-content">
      <p>
        Kind describes the entry; origin tells you how it entered the time index. Neither alone
        confirms that something happened.
      </p>
      ${Object.entries(ORIGIN_LABELS).map(
        ([origin, meta]) =>
          html`<div class=${`calendar-guide-origin calendar-guide-origin--${origin}`}>
            <strong>${meta.icon} ${meta.row}</strong>
            <p>${meta.description}</p>
          </div>`,
      )}
      <dl class="calendar-kind-guide">
        ${Object.values(CALENDAR_KINDS)
          .filter(
            (meta, index, all) =>
              all.findIndex((other) => other.label === meta.label) === index &&
              meta.label !== "Calendar",
          )
          .map(
            (meta) =>
              html`<dt>${meta.label}</dt>
                <dd>${meta.description}</dd>`,
          )}
      </dl>
      <p class="debug-sub">
        Active is a stored status, not confirmation or an indication that an entry is happening now.
        Supporting document counts are not counts of independent confirmations.
      </p>
    </div>
  </details>`;
}

export function CalendarFilters({ preferences, onChange }) {
  return html`<div class="calendar-filters">
    <div class="calendar-origin-filters" role="group" aria-label="Filter by origin">
      ${[
        { value: "all", label: "All" },
        { value: "projection", label: "Source" },
        { value: "annotation", label: "Agent" },
        { value: "mention", label: "Mentions" },
      ].map(
        (item) =>
          html`<button
            type="button"
            class=${preferences.origin === item.value ? "active" : ""}
            aria-pressed=${preferences.origin === item.value}
            onClick=${() => onChange({ ...preferences, origin: item.value })}
          >
            ${item.label}
          </button>`,
      )}
    </div>
    <label class="calendar-due-filter"
      ><input
        type="checkbox"
        checked=${preferences.dueOnly}
        onChange=${(event) => onChange({ ...preferences, dueOnly: event.currentTarget.checked })}
      />
      Due items only</label
    >
    <span class="debug-sub">Deadlines, expiries and reminders</span>
  </div>`;
}

function EntryGroup({ label, entries, documents, timeZone, onOpen, folded = false }) {
  if (!entries.length) return null;
  const rows = entries.map(
    (entry) =>
      html`<${CalendarEntryRow}
        key=${entry.id}
        entry=${entry}
        documents=${documents}
        timeZone=${timeZone}
        onOpen=${onOpen}
      />`,
  );
  if (folded)
    return html`<details class="calendar-activity-group">
      <summary>${label} <span>${entries.length}</span></summary>
      <div class="calendar-entry-group">${rows}</div>
    </details>`;
  return html`<section class="calendar-entry-group">
    <h3>${label}</h3>
    ${rows}
  </section>`;
}

export function MentionSection({
  entries,
  documents = {},
  timeZone,
  onOpen,
  expanded = false,
  showDate = false,
  id = "mentions",
}) {
  if (!entries.length) return null;
  const groups = groupMentionDocuments(entries);
  const deadlineCount = entries.filter((entry) => entry.kind === "deadline").length;
  return html`<details key=${`${id}-${expanded}`} class="calendar-mentions" open=${expanded}>
    <summary>
      Date mentions <span>${entries.length}</span>
      ${deadlineCount > 0 &&
      html`<span class="calendar-possible-deadlines"
        >${deadlineCount} possible deadline${deadlineCount === 1 ? "" : "s"}</span
      >`}
    </summary>
    <p class="debug-sub">
      Dates found in document text; they may not describe an event or an obligation.
    </p>
    <div class="calendar-mention-documents">
      ${groups.map((group) => {
        const doc = documents[group.documentId];
        return html`<section
          key=${group.documentId ?? group.entries[0].id}
          class="calendar-mention-document"
        >
          <h4>${doc?.title ?? group.entries[0].label}</h4>
          ${group.entries.map(
            (entry) =>
              html`<${CalendarEntryRow}
                key=${entry.id}
                entry=${entry}
                documents=${documents}
                showDate=${showDate}
                timeZone=${timeZone}
                onOpen=${onOpen}
              />`,
          )}
        </section>`;
      })}
    </div>
  </details>`;
}

export function DaySection({
  day,
  entries,
  documents,
  timeZone,
  today,
  onOpen,
  mentionsExpanded = false,
  filtered = false,
}) {
  const key = localDayKey(day);
  const groups = groupDayEntries(entries);
  const count = (origin) => entries.filter((entry) => entry.origin === origin).length;
  return html`<section class=${`calendar-day${key === today ? " today" : ""}`}>
    <header>
      <span class="calendar-day-number">${day.getDate()}</span>
      <span>${day.toLocaleDateString([], { weekday: "short", month: "short" })}</span>
      ${key === today && html`<span class="calendar-today-label">Today</span>`}
    </header>
    <div class="calendar-day-entries">
      ${entries.length === 0
        ? html`<span class="calendar-day-empty"
            >${filtered ? "No entries match these filters." : "Nothing filed for this day."}</span
          >`
        : html`
            <p class="calendar-day-counts">
              ${count("projection")} source records · ${count("annotation")} agent interpretations ·
              ${count("mention")} date mentions${filtered ? " · filtered" : ""}
            </p>
            <${EntryGroup}
              label="Timed"
              entries=${groups.timed}
              documents=${documents}
              timeZone=${timeZone}
              onOpen=${onOpen}
            />
            <${EntryGroup}
              label="All day & due"
              entries=${groups.allDay}
              documents=${documents}
              timeZone=${timeZone}
              onOpen=${onOpen}
            />
            <${EntryGroup}
              label="Other dated activity"
              entries=${groups.activity}
              documents=${documents}
              timeZone=${timeZone}
              onOpen=${onOpen}
              folded=${true}
            />
            <${MentionSection}
              id=${key}
              entries=${groups.mentions}
              documents=${documents}
              timeZone=${timeZone}
              onOpen=${onOpen}
              expanded=${mentionsExpanded}
            />
          `}
    </div>
  </section>`;
}

export function MonthGrid({ days, anchor, byDay, selectedDay, onSelectDay }) {
  return html`<div class="calendar-month-wrap">
    <div class="calendar-weekdays">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => html`<span>${day}</span>`)}
    </div>
    <div class="calendar-month-grid">
      ${days.map((day) => {
        const key = localDayKey(day);
        const entries = byDay.get(key) ?? [];
        const facts = entries.filter((entry) => entry.origin !== "mention");
        const mentions = entries.length - facts.length;
        return html`<button
          type="button"
          class=${`calendar-month-day${day.getMonth() !== anchor.getMonth() ? " outside" : ""}${key === selectedDay ? " selected" : ""}${key === localDayKey(new Date()) ? " today" : ""}`}
          onClick=${() => onSelectDay(key)}
          aria-label=${`${day.toLocaleDateString()}, ${facts.length} records and interpretations, ${mentions} date mentions`}
        >
          <span class="calendar-month-number">${day.getDate()}</span>
          <span class="calendar-month-marks"
            >${facts
              .slice(0, 3)
              .map(
                (entry) =>
                  html`<span style=${`--calendar-kind:${kindMeta(entry.kind).color}`}></span>`,
              )}
            ${facts.length > 3 && html`<small>+${facts.length - 3}</small>`} </span
          >${mentions > 0 && html`<small class="calendar-month-mentions">❝ ${mentions}</small>`}
        </button>`;
      })}
    </div>
  </div>`;
}

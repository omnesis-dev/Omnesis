// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Morning brief conversation's transcript, one day at a time.
 *
 * Each brief opens its day under a separator ("Today", "Yesterday",
 * "Tue 13 Oct"). The brief carries a header with its send time and, under it,
 * what it was based on: the observations it shipped, each with chips for its
 * sources and its tasks. The latest day is open, with that list expanded;
 * every earlier day folds to one summary line until it is opened. What is
 * open is remembered for as long as the conversation stays on screen.
 */

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getConversationBrief } from "../../api.js";
import {
  basedOnLabel,
  briefDayLabel,
  briefTimeLabel,
  foldedDaySummary,
  groupBriefDays,
  taskHref,
} from "../../lib/brief-thread.js";
import { localDay } from "../../lib/tasks-model.js";
import { navigate } from "../../lib/router.js";
import { DocChip } from "../doc-chip.js";
import { MessageBubble } from "./parts.js";

// Lucide `sun`, at the size and weight of the portal's other inline icons.
const SUN = html`<svg class="brief-sun" aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;

const CHEVRON = html`<svg class="brief-chevron" aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;

const TASK_ICON = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>`;

function errorText(err) {
  return err?.serverMessage ?? err?.message ?? String(err);
}

export function BriefThread({ conversationId, turns, citations, dispatch, today = localDay() }) {
  const { preamble, days } = groupBriefDays(turns);
  const latest = days.at(-1)?.day ?? null;
  // Earlier days the user opened, and the days whose footer is toggled away
  // from its default (open on the latest day, closed on the others).
  const [openDays, setOpenDays] = useState(() => new Set());
  const [toggledFooters, setToggledFooters] = useState(() => new Set());
  // day → { status: "loading" | "ok" | "error", data?, error? }
  const [details, setDetails] = useState(() => new Map());

  function load(day) {
    setDetails((prev) => new Map(prev).set(day, { status: "loading" }));
    getConversationBrief(conversationId, day).then(
      (data) => setDetails((prev) => new Map(prev).set(day, { status: "ok", data })),
      (err) => setDetails((prev) => new Map(prev).set(day, { status: "error", error: errorText(err) })),
    );
  }
  const ensure = (day) => {
    if (!details.has(day)) load(day);
  };

  // The latest brief's list is open from the start, so it is fetched at once;
  // an earlier day's is fetched when the day is opened.
  useEffect(() => {
    if (latest) ensure(latest);
  }, [conversationId, latest]);

  const toggle = (setter, day) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });

  const bubble = (turn, extra = {}) => html`<${MessageBubble}
    key=${turn.id}
    turn=${turn}
    citations=${citations}
    dispatch=${dispatch}
    ...${extra}
  />`;

  return html`
    ${preamble.map((turn) => bubble(turn))}
    ${days.map((group) => {
      const isLatest = group.day === latest;
      const open = isLatest || openDays.has(group.day);
      const detail = details.get(group.day);
      const itemCount = detail?.status === "ok" ? (detail.data?.items?.length ?? 0) : null;
      const label = briefDayLabel(group.day, today);
      const [brief, ...rest] = group.turns;
      return html`<section class="brief-day" key=${`brief-day-${group.day}`} aria-label=${`Morning brief, ${label}`}>
        <div class="brief-day-sep" role="separator">
          ${isLatest
            ? html`<span class="brief-day-label">${label}</span>`
            : html`<button
                type="button"
                class="brief-day-label brief-day-toggle"
                aria-expanded=${open}
                title=${open ? "Fold this day" : "Show this day"}
                onClick=${() => {
                  if (!open) ensure(group.day);
                  toggle(setOpenDays, group.day);
                }}
              >${label}</button>`}
        </div>
        ${open
          ? html`
              ${bubble(brief, {
                header: html`<${BriefHeader} sentAt=${group.sentAt} />`,
                footer: html`<${BriefFooter}
                  detail=${detail}
                  open=${isLatest !== toggledFooters.has(group.day)}
                  onToggle=${() => {
                    ensure(group.day);
                    toggle(setToggledFooters, group.day);
                  }}
                  onRetry=${() => load(group.day)}
                />`,
              })}
              ${rest.map((turn) => bubble(turn))}
            `
          : html`<button
              type="button"
              class="brief-day-folded"
              aria-expanded="false"
              onClick=${() => {
                ensure(group.day);
                toggle(setOpenDays, group.day);
              }}
            >
              ${SUN}
              <span>${foldedDaySummary({ itemCount, replies: group.replies })}</span>
              ${CHEVRON}
            </button>`}
      </section>`;
    })}
  `;
}

function BriefHeader({ sentAt }) {
  const time = briefTimeLabel(sentAt);
  return html`<div class="brief-header">
    ${SUN}
    <span class="brief-header-title">Morning brief</span>
    ${time && html`<span class="brief-header-time">${time}</span>`}
  </div>`;
}

function BriefFooter({ detail, open, onToggle, onRetry }) {
  if (!detail || detail.status === "loading") return null;
  if (detail.status === "error") {
    return html`<div class="brief-footer brief-footer-error" role="status">
      <span>Couldn't load what this brief was based on.</span>
      <button type="button" class="brief-retry" onClick=${onRetry}>Retry</button>
    </div>`;
  }
  const items = detail.data?.items ?? [];
  if (items.length === 0) return null;
  return html`<div class=${`brief-footer${open ? " open" : ""}`}>
    <button type="button" class="brief-footer-toggle" aria-expanded=${open} onClick=${onToggle}>
      ${CHEVRON}
      <span>${basedOnLabel(items.length)}</span>
    </button>
    ${open && html`<ol class="brief-items">
      ${items.map((item) => html`<li class="brief-item" key=${item.observationId}>
        <span class="brief-item-rank">${item.rank}</span>
        <div class="brief-item-body">
          <p class="brief-item-summary">${item.summary}</p>
          ${(item.sources.length > 0 || item.tasks.length > 0) && html`<div class="brief-item-chips">
            ${item.sources.map((source) => html`<${DocChip}
              key=${source.id}
              className="brief-chip"
              documentId=${source.id}
              title=${source.title}
              sourceId=${source.sourceType ?? ""}
            />`)}
            ${item.tasks.map((task) => html`<${TaskChip} key=${task.id} task=${task} />`)}
          </div>`}
        </div>
      </li>`)}
    </ol>`}
  </div>`;
}

function TaskChip({ task }) {
  const href = taskHref(task.id);
  const resolved = task.state === "done" || task.state === "dismissed";
  return html`<a
    class=${`brief-chip brief-task-chip${resolved ? " resolved" : ""}`}
    href=${href}
    title=${`Task · ${task.title}`}
    onClick=${(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      navigate(href);
    }}
  >
    <span class="brief-task-icon">${TASK_ICON}</span>
    <span class="doc-chip-title">${task.title}</span>
  </a>`;
}

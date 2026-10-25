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
 *
 * Each listed item takes a thumbs up or down. Up is one click and lands at
 * once; down asks which kind of "not useful" it was — not interested, which
 * teaches the Brain what to leave out, or a factual error, which goes to
 * Omnesis as a correction note — with room for a sentence of the owner's own.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getConversationBrief, setBriefItemReaction } from "../../api.js";
import { Modal } from "../modal.js";
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

// Lucide `thumbs-up` / `thumbs-down`.
const THUMB_UP = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>`;
const THUMB_DOWN = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>`;

/** The two kinds of thumbs-down, as the dialog offers them. */
export const DOWN_CHOICES = [
  {
    value: "not_interested",
    title: "Not interested in this kind of thing",
    detail: "Future briefs and task suggestions will follow this.",
  },
  {
    value: "factual_error",
    title: "Factual error",
    detail: "Not about my interests; a correction goes to Omnesis as a note.",
  },
];

/** The small word beside a pressed thumbs-down. */
export function downLabel(kind) {
  if (kind === "not_interested") return "not interested";
  if (kind === "factual_error") return "factual error";
  return null;
}

/** A day's detail with one item's reaction replaced. */
export function withItemReaction(detail, observationId, reaction) {
  if (!detail || detail.status !== "ok") return detail;
  const items = (detail.data?.items ?? []).map((item) => {
    if (item.observationId !== observationId) return item;
    const { reaction: _previous, ...rest } = item;
    return reaction ? { ...rest, reaction } : rest;
  });
  return { ...detail, data: { ...detail.data, items } };
}

/** The reaction the server confirmed, in the shape a brief item carries. */
function reactionFromResponse(response) {
  if (!response?.reaction) return null;
  return {
    kind: response.reaction,
    ...(response.note ? { note: response.note } : {}),
    ...(response.at ? { at: response.at } : {}),
  };
}

function errorText(err) {
  return err?.serverMessage ?? err?.message ?? String(err);
}

export function BriefThread({ conversationId, turns, citations, dispatch, onEdit, canEdit = true, today = localDay() }) {
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
  const setReaction = (day, observationId, reaction) =>
    setDetails((prev) => new Map(prev).set(day, withItemReaction(prev.get(day), observationId, reaction)));

  // The new state shows at once and the server's answer replaces it; a
  // refusal puts the previous state back and the error is the caller's to show.
  async function react(day, item, body) {
    const previous = item.reaction ?? null;
    setReaction(day, item.observationId, body.reaction ? { kind: body.reaction, ...(body.note ? { note: body.note } : {}) } : null);
    try {
      const response = await setBriefItemReaction(conversationId, day, item.observationId, body);
      setReaction(day, item.observationId, reactionFromResponse(response));
    } catch (err) {
      setReaction(day, item.observationId, previous);
      throw err;
    }
  }

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
    onEdit=${onEdit}
    canEdit=${canEdit}
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
                  onReact=${(item, body) => react(group.day, item, body)}
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

function BriefFooter({ detail, open, onToggle, onRetry, onReact }) {
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
      ${items.map((item) => html`<${BriefItem} key=${item.observationId} item=${item} onReact=${onReact} />`)}
    </ol>`}
  </div>`;
}

function BriefItem({ item, onReact }) {
  const [error, setError] = useState(null);
  const [asking, setAsking] = useState(false);
  const kind = item.reaction?.kind ?? null;
  const up = kind === "up";
  const down = kind === "not_interested" || kind === "factual_error";

  // The one-click thumbs up reports its failure beside the buttons; the
  // dialog reports its own.
  const thumbUp = () => {
    setError(null);
    onReact(item, { reaction: up ? null : "up" }).catch((err) => setError(errorText(err)));
  };

  return html`<li class="brief-item">
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
      <div class="brief-item-reactions">
        <button
          type="button"
          class="brief-thumb brief-thumb-up"
          aria-label="Useful"
          aria-pressed=${up}
          title=${up ? "Take back the thumbs up" : "Useful"}
          onClick=${thumbUp}
        >${THUMB_UP}</button>
        <button
          type="button"
          class="brief-thumb brief-thumb-down"
          aria-label="Not useful"
          aria-pressed=${down}
          title="Not useful"
          onClick=${() => setAsking(true)}
        >${THUMB_DOWN}</button>
        ${down && html`<span class="brief-thumb-label">${downLabel(kind)}</span>`}
        ${error && html`<span class="brief-thumb-error" role="alert">${error}</span>`}
      </div>
    </div>
    ${asking && html`<${NotUsefulDialog}
      reaction=${down ? item.reaction : null}
      onClose=${() => setAsking(false)}
      onSend=${(body) => onReact(item, body).then(() => setAsking(false))}
    />`}
  </li>`;
}

/**
 * The thumbs-down dialog. Opens on the item's current thumbs-down when it has
 * one, so the owner can change the kind or the note; "Remove" takes the
 * reaction back. An error from the send stays in the dialog, the choice intact.
 */
function NotUsefulDialog({ reaction, onClose, onSend }) {
  const [choice, setChoice] = useState(reaction?.kind ?? DOWN_CHOICES[0].value);
  const [note, setNote] = useState(reaction?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // One send at a time. The ref, not the state, is the guard: a second
  // submit in the same tick would still see `busy` false.
  const sending = useRef(false);
  const submit = (body) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    onSend(body).catch((err) => {
      sending.current = false;
      setError(errorText(err));
      setBusy(false);
    });
  };

  return html`<${Modal} open=${true} onClose=${onClose} title="Not useful?" size="sm">
    <form
      class="brief-reaction-form"
      onSubmit=${(e) => {
        e.preventDefault();
        const trimmed = note.trim();
        submit({ reaction: choice, ...(trimmed ? { note: trimmed } : {}) });
      }}
    >
      <fieldset class="brief-reaction-choices" disabled=${busy}>
        <legend class="sr-only">Why it was not useful</legend>
        ${DOWN_CHOICES.map((option) => html`<label class="brief-reaction-option" key=${option.value}>
          <input
            type="radio"
            name="brief-reaction"
            value=${option.value}
            checked=${choice === option.value}
            onChange=${() => setChoice(option.value)}
          />
          <span class="brief-reaction-text">
            <strong>${option.title}</strong>
            <small>${option.detail}</small>
          </span>
        </label>`)}
      </fieldset>
      <label class="brief-reaction-note-label">
        <span>Say more (optional)</span>
        <textarea
          class="brief-reaction-note"
          rows="3"
          maxlength="2000"
          placeholder="What was off, or what you would rather hear about"
          value=${note}
          disabled=${busy}
          onInput=${(e) => setNote(e.currentTarget.value)}
        ></textarea>
      </label>
      ${error && html`<div class="modal-error" role="alert">${error}</div>`}
      <div class="modal-actions">
        ${reaction && html`<button
          type="button"
          class="btn-secondary brief-reaction-remove"
          disabled=${busy}
          onClick=${() => submit({ reaction: null })}
        >Remove</button>`}
        <button type="button" class="btn-secondary" disabled=${busy} onClick=${onClose}>Cancel</button>
        <button type="submit" class="btn-primary" disabled=${busy}>${busy ? "Sending…" : "Send"}</button>
      </div>
    </form>
  </${Modal}>`;
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

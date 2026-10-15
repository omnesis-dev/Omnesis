// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tasks — a bullet-journal view of the user's own tasks, backed by `/tasks`.
 *
 * Interaction is click-first: the bullet completes a task (or reopens a
 * resolved one); a click anywhere else on the row's line expands it in place
 * to show its actions —
 * Done with an optional note, the quick moves, Strike, Edit and History.
 * Every change answers with a receipt that the toast shows with Undo.
 * In experimental mode the Brain's suggestions live under Suggested: the
 * bullet marks one already done, and its line offers Accept (for a chosen
 * time), Accept with a note the note agent applies to it, and Ignore, which
 * leaves the Brain tracking it out of Tasks. A task the Brain proposes to
 * change shows the proposal inline with Confirm / Keep and keeps its values
 * until confirmed. Both exist only where the Brain
 * runs, so neither surface appears outside experimental mode. A task lists
 * the documents it refers to under its title, each a link to the document
 * view. Tasks are added through Tell Omnesis, which the Today view points to.
 * Pure logic (dates, labels, grouping) lives in
 * `lib/tasks-model.js`.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getTask, listTasks, taskAction, undoTask } from "../api.js";
import { navigate } from "../lib/router.js";
import { docHref, sourceIcon, sourceLabel } from "../lib/format.js";
import {
  TASK_VIEWS,
  countLabel,
  editBody,
  emptyViewMessage,
  groupTasks,
  autoAppliedUndoSeq,
  historyEventLabel,
  historyNote,
  isResolved,
  localDay,
  proposalText,
  quickMoves,
  resolveTaskView,
  scheduleEditorState,
  shortDayLabel,
  suggestionAcceptBody,
  suggestionWhenOptions,
  taskBullet,
  taskDocumentsShown,
  taskMetaItems,
  viewCount,
  visibleTaskViews,
} from "../lib/tasks-model.js";
import { publishTaskCounts } from "../lib/task-counts.js";

const TOAST_MS = 8000;

function errorText(err) {
  return err?.serverMessage ?? err?.message ?? String(err);
}

export function TasksView({ taskView = "today", focusTaskId = null, experimental = false }) {
  const view = resolveTaskView(taskView, experimental);
  const [today, setToday] = useState(() => localDay());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The open tasks per view, kept across tab switches so the counts on the
  // tabs never blank out while the next view loads.
  const [counts, setCounts] = useState(null);
  const [expandedId, setExpandedId] = useState(focusTaskId);
  // The task a link opened (`?task=`), read on its own so it shows even when
  // the current view does not list it.
  const [focusTask, setFocusTask] = useState(null);
  const [toast, setToast] = useState(null);
  const [actionError, setActionError] = useState(null);
  const loadSeq = useRef(0);
  const toastTimer = useRef(null);

  async function loadFocus() {
    if (!focusTaskId) {
      setFocusTask(null);
      return;
    }
    try {
      const result = await getTask(focusTaskId);
      setFocusTask(result?.task ?? null);
    } catch {
      setFocusTask(null);
    }
  }

  async function load() {
    loadFocus();
    const day = localDay();
    setToday(day);
    const seq = ++loadSeq.current;
    try {
      const page = await listTasks(view, day);
      if (seq !== loadSeq.current) return;
      setData(page);
      setCounts(page?.counts ?? null);
      publishTaskCounts(page?.counts);
      setError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(errorText(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setData(null);
    setExpandedId(focusTaskId);
    load();
  }, [view, focusTaskId]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  function showReceipt(receipt) {
    clearTimeout(toastTimer.current);
    if (!receipt?.text) {
      setToast(null);
      return;
    }
    setToast({ text: receipt.text, undoSeq: receipt.undoSeq ?? null, id: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }

  // Run one mutation: show its receipt, then re-read the view so the row
  // lands where the gateway now places it.
  async function mutate(request) {
    setActionError(null);
    try {
      const result = await request();
      showReceipt(result?.receipt);
      await load();
      return true;
    } catch (err) {
      setActionError(errorText(err));
      return false;
    }
  }

  const act = (task, body) => mutate(() => taskAction(task.id, body));

  async function undo(seq) {
    clearTimeout(toastTimer.current);
    setToast(null);
    await mutate(() => undoTask(seq));
  }

  const tasks = data?.tasks ?? [];
  const groups = groupTasks(view, tasks, today);
  const focusOutsideView = focusTask && !tasks.some((task) => task.id === focusTask.id) ? focusTask : null;
  const row = (task) => html`<${TaskRow}
    key=${task.id}
    task=${task}
    view=${view}
    today=${today}
    experimental=${experimental}
    expanded=${expandedId === task.id}
    focused=${focusTaskId === task.id}
    onToggle=${() => setExpandedId(expandedId === task.id ? null : task.id)}
    act=${(body) => act(task, body)}
    onUndo=${undo}
  />`;
  const proposals = experimental ? data?.counts?.proposals ?? 0 : 0;

  return html`
    <div class="tasks-view">
      <header class="privacy-page-header tasks-header">
        <div><h1>Tasks</h1></div>
        <span class="tasks-header-day">${shortDayLabel(today)} ${today.slice(0, 4)}</span>
      </header>

      <nav class="tasks-tabs" aria-label="Task views">
        ${visibleTaskViews(experimental).map((v) => {
          const active = v.key === view;
          const count = viewCount(counts, v.key);
          const href = v.key === "today" ? "/portal/tasks" : `/portal/tasks/${v.key}`;
          return html`<a
            key=${v.key}
            href=${href}
            class=${`tasks-tab${active ? " active" : ""}`}
            aria-current=${active ? "page" : undefined}
            onClick=${(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              navigate(href);
            }}
          >
${countLabel(v.label, count)}</a>`;
        })}
      </nav>

      ${view === "today" && html`<p class="tasks-add-hint">
        Use <a
          href="/portal/capture"
          onClick=${(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate("/portal/capture");
          }}
        >Tell Omnesis</a> to add tasks.
      </p>`}

      ${proposals > 0 && view !== "suggested" && html`
        <p class="tasks-proposals-note">
          Omnesis proposed ${proposals === 1 ? "a change" : `${proposals} changes`} to your tasks. Each
          stays as it is until you confirm.
        </p>`}

      ${actionError && html`<div class="debug-error tasks-error" role="alert">
        <span>${actionError}</span>
        <button type="button" class="capture-error-dismiss" aria-label="Dismiss" onClick=${() => setActionError(null)}>×</button>
      </div>`}

      ${focusOutsideView && html`<section class="tasks-group tasks-focus-group" aria-label="Opened task">
        <ul class="tasks-list">${row(focusOutsideView)}</ul>
      </section>`}

      ${loading && !data
        ? html`<div class="tasks-empty">Loading tasks…</div>`
        : error
          ? html`<div class="debug-error" role="alert">Couldn't load tasks: ${error}</div>`
          : html`<div class="tasks-groups">
              ${groups.map((group) => html`
                <section key=${group.key} class="tasks-group" aria-label=${group.label ?? TASK_VIEWS.find((v) => v.key === view)?.label}>
                  ${group.label && html`<h2 class="tasks-group-title">${group.label}
                    ${group.key === "carried" && html`<span class="tasks-group-hint">planned for an earlier day</span>`}
                  </h2>`}
                  ${group.tasks.length === 0
                    ? html`<div class="tasks-empty">${emptyViewMessage(view)}</div>`
                    : html`<ul class="tasks-list">
                        ${group.tasks.map(row)}
                      </ul>`}
                </section>`)}
            </div>`}

      ${toast && html`<div class="toast tasks-toast" role="status" aria-live="polite" key=${toast.id}>
        <span>${toast.text}</span>
        ${toast.undoSeq != null && html`<button type="button" class="tasks-toast-undo" onClick=${() => undo(toast.undoSeq)}>Undo</button>`}
        <button type="button" class="tasks-toast-close" aria-label="Dismiss" onClick=${() => setToast(null)}>×</button>
      </div>`}
    </div>
  `;
}

/** Small inline icons for the meta line (Lucide outlines), one per item kind. */
const META_ICONS = {
  calendar: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>`,
  flag: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>`,
  carried: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/></svg>`,
  person: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>`,
  waiting: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>`,
  note: html`<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
};

function TaskMeta({ task, view, today }) {
  const items = taskMetaItems(task, view, today);
  if (items.length === 0) return null;
  return html`<div class="tasks-meta">
    ${items.map((item) => html`<span key=${item.icon ?? item.text} class=${`tasks-meta-item tasks-meta-${item.tone}`}>
      ${item.icon && META_ICONS[item.icon]}${item.tone === "danger" ? html`<span class="sr-only">Overdue: </span>` : null}${item.text}
    </span>`)}
  </div>`;
}

/**
 * Whether a click on a row's line should open or close its actions: anywhere
 * on the line except a control with its own behaviour — the bullet, a
 * document link, a proposal's or suggestion's buttons — or a drag that
 * selected text.
 */
export function isRowToggleClick(event) {
  const target = event.target;
  if (target?.closest?.("button, a, input, select, textarea, label, .tasks-proposal, .tasks-suggestion-actions")) {
    return false;
  }
  return !String(window.getSelection?.() ?? "");
}

function TaskRow({ task, view, today, experimental, expanded, focused = false, onToggle, act, onUndo }) {
  const rowRef = useRef(null);
  // A task opened by a link is brought into view once it renders.
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);
  const bullet = taskBullet(task);
  const resolved = isResolved(task);
  const suggested = view === "suggested";
  const proposal = experimental ? proposalText(task.proposedChange) : null;
  const detailId = `task-detail-${task.id}`;
  const bulletLabel = suggested
    ? `Mark “${task.title}” as already done`
    : resolved
      ? `Reopen “${task.title}”`
      : `Complete “${task.title}”`;
  return html`<li ref=${rowRef} class=${`tasks-row tasks-row-${bullet}${expanded ? " expanded" : ""}${focused ? " focused" : ""}`}>
    <div class="tasks-row-main" onClick=${(e) => { if (isRowToggleClick(e)) onToggle(); }}>
      <button
        type="button"
        class=${`tasks-bullet tasks-bullet-${suggested ? "suggested" : bullet}`}
        aria-label=${bulletLabel}
        title=${suggested ? "Already done" : resolved ? "Reopen" : "Complete"}
        onClick=${() => act(resolved ? { action: "reopen" } : { action: "complete" })}
      ></button>
      <div class="tasks-row-body">
        <button
          type="button"
          class="tasks-row-title"
          aria-expanded=${expanded}
          aria-controls=${detailId}
          onClick=${onToggle}
        >${task.title}</button>
        ${task.description && html`<p class="tasks-description">${task.description}</p>`}
        <${TaskMeta} task=${task} view=${view} today=${today} />
        ${task.state === "done" && task.completionNote && html`<p class="tasks-completion-note">“${task.completionNote}”</p>`}
        <${TaskDocuments} documents=${task.documents} />
        ${proposal && !resolved && html`<div class="tasks-proposal">
          <span class="tasks-proposal-text">${proposal}</span>
          <span class="tasks-proposal-actions">
            <button type="button" class="btn-tiny" onClick=${() => act({ action: "confirm" })}>Confirm</button>
            <button type="button" class="btn-tiny" onClick=${() => act({ action: "keep" })}>Keep</button>
          </span>
        </div>`}
        ${suggested && html`<${SuggestionActions} task=${task} today=${today} act=${act} />`}
      </div>
    </div>
    ${expanded && html`<div class="tasks-row-detail" id=${detailId}>
      <${TaskDetail} task=${task} view=${view} today=${today} act=${act} onUndo=${onUndo} />
    </div>`}
  </li>`;
}

/** The documents a task refers to: the source's icon, then the title, linking to the document. */
function TaskDocuments({ documents }) {
  const [showAll, setShowAll] = useState(false);
  const { shown, hidden } = taskDocumentsShown(documents, showAll);
  if (shown.length === 0) return null;
  return html`<ul class="tasks-documents" aria-label="Documents">
    ${shown.map((doc) => {
      const href = docHref({ documentId: doc.id });
      return html`<li key=${doc.id} class="tasks-document">
        <a
          class="tasks-document-link"
          href=${href}
          title=${sourceLabel(doc.sourceId)}
          onClick=${(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate(href);
          }}
        ><span class="tasks-document-icon" aria-hidden="true">${sourceIcon(doc.sourceId, { size: 14 })}</span><span class="tasks-document-title">${doc.title || "Untitled document"}</span></a>
      </li>`;
    })}
    ${hidden > 0 && html`<li class="tasks-document">
      <button type="button" class="tasks-documents-more" onClick=${() => setShowAll(true)}>+${hidden} more</button>
    </li>`}
  </ul>`;
}

function SuggestionActions({ task, today, act }) {
  const [when, setWhen] = useState("");
  const [note, setNote] = useState(null);
  const noteId = useRef(null);
  const accept = async () => {
    if (note !== null && !note.trim()) return;
    // One id per note, so a retried request saves the note once.
    noteId.current ??= crypto.randomUUID();
    const ok = await act(suggestionAcceptBody({ when, note: note ?? "", noteId: noteId.current }));
    if (ok) {
      setNote(null);
      noteId.current = null;
    }
  };
  return html`<div class="tasks-suggestion-actions">
    <label class="tasks-inline-label">
      <span class="sr-only">When to do “${task.title}”</span>
      <select class="tasks-select" value=${when} onChange=${(e) => setWhen(e.currentTarget.value)}>
        ${suggestionWhenOptions(today).map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
      </select>
    </label>
    ${note === null
      ? html`
        <button type="button" class="btn-tiny tasks-accept" onClick=${accept}>Accept</button>
        <button type="button" class="btn-tiny tasks-accept-note" onClick=${() => setNote("")}>Accept with note</button>
        <button type="button" class="btn-tiny tasks-mark-done" onClick=${() => act({ action: "complete" })}>Mark as done</button>
        <button type="button" class="btn-tiny tasks-ignore" title="Hide it from Tasks; Omnesis keeps track of it" onClick=${() => act({ action: "ignore" })}>Ignore</button>`
      : html`<form class="tasks-suggestion-note" onSubmit=${(e) => { e.preventDefault(); accept(); }}>
          <textarea
            class="tasks-note-input"
            rows="2"
            maxlength="8000"
            aria-label=${`Note about “${task.title}”`}
            placeholder="Add context for Omnesis"
            value=${note}
            onInput=${(e) => setNote(e.currentTarget.value)}
          ></textarea>
          <button type="submit" class="btn-tiny tasks-accept" disabled=${!note.trim()}>Accept with note</button>
          <button type="button" class="btn-tiny" onClick=${() => setNote(null)}>Cancel</button>
        </form>`}
  </div>`;
}

function TaskDetail({ task, view, today, act, onUndo }) {
  const [note, setNote] = useState("");
  const [mode, setMode] = useState("actions");
  const resolved = isResolved(task);
  const suggested = view === "suggested";
  return html`<div class="tasks-detail">
    ${mode === "edit"
      ? html`<${TaskEditor} task=${task} onCancel=${() => setMode("actions")} act=${async (body) => {
          const ok = await act(body);
          if (ok) setMode("actions");
        }} />`
      : html`
        ${!resolved && !suggested && html`<form class="tasks-done-form" onSubmit=${(e) => {
          e.preventDefault();
          act(note.trim() ? { action: "complete", note: note.trim() } : { action: "complete" });
        }}>
          <input
            class="tasks-note-input"
            type="text"
            maxlength="500"
            aria-label="Completion note (optional)"
            placeholder="Note (optional)"
            value=${note}
            onInput=${(e) => setNote(e.currentTarget.value)}
          />
          <button type="submit" class="btn-tiny tasks-done-btn">Done</button>
        </form>`}
        <div class="tasks-actions" role="group" aria-label="Task actions">
          ${!resolved && !suggested && quickMoves(today).map((move) => html`
            <button key=${move.key} type="button" class="btn-tiny" title=${`Move to ${move.to}`} onClick=${() => act({ action: "migrate", to: move.to })}>${move.label}</button>`)}
          ${!resolved && !suggested && html`<button type="button" class="btn-tiny" onClick=${() => act({ action: "strike" })}>Strike</button>`}
          ${resolved && html`<button type="button" class="btn-tiny" onClick=${() => act({ action: "reopen" })}>Reopen</button>`}
          ${!suggested && html`<button type="button" class="btn-tiny" onClick=${() => setMode("edit")}>Edit</button>`}
          <button type="button" class="btn-tiny" aria-expanded=${mode === "history"} onClick=${() => setMode(mode === "history" ? "actions" : "history")}>History</button>
        </div>
        ${mode === "history" && html`<${TaskHistory} id=${task.id} lastUpdate=${task.lastUpdate} onUndo=${onUndo} />`}
      `}
  </div>`;
}

function TaskEditor({ task, act, onCancel }) {
  const initialSchedule = scheduleEditorState(task.scheduledFor);
  const [form, setForm] = useState({
    title: task.title,
    description: task.description ?? "",
    scheduleMode: initialSchedule.mode,
    scheduleValue: initialSchedule.value,
    deadline: task.deadline && typeof task.deadline === "object" ? task.deadline.date ?? "" : "",
  });
  const [error, setError] = useState(null);
  const set = (field) => (e) => setForm({ ...form, [field]: e.currentTarget.value });
  const titleRef = useRef(null);
  useEffect(() => titleRef.current?.focus(), []);
  function submit(e) {
    e.preventDefault();
    const body = editBody(task, form);
    if (body === null) return onCancel();
    if (body.error) return setError(body.error);
    setError(null);
    act(body);
  }
  return html`<form class="tasks-editor" onSubmit=${submit} onKeyDown=${(e) => { if (e.key === "Escape") onCancel(); }}>
    <label class="tasks-field">
      <span>Title</span>
      <input ref=${titleRef} type="text" maxlength="200" value=${form.title} onInput=${set("title")} />
    </label>
    <label class="tasks-field">
      <span>Description</span>
      <textarea rows="2" maxlength="2000" value=${form.description} onInput=${set("description")}></textarea>
    </label>
    <div class="tasks-field-row">
      <label class="tasks-field">
        <span>Planned for</span>
        <select value=${form.scheduleMode} onChange=${(e) => setForm({ ...form, scheduleMode: e.currentTarget.value, scheduleValue: "" })}>
          <option value="none">Not scheduled</option>
          <option value="day">A day</option>
          <option value="month">A month</option>
          <option value="someday">Someday</option>
        </select>
      </label>
      ${form.scheduleMode === "day" && html`<label class="tasks-field">
        <span>Day</span>
        <input type="date" value=${form.scheduleValue} onInput=${set("scheduleValue")} />
      </label>`}
      ${form.scheduleMode === "month" && html`<label class="tasks-field">
        <span>Month</span>
        <input type="month" value=${form.scheduleValue} onInput=${set("scheduleValue")} />
      </label>`}
      <label class="tasks-field">
        <span>Deadline</span>
        <input type="date" value=${form.deadline} onInput=${set("deadline")} />
      </label>
    </div>
    ${error && html`<div class="tasks-editor-error" role="alert">${error}</div>`}
    <div class="tasks-editor-actions">
      <button type="button" class="btn-secondary" onClick=${onCancel}>Cancel</button>
      <button type="submit" class="btn-primary">Save</button>
    </div>
  </form>`;
}

function TaskHistory({ id, lastUpdate, onUndo }) {
  const [state, setState] = useState({ loading: true, error: null, history: [], undoSeq: null });
  // Re-read whenever the task changes, so an undo shows in its history.
  useEffect(() => {
    let live = true;
    getTask(id)
      .then((out) => live && setState({ loading: false, error: null, history: out?.history ?? [], undoSeq: out?.undoSeq ?? null }))
      .catch((err) => live && setState({ loading: false, error: errorText(err), history: [], undoSeq: null }));
    return () => { live = false; };
  }, [id, lastUpdate]);
  const undoable = autoAppliedUndoSeq(state.history, state.undoSeq);
  if (state.loading) return html`<div class="tasks-history-empty">Loading history…</div>`;
  if (state.error) return html`<div class="debug-error">${state.error}</div>`;
  if (state.history.length === 0) return html`<div class="tasks-history-empty">No history yet.</div>`;
  return html`<ol class="tasks-history" aria-label="Task history">
    ${state.history.map((event) => html`<li key=${event.seq} class="tasks-history-entry">
      <time datetime=${event.at} class="tasks-history-at">${event.at ? new Date(event.at).toLocaleString() : ""}</time>
      <span class="tasks-history-kind">${historyEventLabel(event)}</span>
      ${undoable === event.seq && onUndo && html`<button type="button" class="btn-tiny tasks-history-undo" onClick=${() => onUndo(event.seq)}>Undo</button>`}
      ${historyNote(event) && html`<span class="tasks-history-note">${historyNote(event)}</span>`}
      ${event.conversationId && html`<a
        class="tasks-history-link"
        href=${`/portal/agent/${encodeURIComponent(event.conversationId)}`}
        onClick=${(e) => { e.preventDefault(); navigate(`/portal/agent/${encodeURIComponent(event.conversationId)}`); }}
      >Open conversation</a>`}
    </li>`)}
  </ol>`;
}

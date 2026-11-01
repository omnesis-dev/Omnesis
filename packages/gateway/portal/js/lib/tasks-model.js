// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure logic behind the Tasks view: the journal views, the local-day
 * arithmetic the quick moves use (tomorrow, next week, next month), the
 * labels a row shows, and how a view's rows are grouped. No DOM, no
 * network — the view module renders what these return.
 *
 * Days are local `YYYY-MM-DD` strings and months `YYYY-MM`, the same
 * spelling the gateway's `scheduledFor` uses. Arithmetic goes through
 * `Date.UTC` so a day never shifts across a daylight-saving change.
 */

/**
 * The journal views, in tab order. Suggested holds the Brain's suggestions,
 * which only exist where the Brain runs, so it is an experimental view.
 */
export const TASK_VIEWS = [
  { key: "today", label: "Today" },
  { key: "month", label: "Month" },
  { key: "future", label: "Future" },
  { key: "anytime", label: "Anytime" },
  { key: "waiting", label: "Waiting" },
  { key: "suggested", label: "Suggested", experimental: true },
  { key: "done", label: "Done" },
];

export const TASK_VIEW_KEYS = TASK_VIEWS.map((view) => view.key);

/** The views the tab bar offers: experimental ones only in experimental mode. */
export function visibleTaskViews(experimental) {
  return TASK_VIEWS.filter((view) => !view.experimental || experimental === true);
}

/** The view to show for a requested key: an unknown or hidden view opens Today. */
export function resolveTaskView(key, experimental) {
  return visibleTaskViews(experimental).some((view) => view.key === key) ? key : "today";
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n) => String(n).padStart(2, "0");

/** The viewer's local day for `date` (default now). */
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayParts(day) {
  const match = DAY_RE.exec(day ?? "");
  if (!match) throw new Error(`not a day: ${day}`);
  return [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
}

function dayFromUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `day` moved by `n` calendar days. */
export function addDays(day, n) {
  const [y, m, d] = dayParts(day);
  return dayFromUtc(Date.UTC(y, m, d + n));
}

/** The day after `day`. */
export function tomorrow(day) {
  return addDays(day, 1);
}

/** The first Monday strictly after `day` — a week on when `day` is a Monday. */
export function nextMonday(day) {
  const [y, m, d] = dayParts(day);
  const weekday = new Date(Date.UTC(y, m, d)).getUTCDay();
  return addDays(day, ((8 - weekday) % 7) || 7);
}

/** The month (`YYYY-MM`) after the one `day` falls in. */
export function nextMonth(day) {
  const [y, m] = dayParts(day);
  return m === 11 ? `${y + 1}-01` : `${y}-${pad(m + 2)}`;
}

function monthName(month, withYear) {
  const match = MONTH_RE.exec(month);
  if (!match) return month;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return withYear ? `${name} ${match[1]}` : name;
}

/** "Mon 19 Oct" — a day's short label. */
export function shortDayLabel(day) {
  const [y, m, d] = dayParts(day);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m, d)).getUTCDay()];
  return `${weekday} ${d} ${MONTH_NAMES[m].slice(0, 3)}`;
}

/** A day relative to `today`: Today, Tomorrow, Yesterday, or its short label. */
export function relativeDayLabel(day, today) {
  if (day === today) return "Today";
  if (day === tomorrow(today)) return "Tomorrow";
  if (day === addDays(today, -1)) return "Yesterday";
  return shortDayLabel(day);
}

/** When a task is planned for, as a row shows it; null when unscheduled. */
export function scheduleLabel(scheduledFor, today) {
  if (!scheduledFor) return null;
  if (scheduledFor === "someday") return "Someday";
  if (DAY_RE.test(scheduledFor)) return relativeDayLabel(scheduledFor, today);
  if (MONTH_RE.test(scheduledFor)) {
    return monthName(scheduledFor, scheduledFor.slice(0, 4) !== today.slice(0, 4));
  }
  return scheduledFor;
}

/** A task's deadline as a row shows it ("Due Fri 16 Oct"); null without a due day. */
export function deadlineLabel(task, today) {
  if (!task.dueDay) return null;
  const type = task.deadline && typeof task.deadline === "object" ? task.deadline.type : null;
  const label = relativeDayLabel(task.dueDay, today);
  const when = lowerIfRelative(label);
  if (type === "on_day") return when === label ? `On ${label}` : label;
  if (type === "approximate") return `Around ${when}`;
  return `Due ${when}`;
}

/** Whether an open task's due day has passed. */
export function isOverdue(task, today) {
  return !isResolved(task) && Boolean(task.dueDay) && task.dueDay < today;
}

/** "Today" reads as "today" mid-sentence; a date stays as written. */
function lowerIfRelative(label) {
  return label === "Today" || label === "Tomorrow" || label === "Yesterday" ? label.toLowerCase() : label;
}

/** Whether a task is closed — done or struck. */
export function isResolved(task) {
  return task.state === "done" || task.state === "dismissed";
}

/**
 * The bullet a row wears, in bullet-journal terms: an open task, one
 * carried from an earlier day, one done, one struck.
 */
export function taskBullet(task) {
  if (task.state === "done") return "done";
  if (task.state === "dismissed") return "struck";
  if (task.carried) return "carried";
  return "open";
}

/**
 * The bullet a row shows while an action on it is in flight: a completion
 * shows the check and a reopen the open ring at once, so the click answers
 * before the gateway does; any other action keeps the row's own bullet.
 */
export function pendingBullet(bullet, action) {
  if (action === "complete") return "done";
  if (action === "reopen") return "open";
  return bullet;
}

/**
 * Whether a refused action already holds: completing a task the gateway
 * reports as done (a repeated click, or another device's completion) leaves
 * the task where the user wanted it, so the view reloads instead of showing
 * an error.
 */
export function actionAlreadyApplied(body, err) {
  return body?.action === "complete" && err?.code === "TASK_ALREADY_DONE";
}

/**
 * The context line under a task's title, as the mobile apps show it: each
 * item an icon, its text and a tone. Where it is planned (a calendar), or the
 * day it was carried from; its deadline (a flag) while it is open; the other
 * people it involves; what it waits on; when it closed, on the Done view; and
 * whether it came from a note. Today's page does not repeat "Today", and it
 * keeps a task resolved today to its title.
 */
export function taskMetaItems(task, view, today) {
  const items = [];
  const resolved = isResolved(task);
  const planned = scheduleLabel(task.scheduledFor, today);
  if (task.carried && !resolved) {
    items.push({
      icon: "carried",
      text: planned ? `Carried from ${lowerIfRelative(planned)}` : "Carried",
      tone: "warning",
    });
  } else if (planned && (view !== "today" || !resolved) && !(view === "today" && planned === "Today")) {
    items.push({ icon: "calendar", text: planned, tone: "neutral" });
  }
  const due = resolved ? null : deadlineLabel(task, today);
  if (due) items.push({ icon: "flag", text: due, tone: isOverdue(task, today) ? "danger" : "neutral" });
  const people = (task.actors ?? []).filter((actor) => !actor.isSelf && actor.name).map((actor) => actor.name);
  if (people.length > 0) items.push({ icon: "person", text: people.join(", "), tone: "neutral" });
  const blocker = (task.blockedBy ?? []).find((b) => b.title);
  if (blocker) items.push({ icon: "waiting", text: `Waiting on ${blocker.title}`, tone: "neutral" });
  const closed = view === "done" ? resolvedLabel(task, today) : null;
  if (closed) items.push({ icon: null, text: closed, tone: "neutral" });
  if (task.origin === "note" && !resolved) items.push({ icon: "note", text: "From a note", tone: "neutral" });
  return items;
}

/** The open tasks a view holds, as its tab counts them; History has no count. */
export function viewCount(counts, view) {
  if (view === "done") return 0;
  const count = counts?.[view];
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/** A label with its count — "Tasks (4)" — or the plain label when there is none. */
export function countLabel(label, count) {
  return count > 0 ? `${label} (${count})` : label;
}

/** The one-line proposal Omnesis made about a task, or null. */
export function proposalText(change) {
  if (!change) return null;
  const reason = (change.reason ?? "").trim();
  const lead =
    change.kind === "complete"
      ? "Omnesis thinks this is done"
      : change.kind === "strike"
        ? "Omnesis thinks this no longer applies"
        : "Omnesis suggests a change";
  const fields = change.kind === "edit" ? proposedFieldsSummary(change.fields) : "";
  const detail = [fields, reason].filter(Boolean).join(" — ");
  return detail ? `${lead}: ${detail}` : lead;
}

function proposedFieldsSummary(fields) {
  if (!fields) return "";
  const parts = [];
  if (fields.title) parts.push(`rename to “${fields.title}”`);
  if (fields.scheduledFor !== undefined) {
    parts.push(fields.scheduledFor ? `plan for ${fields.scheduledFor}` : "unschedule");
  }
  if (fields.deadline !== undefined) {
    const date = fields.deadline && typeof fields.deadline === "object" ? fields.deadline.date : null;
    parts.push(date ? `deadline ${date}` : "remove the deadline");
  }
  if (fields.description !== undefined) parts.push("update the description");
  return parts.join(", ");
}

const EVENT_LABELS = {
  created: "Added",
  accepted: "Accepted",
  ignored: "Ignored",
  // Recorded by older builds, whose refusal dismissed the suggestion.
  refused: "Dismissed",
  migrated: "Moved",
  completed: "Done",
  struck: "Struck",
  edited: "Edited",
  reopened: "Reopened",
  proposal_confirmed: "Proposal confirmed",
  proposal_kept: "Proposal declined",
  auto_applied: "Updated by Omnesis",
  auto_accepted: "Added by Omnesis",
  withheld: "Withheld by Omnesis",
  undone: "Undone",
  note: "Note",
};

/** The changes Omnesis makes on its own, whose label names it and which undo reverts in place. */
const OMNESIS_OWN_EVENTS = new Set(["auto_applied", "auto_accepted", "withheld"]);

const SURFACE_LABELS = {
  tasks: "in Tasks",
  conversation: "in a conversation",
  note: "from a note",
  brain: "by Omnesis",
};

/** One history entry as a sentence head: "Moved by Omnesis". */
export function historyEventLabel(event) {
  // A change Omnesis applied on its own names Omnesis in its own label.
  if (event.kind === "auto_applied") {
    return event.change === "complete" ? "Marked done by Omnesis" : EVENT_LABELS.auto_applied;
  }
  if (OMNESIS_OWN_EVENTS.has(event.kind)) return EVENT_LABELS[event.kind];
  const kind = EVENT_LABELS[event.kind] ?? event.kind;
  const surface = SURFACE_LABELS[event.surface];
  const move = event.kind === "migrated" && event.to ? ` to ${event.to}` : "";
  return `${kind}${move}${surface ? ` ${surface}` : ""}`;
}

/**
 * The change undo would revert, when it is one Omnesis applied on its own:
 * the newest entry of a task's history, still the change undo reverts.
 */
export function autoAppliedUndoSeq(history, undoSeq) {
  const latest = history?.[0];
  return latest && OMNESIS_OWN_EVENTS.has(latest.kind) && latest.seq === undoSeq
    ? latest.seq
    : null;
}

/**
 * An entry's note when it adds something — the ledger often restates the
 * event itself ("Done", "Created"), which the label already says.
 */
export function historyNote(event) {
  const note = (event.note ?? "").trim();
  if (!note) return null;
  const plain = note.toLowerCase().replace(/[.!]$/, "");
  const restated = [event.kind, EVENT_LABELS[event.kind]].filter(Boolean).map((v) => v.toLowerCase().replaceAll("_", " "));
  return restated.includes(plain) ? null : note;
}

/** When a resolved task was closed, as its row shows it ("Done today"). */
export function resolvedLabel(task, today) {
  if (!isResolved(task) || !task.resolvedAt) return null;
  const at = new Date(task.resolvedAt);
  if (Number.isNaN(at.getTime())) return null;
  const verb = task.state === "done" ? "Done" : "Struck";
  return `${verb} ${lowerIfRelative(relativeDayLabel(localDay(at), today))}`;
}

/**
 * A view's rows, grouped the way the journal reads them. Today keeps open
 * tasks in the gateway's newest-created-first order before resolved tasks; Month
 * groups by planned day; Future by month; the others are one flat list.
 */
export function groupTasks(view, tasks, today) {
  const rows = tasks ?? [];
  if (view === "today") {
    const groups = [
      { key: "today", label: "Today", tasks: rows.filter((t) => !isResolved(t)) },
      { key: "resolved", label: "Resolved today", tasks: rows.filter(isResolved) },
    ];
    return groups.filter((group) => group.tasks.length > 0 || group.key === "today");
  }
  if (view === "month" || view === "future") {
    const groups = new Map();
    for (const task of rows) {
      const { key, label } = view === "month" ? monthGroup(task, today) : futureGroup(task, today);
      if (!groups.has(key)) groups.set(key, { key, label, tasks: [] });
      groups.get(key).tasks.push(task);
    }
    return [...groups.values()];
  }
  return [{ key: view, label: null, tasks: rows }];
}

function plannedDay(task) {
  const schedule = task.scheduledFor;
  if (schedule && DAY_RE.test(schedule)) return schedule;
  return task.dueDay;
}

function monthGroup(task, today) {
  const day = plannedDay(task);
  if (day && DAY_RE.test(day)) return { key: day, label: relativeDayLabel(day, today) };
  return { key: "month", label: "This month" };
}

function futureGroup(task, today) {
  if (task.scheduledFor === "someday") return { key: "someday", label: "Someday" };
  const schedule = task.scheduledFor ?? task.dueDay;
  const month = schedule ? schedule.slice(0, 7) : null;
  if (month && MONTH_RE.test(month)) {
    return { key: month, label: monthName(month, month.slice(0, 4) !== today.slice(0, 4)) };
  }
  return { key: "later", label: "Later" };
}

/** What an empty view says. */
export function emptyViewMessage(view) {
  switch (view) {
    case "today": return "Nothing planned for today.";
    case "month": return "Nothing else planned this month.";
    case "future": return "Nothing planned for later months.";
    case "anytime": return "No unscheduled tasks.";
    case "waiting": return "Nothing is waiting on someone else.";
    case "suggested": return "No suggestions from Omnesis right now.";
    case "done": return "No finished tasks yet.";
    default: return "No tasks.";
  }
}

/** The quick moves a row offers, with the schedule each one sets. */
export function quickMoves(today) {
  return [
    { key: "tomorrow", label: "Tomorrow", to: tomorrow(today) },
    { key: "next-week", label: "Next week", to: nextMonday(today) },
    { key: "next-month", label: "Next month", to: nextMonth(today) },
  ];
}

/** When a suggestion can be accepted for: unscheduled, today, the quick moves, or someday. */
export function suggestionWhenOptions(today) {
  return [
    { value: "", label: "Not scheduled" },
    { value: today, label: "Today" },
    ...quickMoves(today).map((move) => ({ value: move.to, label: move.label })),
    { value: "someday", label: "Someday" },
  ];
}

/**
 * The accept action for a suggestion: planned for `when` when one is chosen,
 * and carrying what the user wrote about it, under `noteId`, when they did.
 */
export function suggestionAcceptBody({ when = "", note = "", noteId } = {}) {
  const text = note.trim();
  return {
    action: "accept",
    ...(when ? { scheduledFor: when } : {}),
    ...(text ? { note: text, noteId } : {}),
  };
}

/** How a schedule value splits into the editor's mode + value fields. */
export function scheduleEditorState(scheduledFor) {
  if (!scheduledFor) return { mode: "none", value: "" };
  if (scheduledFor === "someday") return { mode: "someday", value: "" };
  if (DAY_RE.test(scheduledFor)) return { mode: "day", value: scheduledFor };
  if (MONTH_RE.test(scheduledFor)) return { mode: "month", value: scheduledFor };
  return { mode: "none", value: "" };
}

/** The schedule the editor's fields describe; undefined when incomplete. */
export function scheduleFromEditor(mode, value) {
  if (mode === "none") return null;
  if (mode === "someday") return "someday";
  if (mode === "day") return DAY_RE.test(value) ? value : undefined;
  if (mode === "month") return MONTH_RE.test(value) ? value : undefined;
  return undefined;
}

/**
 * The `edit` action body for an editor form — only the fields that
 * changed, so an untouched deadline the agent wrote in its own shape is
 * never rewritten. Returns null when nothing changed, or `{ error }` when
 * a field is incomplete.
 */
export function editBody(task, form) {
  const body = {};
  const title = form.title.trim();
  if (!title) return { error: "A task needs a title." };
  if (title !== task.title) body.title = title;
  if (form.description !== (task.description ?? "")) body.description = form.description;
  const schedule = scheduleFromEditor(form.scheduleMode, form.scheduleValue);
  if (schedule === undefined) return { error: "Pick a day or a month, or choose another option." };
  if (schedule !== (task.scheduledFor ?? null)) body.scheduledFor = schedule;
  const currentDue = task.deadline && typeof task.deadline === "object" ? task.deadline.date ?? "" : "";
  if (form.deadline !== currentDue) {
    body.deadline = form.deadline ? { type: "by", date: form.deadline } : null;
  }
  return Object.keys(body).length > 0 ? { action: "edit", ...body } : null;
}

/** How many of a task's documents its row lists before "+N more". */
export const TASK_DOCUMENTS_SHOWN = 3;

/**
 * The documents a task's row lists, and how many it holds back: all of them
 * once the user asked for more, otherwise the first few. Holding back a
 * single document would cost as much room as listing it, so a list one
 * longer than the limit is shown whole.
 */
export function taskDocumentsShown(documents, showAll) {
  const all = Array.isArray(documents) ? documents : [];
  if (showAll || all.length <= TASK_DOCUMENTS_SHOWN + 1) return { shown: all, hidden: 0 };
  return { shown: all.slice(0, TASK_DOCUMENTS_SHOWN), hidden: all.length - TASK_DOCUMENTS_SHOWN };
}

/**
 * Whether the gateway serves "Chat about this" (`POST /tasks/:id/conversation`)
 * in the version this portal speaks, read from `/status`'s `capabilities`.
 */
export function supportsTaskConversations(capabilities) {
  const range = capabilities?.taskConversations;
  return Number.isInteger(range?.min) && Number.isInteger(range?.max) && range.min <= 1 && range.max >= 1;
}

const TASK_STATE_LABELS = { open: "Open", snoozed: "Snoozed", done: "Done", dismissed: "Struck" };

/**
 * The facts under the title of a task conversation's context card, from the
 * snapshot stamped when the conversation opened: its state, due day and how
 * many sources it had.
 */
export function taskCardFacts(snapshot, today) {
  if (!snapshot) return [];
  const facts = [TASK_STATE_LABELS[snapshot.state] ?? snapshot.state];
  if (typeof snapshot.due === "string" && DAY_RE.test(snapshot.due)) {
    facts.push(`Due ${lowerIfRelative(relativeDayLabel(snapshot.due, today))}`);
  }
  const count = Number.isInteger(snapshot.sourceCount) ? snapshot.sourceCount : 0;
  if (count > 0) facts.push(`${count} ${count === 1 ? "source" : "sources"}`);
  return facts.filter(Boolean);
}

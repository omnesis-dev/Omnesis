// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure logic for the Morning brief conversation's transcript: one group per
 * brief day (the brief and the replies after it), and the labels the thread
 * shows — the day separator, the brief's send time, the folded summary of an
 * earlier day and the "Based on N things" disclosure.
 *
 * A turn opened by a brief carries `turn.brief` (`{ day, messageId, sentAt }`,
 * set by `chatMessagesToTurns`); every turn after it belongs to that day until
 * the next brief.
 */

import { addDays, shortDayLabel } from "./tasks-model.js";

/**
 * Split the thread's turns by brief day. `preamble` holds turns loaded before
 * the first loaded brief — the tail of a day whose brief is on an earlier,
 * not yet loaded page. Each day lists its turns (the brief first) and counts
 * the user's replies in it.
 */
export function groupBriefDays(turns) {
  const preamble = [];
  const days = [];
  for (const turn of turns ?? []) {
    if (turn?.brief) {
      days.push({
        day: turn.brief.day,
        messageId: turn.brief.messageId,
        sentAt: turn.brief.sentAt ?? null,
        turns: [turn],
        replies: 0,
      });
      continue;
    }
    const current = days.at(-1);
    if (!current) {
      preamble.push(turn);
      continue;
    }
    current.turns.push(turn);
    if (turn?.role === "user") current.replies += 1;
  }
  return { preamble, days };
}

/** The separator's label: Today, Yesterday, else e.g. "Tue 13 Oct". */
export function briefDayLabel(day, today) {
  if (day === today) return "Today";
  try {
    if (day === addDays(today, -1)) return "Yesterday";
    return shortDayLabel(day);
  } catch {
    return day;
  }
}

const pad = (n) => String(n).padStart(2, "0");

/** The brief's local send time ("07:02"), or null when it was not recorded. */
export function briefTimeLabel(sentAt) {
  if (typeof sentAt !== "string") return null;
  const at = new Date(sentAt);
  if (Number.isNaN(at.getTime())) return null;
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The one line a folded earlier day shows: "Morning brief · 5 things ·
 * 2 replies". The item count appears once it is known; a day without replies
 * says nothing about them.
 */
export function foldedDaySummary({ itemCount = null, replies = 0 } = {}) {
  const parts = ["Morning brief"];
  if (Number.isInteger(itemCount)) parts.push(plural(itemCount, "thing", "things"));
  if (replies > 0) parts.push(plural(replies, "reply", "replies"));
  return parts.join(" · ");
}

/** The footer disclosure's label. */
export function basedOnLabel(itemCount) {
  return `Based on ${plural(itemCount, "thing", "things")}`;
}

/** The Tasks view, opened on one task. */
export function taskHref(taskId) {
  return `/portal/tasks?task=${encodeURIComponent(taskId)}`;
}

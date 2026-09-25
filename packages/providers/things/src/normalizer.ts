// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { RawThingsTask, RawThingsChecklistItem } from "./types.js";

const STATUS_LABELS: Record<number, string> = {
  0: "Open",
  2: "Canceled",
  3: "Completed",
};

/**
 * Decode a Things bit-packed date integer to a `YYYY-MM-DD` calendar-date
 * string.
 *
 * Things stores `startDate` and `deadline` as the wall-clock date the user
 * typed, with no timezone. Returning a `YYYY-MM-DD` string keeps that
 * contract — consumers who want a `Date` object must construct it
 * timezone-aware (`new Date("YYYY-MM-DD")` parses as UTC midnight in
 * Node, which is fine for display but wrong if the consumer then does
 * `.toLocaleDateString()` in a non-UTC zone).
 *
 * Encoding: `year << 16 | month << 12 | day << 7`.
 */
export function thingsDateToString(value: number): string {
  const year = value >> 16;
  const month = (value >> 12) & 0xf;
  const day = (value >> 7) & 0x1f;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Convert a Unix timestamp (seconds) to ISO string.
 */
export function unixToISO(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Normalize a Things task into an Omnesis DocumentInput.
 */
export function normalizeTask(
  task: RawThingsTask,
  checklist: RawThingsChecklistItem[],
  projectTitle: string | null,
  areaTitle: string | null,
  providerId: ProviderId,
  sourceId: SourceId,
  taskTags: string[] = [],
): DocumentInput {
  const title = task.title || "Untitled";
  const lines: string[] = [];
  lines.push(`# ${title}`);

  if (task.notes) {
    lines.push("", task.notes);
  }

  // Checklist
  if (checklist.length > 0) {
    lines.push("", "## Checklist");
    for (const item of checklist) {
      const check = item.status === 3 ? "x" : " ";
      lines.push(`- [${check}] ${item.title}`);
    }
  }

  // First-class typed dates promoted from the source's bit-packed integers.
  // `scheduledAt` (the planned "Scheduled" start) and `dueAt` (the hard
  // "Deadline") are the generic, queryable promotion of these dates; the same
  // values are rendered into the prose and mirrored into `extra` below for
  // display. Things dates are wall-clock calendar days with no time, so these
  // carry the date-only ISO form (`YYYY-MM-DD`) — a valid ISO 8601 value that
  // preserves the "no timezone" contract (see `thingsDateToString`).
  const scheduledAt =
    task.startDate && task.startDate > 0 ? thingsDateToString(task.startDate) : undefined;
  const dueAt = task.deadline && task.deadline > 0 ? thingsDateToString(task.deadline) : undefined;

  // Metadata line
  const details: string[] = [];
  const statusLabel = STATUS_LABELS[task.status] ?? `Status ${task.status}`;
  details.push(`Status: ${statusLabel}`);

  if (dueAt) {
    details.push(`Deadline: ${dueAt}`);
  }
  if (scheduledAt) {
    details.push(`Scheduled: ${scheduledAt}`);
  }
  if (projectTitle) {
    details.push(`Project: ${projectTitle}`);
  }
  if (areaTitle) {
    details.push(`Area: ${areaTitle}`);
  }

  // Per-task tags from TMTag (independent of TMArea). Things stores them
  // as their own first-class objects; the source previously dropped them
  // entirely so `tags:Important` filters never matched.
  const normalizedTags = Array.from(
    new Set(
      taskTags.map((t) => t.replace(/^#+/, "").trim().toLowerCase()).filter((t) => t.length > 0),
    ),
  );

  if (normalizedTags.length > 0) {
    details.push(`Tags: ${normalizedTags.map((t) => `#${t}`).join(" ")}`);
  }

  if (details.length > 0) {
    lines.push("", details.join(" | "));
  }

  const content = lines.join("\n");

  // Tags array combines area + per-task tags, deduped, area first to
  // preserve the existing "area as primary tag" UX.
  const allTags: string[] = [];
  if (areaTitle) allTags.push(areaTitle);
  for (const tag of normalizedTags) {
    if (!allTags.includes(tag)) allTags.push(tag);
  }

  return {
    providerId,
    sourceId: sourceId,
    externalId: task.uuid,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      sourceUrl: `things:///show?id=${task.uuid}`,
      documentType: task.type === 1 ? "project" : "task",
      scheduledAt,
      dueAt,
      status: statusLabel.toLowerCase(),
      tags: allTags.length > 0 ? allTags : undefined,
      // Things has no per-task author — single-user-per-DB. We mark every doc as
      // self-authored via the isSelf primitive; the gateway resolves to whoever
      // is the canonical self person at write time.
      people: [{ role: "author", isSelf: true }],
      extra: {
        status: statusLabel.toLowerCase(),
        project: projectTitle ?? undefined,
        area: areaTitle ?? undefined,
        hashtags: normalizedTags.length > 0 ? normalizedTags : undefined,
        deadline: dueAt,
        scheduled: scheduledAt,
        isProject: task.type === 1,
        checklistTotal: checklist.length || undefined,
        checklistDone: checklist.filter((c) => c.status === 3).length || undefined,
      },
    },
    sourceCreatedAt: unixToISO(task.creationDate),
    sourceUpdatedAt: unixToISO(task.userModificationDate),
  };
}

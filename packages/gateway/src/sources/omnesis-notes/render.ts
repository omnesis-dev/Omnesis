// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure projection: one day's `note_entries` → the title + markdown body
 * of that day's corpus document. Deterministic given the same entries —
 * the upserter re-renders on every ledger mutation and relies on the
 * content hash only changing when the rendered text does.
 *
 * Body shape: one `## HH:MM` section per entry (gateway-local capture
 * time, with an ` · <surface>` suffix when the capture surface is known
 * and an ` · <place>` suffix when the note was geotagged), followed by
 * the note text verbatim. Folding the place name into the heading (not
 * a separate metadata field) is what makes a note retrievable by where
 * it was spoken — the day document is the search unit.
 */

import { localHourMinute } from "./day.js";
import type { NoteEntry } from "./storage.js";
import type { NoteCaptureContext } from "@omnesis/types";

export interface RenderedNotesDay {
  title: string;
  body: string;
}

/**
 * The capturing principal's name as the day document shows it, in the entry
 * heading and in the document's people: inner whitespace collapsed so a
 * client-registered name cannot smuggle a line break into a heading.
 */
export function principalDisplayName(context: NoteCaptureContext): string {
  return context.principalName.replace(/\s+/g, " ").trim();
}

/** Render a day's entries. Callers pass them in capture order. */
export function renderNotesDay(day: string, entries: readonly NoteEntry[]): RenderedNotesDay {
  const sections = entries.map((entry) => {
    const surfaceSuffix = entry.surface ? ` · ${entry.surface}` : "";
    const principalSuffix = entry.captureContext
      ? ` · ${principalDisplayName(entry.captureContext)}`
      : "";
    const placeSuffix = entry.placeName ? ` · ${entry.placeName}` : "";
    return `## ${localHourMinute(entry.capturedAt, entry.capturedUtcOffsetSeconds)}${surfaceSuffix}${principalSuffix}${placeSuffix}\n\n${entry.text}`;
  });
  return {
    title: `Notes — ${day}`,
    body: sections.join("\n\n"),
  };
}

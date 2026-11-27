// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Suggestions for a recorded conversation: who took part and what it was.
 * Never applied on their own — the owner accepts or dismisses each one.
 *
 * An event on the owner's calendar that overlaps the recording offers its
 * attendees as likely participants — for an unnamed speaker or as present
 * without a turn — and its title as the recording's title.
 * Names are not guessed from the transcript: in speech, the words a sentence
 * opens or closes with are mostly fillers ("Beh, …", "…, cioè."), not names.
 *
 * Pure functions over what the service reads; the service owns the reads.
 */

/** An event on the owner's calendar that overlaps a recording. */
export interface CalendarEventCandidate {
  documentId: string;
  title: string;
  /** ISO-8601 instants; `end` exclusive. */
  start: string;
  end: string;
  /** Who was invited, the owner left out. */
  attendees: Array<{ personId: string; name: string }>;
}

export type RecordingSuggestion =
  | {
      key: string;
      kind: "title";
      source: "calendar";
      title: string;
      /** The calendar event's document. */
      documentId: string;
    }
  | {
      key: string;
      kind: "person";
      source: "calendar";
      /** An attendee is offered for any unnamed speaker or as present without a turn. */
      speaker: null;
      personId: string;
      name: string;
      /** Why: the event's title. */
      evidence: string;
    };

/** What the suggestions are built against. */
export interface SuggestionContext {
  /** The recording's own title, null when the device gave none. */
  title: string | null;
  events: readonly CalendarEventCandidate[];
  /** People already mapped to a speaker of this recording. */
  mappedPeople: ReadonlySet<string>;
  /** People the owner already said were present without a turn. */
  presentPeople?: ReadonlySet<string>;
  /** Keys the owner dismissed. */
  dismissed: ReadonlySet<string>;
}

/** Events beyond this many overlapping a recording add nothing worth reading. */
const MAX_EVENTS = 3;

const personKey = (personId: string) => `person:${personId}`;

/**
 * Everything worth offering for a recording: the title, then calendar
 * attendees. Nothing already true, already mapped or dismissed is offered.
 */
export function buildSuggestions(context: SuggestionContext): RecordingSuggestion[] {
  const out: RecordingSuggestion[] = [];
  const events = context.events.slice(0, MAX_EVENTS);
  const attendees = new Map<string, { name: string; event: string }>();
  for (const event of events) {
    for (const a of event.attendees) {
      if (!attendees.has(a.personId))
        attendees.set(a.personId, { name: a.name, event: event.title });
    }
  }

  // Title: the event that overlaps the recording most, when the device gave
  // no title of its own or a different one.
  const best = events[0];
  if (best && best.title.trim()) {
    const key = `title:${best.documentId}`;
    if (best.title.trim() !== context.title?.trim() && !context.dismissed.has(key)) {
      out.push({
        key,
        kind: "title",
        source: "calendar",
        title: best.title.trim(),
        documentId: best.documentId,
      });
    }
  }

  // Attendees not already mapped to a speaker or marked present.
  for (const [personId, a] of attendees) {
    const key = personKey(personId);
    if (context.mappedPeople.has(personId) || context.presentPeople?.has(personId)) continue;
    if (context.dismissed.has(key)) continue;
    out.push({
      key,
      kind: "person",
      source: "calendar",
      speaker: null,
      personId,
      name: a.name,
      evidence: a.event,
    });
  }
  return out;
}

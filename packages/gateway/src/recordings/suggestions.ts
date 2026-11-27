// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Suggestions for a recorded conversation: who took part and what it was.
 * Never applied on their own — the owner accepts or dismisses each one.
 *
 *   - Calendar. An event on the owner's calendar that overlaps the recording
 *     offers its attendees as likely participants — for a speaker, or as
 *     present without a turn of their own — and its title as the recording's
 *     title.
 *   - Mentions. A name addressed in the transcript ("thanks, Jamie",
 *     "Jamie, can you…") is offered for the speaker who answers: the next
 *     turn by another voice.
 *
 * Pure functions over what the service reads; the service owns the reads.
 */

/** One stretch of speech by one speaker, in recording order. */
export interface SuggestionTurn {
  speaker?: number;
  text: string;
}

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

/** Who a name heard in the transcript could be. */
export type NameResolution =
  /** Exactly one person goes by it. */
  | { kind: "person"; personId: string; name: string }
  /** Nobody, or several people: offered as a plain name. */
  | { kind: "name" };

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
      source: "calendar" | "mention";
      /**
       * The speaker it is offered for; null for an attendee, offered for any
       * unnamed speaker or as present without a turn.
       */
      speaker: number | null;
      /** The person, when exactly one goes by the name; null offers the plain name. */
      personId: string | null;
      name: string;
      /** Why: the event's title, or the line the name was heard in. */
      evidence: string;
    };

/** What the suggestions are built against. */
export interface SuggestionContext {
  /** The recording's own title, null when the device gave none. */
  title: string | null;
  turns: readonly SuggestionTurn[];
  events: readonly CalendarEventCandidate[];
  /** Speakers the owner has already said who they are. */
  namedSpeakers: ReadonlySet<number>;
  /** People already mapped to a speaker of this recording. */
  mappedPeople: ReadonlySet<string>;
  /** People the owner already said were present without a turn. */
  presentPeople?: ReadonlySet<string>;
  /** Keys the owner dismissed. */
  dismissed: ReadonlySet<string>;
  /** Who a name addressed in the transcript is. */
  resolveName: (name: string) => NameResolution;
}

/** Events beyond this many overlapping a recording add nothing worth reading. */
const MAX_EVENTS = 3;
/** Lines quoted as evidence are cut to this. */
const EVIDENCE_CHARS = 120;

/**
 * Words that open or close a sentence the way a name does, but are not one.
 * Lower-case; English and the other languages a recording is likely in.
 */
const NOT_NAMES = new Set([
  "i",
  "ok",
  "okay",
  "yes",
  "yeah",
  "no",
  "nope",
  "so",
  "well",
  "right",
  "now",
  "then",
  "thanks",
  "thank",
  "please",
  "sorry",
  "hi",
  "hey",
  "hello",
  "bye",
  "goodbye",
  "sure",
  "great",
  "good",
  "fine",
  "cool",
  "wait",
  "look",
  "listen",
  "anyway",
  "actually",
  "everyone",
  "everybody",
  "guys",
  "folks",
  "all",
  "team",
  "sir",
  "madam",
  "mum",
  "mom",
  "dad",
  "honey",
  "dear",
  "today",
  "tomorrow",
  "yesterday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "and",
  "but",
  "or",
  "also",
  "ciao",
  "grazie",
  "allora",
  "bene",
  "certo",
  "prego",
  "scusa",
  "merci",
  "oui",
  "non",
  "danke",
  "ja",
  "nein",
  "gracias",
  "hola",
  "sí",
  "si",
  "vale",
]);

/** Greetings and thanks that a name follows without a comma: "thanks Jamie". */
const LEAD_INS =
  /^(?:thanks|thank you|thx|cheers|hi|hey|hello|bye|morning|ciao|grazie|merci|danke|gracias|hola)\s*,?\s+/i;

/** A capitalised word that could be a given name. */
const NAME = /^\p{Lu}[\p{Ll}'’-]{1,30}$/u;

function asName(word: string | undefined): string | null {
  if (!word) return null;
  const trimmed = word.replace(/[.!?…]+$/u, "");
  if (!NAME.test(trimmed)) return null;
  if (NOT_NAMES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/** The sentences of a turn, each with its closing punctuation. */
function sentences(text: string): string[] {
  return (text.match(/[^.!?…]+[.!?…]*/gu) ?? []).map((s) => s.trim()).filter(Boolean);
}

/**
 * The names a sentence addresses someone by: a name set off by a comma at its
 * start ("Jamie, can you…") or end ("thanks, Jamie."), or one following a
 * greeting or thanks ("thanks Jamie"). A name in the middle of a sentence is
 * talked about, not to.
 */
export function addressedNames(sentence: string): string[] {
  const found = new Set<string>();
  const body = sentence.replace(/[.!?…]+$/u, "").trim();
  const words = body.split(/\s+/u);

  const start = /^([^\s,]+),/u.exec(body);
  const atStart = asName(start?.[1]);
  if (atStart) found.add(atStart);

  const end = /,\s*([^\s,]+)$/u.exec(body);
  const atEnd = asName(end?.[1]);
  if (atEnd) found.add(atEnd);

  const lead = LEAD_INS.exec(body);
  if (lead) {
    const next = asName(body.slice(lead[0].length).split(/[\s,]+/u)[0]);
    if (next) found.add(next);
  }
  // A one-word sentence that is a name is a call: "Jamie?"
  if (words.length === 1) {
    const only = asName(words[0]);
    if (only) found.add(only);
  }
  return [...found];
}

function quote(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > EVIDENCE_CHARS ? `${flat.slice(0, EVIDENCE_CHARS - 1)}…` : flat;
}

/** The speaker of the first turn after `index` by another voice, if any. */
function answerer(turns: readonly SuggestionTurn[], index: number): number | undefined {
  const own = turns[index]?.speaker;
  for (let i = index + 1; i < turns.length; i += 1) {
    const speaker = turns[i]!.speaker;
    if (speaker !== undefined && speaker !== own) return speaker;
  }
  return undefined;
}

const personKey = (personId: string) => `person:${personId}`;
const mentionKey = (speaker: number, who: string) => `mention:${speaker}:${who}`;

/**
 * Everything worth offering for a recording, most telling first: the title,
 * then names heard in the transcript (tied to a speaker), then calendar
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

  // Mentions: each name once per speaker who answers it.
  const offered = new Set<string>();
  context.turns.forEach((turn, index) => {
    for (const sentence of sentences(turn.text)) {
      for (const heard of addressedNames(sentence)) {
        const speaker = answerer(context.turns, index);
        if (speaker === undefined || context.namedSpeakers.has(speaker)) continue;
        let resolved = context.resolveName(heard);
        if (resolved.kind === "name") {
          // Several people by that name: an attendee of the meeting is the one.
          const attendee = [...attendees].filter(
            ([, a]) => a.name.split(/\s+/u)[0]?.toLowerCase() === heard.toLowerCase(),
          );
          if (attendee.length === 1) {
            const [personId, a] = attendee[0]!;
            resolved = { kind: "person", personId, name: a.name };
          }
        }
        if (resolved.kind === "person" && context.mappedPeople.has(resolved.personId)) continue;
        const who = resolved.kind === "person" ? resolved.personId : heard.toLowerCase();
        const key = mentionKey(speaker, who);
        if (offered.has(key) || context.dismissed.has(key)) continue;
        offered.add(key);
        out.push({
          key,
          kind: "person",
          source: "mention",
          speaker,
          personId: resolved.kind === "person" ? resolved.personId : null,
          name: resolved.kind === "person" ? resolved.name : heard,
          evidence: quote(sentence),
        });
      }
    }
  });

  // Attendees not already offered for a speaker, mapped to one, or present.
  const mentioned = new Set(
    out.flatMap((s) => (s.kind === "person" && s.personId ? [s.personId] : [])),
  );
  for (const [personId, a] of attendees) {
    const key = personKey(personId);
    if (context.mappedPeople.has(personId) || mentioned.has(personId)) continue;
    if (context.presentPeople?.has(personId)) continue;
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

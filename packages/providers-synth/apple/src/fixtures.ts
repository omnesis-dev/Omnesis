// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  getPerson,
  resolvePerson,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import { deriveAttachmentStableId } from "@omnesis/core";
import { parseSourceId } from "@omnesis/types";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";

// ── Notes ──────────────────────────────────────────────────────────

interface NoteEntry {
  externalId: string;
  title: string;
  body: string;
  folder: string;
  createdAt: string;
  modifiedAt: string;
}
let notesCache: NoteEntry[] | null = null;
export function loadNotes(): NoteEntry[] {
  if (notesCache) return notesCache;
  notesCache = loadSourceFixtureJson<NoteEntry[]>(
    loadActiveUniverse(),
    "apple-notes",
    "notes.json",
  );
  return notesCache;
}
export function mapNote(
  e: NoteEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.title,
    content: e.body,
    contentHash: sha256Hex(`${e.externalId}:${e.body}:${e.modifiedAt}`),
    metadata: {
      documentType: "note",
      people: [personMention("self", "author")],
      extra: { folder: e.folder },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.modifiedAt,
  };
}

// ── Reminders ───────────────────────────────────────────────────────

interface ReminderEntry {
  externalId: string;
  title: string;
  list: string;
  dueAt: string | null;
  completed: boolean;
  createdAt: string;
}
let remindersCache: ReminderEntry[] | null = null;
export function loadReminders(): ReminderEntry[] {
  if (remindersCache) return remindersCache;
  remindersCache = loadSourceFixtureJson<ReminderEntry[]>(
    loadActiveUniverse(),
    "apple-reminders",
    "reminders.json",
  );
  return remindersCache;
}
export function mapReminder(
  e: ReminderEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const content = `${e.title}\n\nList: ${e.list}` + (e.dueAt ? `\nDue: ${e.dueAt}` : "");
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.title,
    content,
    contentHash: sha256Hex(`${e.externalId}:${e.title}:${e.dueAt}:${e.completed}`),
    metadata: {
      documentType: "reminder",
      dueAt: e.dueAt ?? undefined,
      status: e.completed ? "completed" : "open",
      people: [personMention("self", "author")],
      extra: {
        list: e.list,
        completed: e.completed,
        dueAt: e.dueAt,
      },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.createdAt,
  };
}

// ── iMessage ────────────────────────────────────────────────────────

interface ChatMessage {
  from: string;
  at: string;
  text: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}
interface DailyChatEntry {
  externalId: string;
  chatId: string;
  chatTitle: string;
  date: string;
  counterparty: string;
  messages: ChatMessage[];
}
let chatsCache: DailyChatEntry[] | null = null;
export function loadChats(): DailyChatEntry[] {
  if (chatsCache) return chatsCache;
  chatsCache = loadSourceFixtureJson<DailyChatEntry[]>(
    loadActiveUniverse(),
    "apple-imessage",
    "messages.json",
  );
  return chatsCache;
}
export function mapChat(
  e: DailyChatEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput[] {
  const lines = e.messages.map((m) => {
    const speaker = m.from === "self" ? "You" : e.chatTitle;
    return `[${m.at.slice(11, 16)}] ${speaker}: ${m.text}`;
  });
  const content = `# ${e.chatTitle} — ${e.date}\n\n${lines.join("\n")}`;
  const people: PersonMention[] = [
    personMention("self", "participant"),
    personMention(e.counterparty, "participant"),
  ];
  const firstAt = e.messages[0]?.at ?? `${e.date}T00:00:00Z`;
  const lastAt = e.messages[e.messages.length - 1]?.at ?? firstAt;
  const dayDocument: DocumentInput = {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: `${e.chatTitle} — ${e.date}`,
    content,
    contentHash: sha256Hex(`${e.externalId}:${content}`),
    metadata: {
      documentType: "conversation",
      people,
      extra: {
        chatId: e.chatId,
        date: e.date,
        messageCount: e.messages.length,
      },
    },
    sourceCreatedAt: firstAt,
    sourceUpdatedAt: lastAt,
  };
  const attachmentDocuments = e.messages.flatMap((message) =>
    (message.attachments ?? []).map((attachment): DocumentInput => {
      const stableId = deriveAttachmentStableId(
        attachment.filename,
        attachment.sizeBytes,
        attachment.mimeType,
      );
      return {
        sourceId: ctx.sourceId,
        providerId: ctx.providerId,
        externalId: `${e.externalId}/att/${stableId}`,
        title: attachment.filename,
        content: `${attachment.filename} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
        contentHash: sha256Hex(
          `${stableId}:${attachment.filename}:${attachment.mimeType}:${attachment.sizeBytes}`,
        ),
        metadata: {
          documentType: "attachment",
          people,
          extra: {
            parentExternalId: e.externalId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        },
        sourceCreatedAt: message.at,
        sourceUpdatedAt: message.at,
      };
    }),
  );
  return [dayDocument, ...attachmentDocuments];
}

// ── Contacts ────────────────────────────────────────────────────────

interface ContactEntry {
  externalId: string;
  personRef: string;
  givenName: string;
  familyName: string | null;
  company: string | null;
  title: string | null;
  createdAt: string;
  modifiedAt: string;
}
let contactsCache: ContactEntry[] | null = null;
export function loadContacts(): ContactEntry[] {
  if (contactsCache) return contactsCache;
  contactsCache = loadSourceFixtureJson<ContactEntry[]>(
    loadActiveUniverse(),
    "apple-contacts",
    "contacts.json",
  );
  return contactsCache;
}
export function mapContact(
  e: ContactEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const person = getPerson(e.personRef);
  const resolved = resolvePerson(e.personRef);
  const fullName = [e.givenName, e.familyName].filter(Boolean).join(" ");
  const lines = [
    `# ${fullName}`,
    e.company ? `Company: ${e.company}` : null,
    e.title ? `Title: ${e.title}` : null,
    resolved.emails.length ? `Email: ${resolved.emails.join(", ")}` : null,
    resolved.phones.length ? `Phone: ${resolved.phones.join(", ")}` : null,
  ].filter(Boolean);
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: fullName,
    content: lines.join("\n"),
    contentHash: sha256Hex(`${e.externalId}:${fullName}:${e.modifiedAt}`),
    metadata: {
      documentType: "contact",
      people: [{ ...personMention(e.personRef, "contact") }],
      extra: {
        company: e.company,
        title: e.title,
        canonicalName: person.name,
      },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.modifiedAt,
  };
}

// ── Calendar ────────────────────────────────────────────────────────

export interface CalendarEventEntry {
  externalId: string;
  title: string;
  description: string;
  location: string;
  calendarName: string;
  allDay?: boolean;
  startTime: string;
  endTime: string;
  attendees: string[];
  attendeeEmails: string[];
  createdAt: string;
  updatedAt: string;
  calendarId?: string;
  iCalUID?: string;
  recurring?: boolean;
  temporalProjectionEligible?: boolean;
  organizerEmail?: string;
  status?: string;
}
let calendarEventsCache: CalendarEventEntry[] | null = null;
export function loadCalendarEvents(): CalendarEventEntry[] {
  if (calendarEventsCache) return calendarEventsCache;
  calendarEventsCache = loadSourceFixtureJson<CalendarEventEntry[]>(
    loadActiveUniverse(),
    "apple-calendar",
    "events.json",
  );
  return calendarEventsCache;
}
// ── Call Log ────────────────────────────────────────────────────────

interface CallEntry {
  id?: string;
  time: string;
  direction: "incoming" | "outgoing";
  medium: "phone" | "facetime";
  durationSeconds: number;
  connected: boolean;
  /** Cast personRef for the peer (resolved via `getPerson`/`resolvePerson`), or null if unidentifiable. */
  counterparty: string | null;
}
interface DailyCallLogEntry {
  externalId: string;
  date: string;
  calls: CallEntry[];
}
let callLogCache: DailyCallLogEntry[] | null = null;
export function loadCallLog(): DailyCallLogEntry[] {
  if (callLogCache) return callLogCache;
  callLogCache = loadSourceFixtureJson<DailyCallLogEntry[]>(
    loadActiveUniverse(),
    "apple-call-log",
    "calls.json",
  );
  return callLogCache;
}

function formatCallDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Match production identity semantics: self is this source's account only. */
function appleSelfParticipant(sourceId: SourceId): PersonMention[] {
  const { accountId } = parseSourceId(sourceId);
  return accountId.includes("@") ? [{ role: "participant", emails: [accountId] }] : [];
}

export function mapCallLog(
  e: DailyCallLogEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const lines: string[] = [`# Calls — ${e.date}`, ""];
  let totalDuration = 0;
  const people = appleSelfParticipant(ctx.sourceId);
  const seenPeers = new Set<string>();
  const calls: Record<string, unknown>[] = [];

  for (const call of e.calls) {
    const time = call.time.slice(11, 16);
    const outgoing = call.direction === "outgoing";
    const medium = call.medium === "facetime" ? "FaceTime" : "Phone";
    const label = call.counterparty ? getPerson(call.counterparty).name : "Unknown";
    const arrow = outgoing ? "→" : "←";
    const direction = outgoing ? "Outgoing" : "Incoming";
    let qualifier: string;
    if (call.connected) {
      qualifier = `, ${formatCallDuration(call.durationSeconds)}`;
      totalDuration += call.durationSeconds;
    } else {
      qualifier = outgoing ? " (no answer)" : ", missed";
    }
    lines.push(`- ${time} ${direction} ${medium} ${arrow} ${label}${qualifier}`);

    if (call.counterparty && !seenPeers.has(call.counterparty)) {
      seenPeers.add(call.counterparty);
      people.push(personMention(call.counterparty, "participant"));
    }

    calls.push({
      time: call.time,
      direction: call.direction,
      medium: call.medium,
      durationSeconds: call.durationSeconds,
      connected: call.connected,
      peer: call.counterparty ? (resolvePerson(call.counterparty).phones[0] ?? null) : null,
    });
  }

  lines.splice(
    2,
    0,
    `**Total:** ${e.calls.length} call${e.calls.length === 1 ? "" : "s"}, ${formatCallDuration(totalDuration)}`,
    "",
  );
  const content = lines.join("\n");

  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: `Calls — ${e.date}`,
    content,
    contentHash: sha256Hex(`${e.externalId}:${content}`),
    metadata: {
      documentType: "call-log",
      rollingAggregate: true,
      people,
      extra: {
        date: e.date,
        callCount: e.calls.length,
        totalDurationSeconds: totalDuration,
        calls,
      },
    },
    sourceCreatedAt: `${e.date}T00:00:00.000Z`,
    sourceUpdatedAt: `${e.date}T23:59:59.999Z`,
  };
}

/** Structured twin of the synthetic day documents: one row per raw call. */
export function mapCallLogRecords(entries: DailyCallLogEntry[]): Record<string, unknown>[] {
  return entries.flatMap((entry) =>
    entry.calls.map((call) => {
      const peer = call.counterparty ? resolvePerson(call.counterparty) : null;
      return {
        id:
          call.id ??
          sha256Hex(
            `${entry.externalId}:${call.time}:${call.direction}:${call.medium}:${call.durationSeconds}:${call.counterparty ?? "unknown"}`,
          ).slice(0, 32),
        date: entry.date,
        time: call.time,
        direction: call.direction,
        medium: call.medium,
        duration_seconds: call.durationSeconds,
        connected: call.connected,
        counterparty: peer?.phones[0] ?? peer?.emails[0] ?? "unknown",
        counterparty_name: call.counterparty ? getPerson(call.counterparty).name : null,
      };
    }),
  );
}

// ── Voicemail ────────────────────────────────────────────────

interface VoicemailEntry {
  id: string;
  time: string;
  durationSeconds: number;
  transcript: string;
  /** Cast personRef for the caller, or null when Apple could not identify one. */
  caller: string | null;
}

interface DailyVoicemailEntry {
  externalId: string;
  date: string;
  voicemails: VoicemailEntry[];
}

let voicemailCache: DailyVoicemailEntry[] | null = null;
export function loadVoicemails(): DailyVoicemailEntry[] {
  if (voicemailCache) return voicemailCache;
  voicemailCache = loadSourceFixtureJson<DailyVoicemailEntry[]>(
    loadActiveUniverse(),
    "apple-voicemail",
    "voicemails.json",
  );
  return voicemailCache;
}

function formatVoicemailDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

export function mapVoicemail(
  entry: DailyVoicemailEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const people = appleSelfParticipant(ctx.sourceId);
  const seenCallers = new Set<string>();
  const voicemailMetadata: Record<string, unknown>[] = [];
  let totalDurationSeconds = 0;

  const lines = [`# Voicemail — ${entry.date}`, ""];
  for (const voicemail of entry.voicemails) {
    const callerPhone = voicemail.caller
      ? (resolvePerson(voicemail.caller).phones[0] ?? null)
      : null;
    totalDurationSeconds += voicemail.durationSeconds;
    lines.push(
      `## ${voicemail.time.slice(11, 16)} — ${callerPhone ?? "Unknown caller"} (${formatVoicemailDuration(voicemail.durationSeconds)})`,
      "",
      voicemail.transcript,
      "",
    );

    if (callerPhone && !seenCallers.has(callerPhone)) {
      seenCallers.add(callerPhone);
      people.push({ role: "participant", phones: [callerPhone] });
    }

    voicemailMetadata.push({
      id: voicemail.id,
      time: voicemail.time,
      durationSeconds: voicemail.durationSeconds,
      caller: callerPhone,
      hasTranscript: voicemail.transcript.length > 0,
    });
  }

  const content = lines.join("\n").trimEnd();
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: entry.externalId,
    title: `Voicemail — ${entry.date}`,
    content,
    contentHash: sha256Hex(`${entry.externalId}:${content}`),
    metadata: {
      documentType: "voicemail",
      rollingAggregate: true,
      people,
      tags: [],
      extra: {
        date: entry.date,
        voicemailCount: entry.voicemails.length,
        totalDurationSeconds,
        transcriptCount: entry.voicemails.filter((voicemail) => voicemail.transcript.length > 0)
          .length,
        voicemails: voicemailMetadata,
      },
    },
    sourceCreatedAt: entry.voicemails[0]?.time ?? `${entry.date}T00:00:00.000Z`,
    sourceUpdatedAt:
      entry.voicemails[entry.voicemails.length - 1]?.time ?? `${entry.date}T23:59:59.999Z`,
  };
}

export function mapCalendarEvent(
  e: CalendarEventEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const people: PersonMention[] = e.attendees.map((ref, i) => ({
    ...personMention(ref, "attendee"),
    emails: [e.attendeeEmails[i]],
  }));
  const when = e.allDay
    ? `${e.startTime.slice(0, 10)} → ${e.endTime.slice(0, 10)}`
    : `${e.startTime} → ${e.endTime}`;
  const content = `# ${e.title}\n\n**Calendar:** ${e.calendarName}\n**When:** ${when}\n**Location:** ${e.location}\n\n${e.description}`;
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.title,
    content,
    contentHash: sha256Hex(`${e.externalId}:${e.title}:${e.startTime}:${e.endTime}`),
    metadata: {
      documentType: "event",
      people,
      extra: {
        calendarName: e.calendarName,
        location: e.location,
        start: e.allDay ? e.startTime.slice(0, 10) : e.startTime,
        end: e.allDay ? e.endTime.slice(0, 10) : e.endTime,
        allDay: !!e.allDay,
      },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.updatedAt,
  };
}

/**
 * Structured twin of {@link mapCalendarEvent}. Universe fixtures enumerate
 * concrete event instances rather than recurrence masters, so they are safe
 * to materialize as deterministic temporal projections by default.
 */
export function mapCalendarEventRecord(e: CalendarEventEntry): Record<string, unknown> {
  const allDay = e.allDay ?? false;
  const startMs = Date.parse(e.startTime);
  const endMs = Date.parse(e.endTime);
  const durationMinutes =
    !allDay && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
      ? (endMs - startMs) / 60_000
      : null;
  const attendeeEmails = new Set(
    e.attendeeEmails.map((email) => email.trim().toLowerCase()).filter(Boolean),
  );

  return {
    id: e.externalId,
    calendar_id: e.calendarId ?? `synth-${e.calendarName.toLowerCase().replaceAll(" ", "-")}`,
    calendar_name: e.calendarName,
    ical_uid: e.iCalUID ?? `${e.externalId}@calendar.example`,
    title: e.title,
    start_time: e.startTime,
    end_time: e.endTime,
    duration_minutes: durationMinutes,
    all_day: allDay,
    recurring: e.recurring ?? false,
    temporal_projection_eligible: e.temporalProjectionEligible ?? true,
    organizer_email: e.organizerEmail ?? e.attendeeEmails[0] ?? null,
    attendee_count: attendeeEmails.size || null,
    response_status: null,
    location: e.location || null,
    status: e.status ?? "confirmed",
  };
}

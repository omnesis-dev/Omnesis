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
import {
  buildAttachmentDocument,
  formatAttachmentMarkers,
  type AttachmentInfo,
} from "@omnesis/core";
import {
  type DocumentInput,
  type PersonMention,
  type ProviderId,
  type SourceId,
} from "@omnesis/types";

// ── Gmail ─────────────────────────────────────────────────────────

// Mirror the real Gmail source's URL format so synth-ingested fixtures
// flow through the same code paths (canonicalizer, "open in source")
// as production messages.
function gmailSourceUrl(externalId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${externalId}`;
}

interface GmailAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
}

export interface EmailEntry {
  externalId: string;
  subject: string;
  from: string;
  fromEmail: string;
  to: string[];
  toEmails: string[];
  body: string;
  sentAt: string;
  threadId: string;
  labels: string[];
  /** Structurally declared planned time, projected by the Gmail descriptor. */
  scheduledAt?: string;
  /** Structurally declared deadline, projected by the Gmail descriptor. */
  dueAt?: string;
  attachments?: GmailAttachment[];
}
let emailsCache: EmailEntry[] | null = null;
export function loadEmails(): EmailEntry[] {
  if (emailsCache) return emailsCache;
  emailsCache = loadSourceFixtureJson<EmailEntry[]>(loadActiveUniverse(), "gmail", "messages.json");
  return emailsCache;
}
export function mapEmail(
  e: EmailEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput | DocumentInput[] {
  const people: PersonMention[] = [
    { ...personMention(e.from, "sender"), emails: [e.fromEmail] },
    ...e.to.map(
      (ref, i): PersonMention => ({
        ...personMention(ref, "recipient"),
        emails: [e.toEmails[i]],
      }),
    ),
  ];

  const attachments = e.attachments ?? [];
  const attachmentInfos: AttachmentInfo[] = attachments.map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.sizeBytes,
    extracted: true,
  }));

  let content = e.body;
  if (attachmentInfos.length > 0) {
    content += formatAttachmentMarkers(attachmentInfos);
  }

  const emailDoc: DocumentInput = {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.subject,
    content,
    contentHash: sha256Hex(`${e.externalId}:${e.subject}:${content}`),
    metadata: {
      documentType: "email",
      sourceUrl: gmailSourceUrl(e.externalId),
      tags: e.labels,
      people,
      ...(e.scheduledAt ? { scheduledAt: e.scheduledAt } : {}),
      ...(e.dueAt ? { dueAt: e.dueAt } : {}),
      extra: {
        threadId: e.threadId,
        labels: e.labels,
        ...(attachmentInfos.length > 0 ? { attachments: attachmentInfos } : {}),
      },
    },
    sourceCreatedAt: e.sentAt,
    sourceUpdatedAt: e.sentAt,
  };

  if (attachments.length === 0) return emailDoc;

  const attachmentDocs = attachments.map((att) =>
    buildAttachmentDocument(
      emailDoc,
      att.filename,
      { text: att.extractedText, truncated: false },
      {
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
      },
    ),
  );
  return [emailDoc, ...attachmentDocs];
}

// ── Calendar ───────────────────────────────────────────────────────

export interface EventEntry {
  externalId: string;
  title: string;
  description: string;
  location: string;
  startTime: string;
  endTime: string;
  attendees: string[];
  attendeeEmails: string[];
  createdAt: string;
  updatedAt: string;
  calendarId?: string;
  calendarName?: string;
  iCalUID?: string;
  allDay?: boolean;
  recurring?: boolean;
  temporalProjectionEligible?: boolean;
  organizerEmail?: string;
  responseStatus?: string;
  status?: string;
}
let eventsCache: EventEntry[] | null = null;
export function loadEvents(): EventEntry[] {
  if (eventsCache) return eventsCache;
  eventsCache = loadSourceFixtureJson<EventEntry[]>(
    loadActiveUniverse(),
    "google-calendar",
    "events.json",
  );
  return eventsCache;
}
export function mapEvent(
  e: EventEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const people: PersonMention[] = e.attendees.map((ref, i) => ({
    ...personMention(ref, "attendee"),
    emails: [e.attendeeEmails[i]],
  }));
  const content = `${e.title}\n\n${e.description}\n\nLocation: ${e.location}\nWhen: ${e.startTime} → ${e.endTime}`;
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
        location: e.location,
        startTime: e.startTime,
        endTime: e.endTime,
      },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.updatedAt,
  };
}

/**
 * Structured twin of {@link mapEvent}. Fixture events are concrete
 * occurrences, so they are projection-eligible unless a test fixture
 * explicitly opts out to model a defensive recurring master.
 */
export function mapEventRecord(e: EventEntry, sourceAccount: string): Record<string, unknown> {
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
    source_account: sourceAccount,
    calendar_id: e.calendarId ?? "primary",
    calendar_name: e.calendarName ?? "Primary",
    event_id: e.externalId,
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
    response_status: e.responseStatus ?? "accepted",
    location: e.location || null,
    status: e.status ?? "confirmed",
  };
}

// ── Drive ─────────────────────────────────────────────────────────

interface DriveFileEntry {
  externalId: string;
  name: string;
  mimeType: string;
  content: string;
  owner: string;
  createdAt: string;
  modifiedAt: string;
}
let filesCache: DriveFileEntry[] | null = null;
export function loadFiles(): DriveFileEntry[] {
  if (filesCache) return filesCache;
  filesCache = loadSourceFixtureJson<DriveFileEntry[]>(
    loadActiveUniverse(),
    "google-drive",
    "files.json",
  );
  return filesCache;
}
export function mapDriveFile(
  e: DriveFileEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.name,
    content: e.content,
    contentHash: sha256Hex(`${e.externalId}:${e.content}:${e.modifiedAt}`),
    metadata: {
      documentType: "file",
      sourceUrl: `https://drive.google.com/file/d/${e.externalId}/view`,
      people: [personMention(e.owner, "owner")],
      extra: {
        mimeType: e.mimeType,
        ownerName: getPerson(e.owner).name,
      },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.modifiedAt,
  };
}

// ── Contacts ──────────────────────────────────────────────────────

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
    "google-contacts",
    "contacts.json",
  );
  return contactsCache;
}
export function mapContact(
  e: ContactEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
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
      people: [personMention(e.personRef, "contact")],
      extra: {
        company: e.company,
        title: e.title,
        canonicalName: getPerson(e.personRef).name,
      },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.modifiedAt,
  };
}

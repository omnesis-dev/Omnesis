// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "@omnesis/core";
import { renderNoteMarkdown } from "./markdown.js";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type { GranolaNoteDetail } from "./types.js";

/** Transcript span in seconds: last segment end − first segment start. */
function transcriptDurationSeconds(note: GranolaNoteDetail): number | null {
  const t = note.transcript;
  if (!t || t.length === 0) return null;
  const start = new Date(t[0].start_time).getTime();
  const end = new Date(t[t.length - 1].end_time).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return (end - start) / 1000;
}

/** Best-known meeting start: calendar event start, else first transcript segment. */
function meetingStart(note: GranolaNoteDetail): string | null {
  return note.calendar_event?.start_time ?? note.transcript?.[0]?.start_time ?? null;
}

/** Convert a Granola note detail to a `granola_meetings` row. */
export function noteToRecord(
  note: GranolaNoteDetail,
  syncedAt: string,
  sourceAccountId: string,
): Record<string, unknown> {
  const summary = note.summary_markdown?.trim() || note.summary_text?.trim() || "";
  const folderNames = note.folder_membership
    .map((f) => f.name?.trim())
    .filter((n): n is string => Boolean(n));
  return {
    id: note.id,
    title: note.title ?? null,
    owner_name: note.owner.name ?? null,
    owner_email: note.owner.email ?? null,
    created_at: note.created_at,
    updated_at: note.updated_at,
    started_at: meetingStart(note),
    duration_seconds: transcriptDurationSeconds(note),
    attendee_count: note.attendees.length,
    attendees:
      note.attendees.length > 0
        ? JSON.stringify(note.attendees.map((a) => ({ name: a.name, email: a.email })))
        : null,
    has_summary: summary.length > 0,
    summary_text: note.summary_text?.trim() || null,
    transcript_segment_count: note.transcript?.length ?? 0,
    calendar_event_title: note.calendar_event?.title ?? null,
    folder_names: folderNames.length > 0 ? JSON.stringify(folderNames) : null,
    web_url: note.web_url,
    synced_at: syncedAt,
    source_account_id: sourceAccountId,
  };
}

/** Build a searchable document for a Granola meeting note. */
export function noteToDocument(
  note: GranolaNoteDetail,
  providerId: ProviderId,
  sourceId: SourceId,
): DocumentInput {
  const content = renderNoteMarkdown(note);

  const people: PersonMention[] = [];
  // The note owner is the authenticated user — mark as self so the people
  // graph merges them with their identity in other sources.
  if (note.owner.email) {
    people.push({
      role: "owner",
      name: note.owner.name ?? undefined,
      emails: [note.owner.email],
      isSelf: true,
    });
  }
  for (const a of note.attendees) {
    if (!a.email || a.email === note.owner.email) continue;
    people.push({
      role: "attendee",
      name: a.name ?? undefined,
      emails: [a.email],
    });
  }

  return {
    providerId,
    sourceId,
    externalId: note.id,
    title: note.title?.trim() || "Untitled meeting",
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "note",
      sourceUrl: note.web_url,
      tags: ["granola"],
      people: people.length > 0 ? people : undefined,
      extra: {
        ownerEmail: note.owner.email,
        attendeeEmails: note.attendees.map((a) => a.email),
        hasTranscript: Boolean(note.transcript && note.transcript.length > 0),
        calendarEventTitle: note.calendar_event?.title ?? undefined,
        folders: note.folder_membership.map((f) => f.name).filter(Boolean),
      },
    },
    sourceCreatedAt: note.created_at,
    sourceUpdatedAt: note.updated_at,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each Apple source's documents can be asked about — the document-side
 * counterpart of the analytics schemas in `calendar-schema.ts` /
 * `call-log-schema.ts`.
 *
 * Subscription compilation reads these declarations to turn a natural-language
 * watch condition into a deterministic document predicate, so every entry must
 * describe what the normalizers in this package actually emit. A declared
 * person role or metadata path the source never populates compiles a watch
 * that can never fire, which reads to the operator as a working subscription.
 *
 * Two consequences of that rule are visible below. Apple Notes declares no
 * `extra.isLocked`, because password-protected notes are skipped outright and
 * every emitted note therefore carries `false`. Apple Calendar and Apple Call
 * Log declare no `tags`, because both normalizers always emit an empty tag
 * array. Date-shaped fields (`dueAt`, a contact's birthday, an event's start)
 * are also absent: matching them is a time comparison rather than the value
 * match this contract expresses.
 *
 * Vocabularies describe the source contract. `allowedValues` closes a domain
 * Apple itself closes; `canonicalValues` names the known spellings of a
 * vocabulary that stays open. No value here comes from a user's data.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * Messaging services that carry an iMessage-app conversation. The normalizer
 * passes Apple's `message.service` through verbatim and falls back to
 * `"iMessage"`, so other services a future macOS emits stay valid.
 */
const MESSAGE_SERVICES = ["iMessage", "SMS"];

const MESSAGE_SERVICE_ALIASES: Record<string, string[]> = {
  iMessage: ["imessage", "blue bubble"],
  SMS: ["sms", "text message", "green bubble"],
};

/** One document per note; the folder name is the note's only tag. */
export const appleNotesDocumentProfile: DocumentEventProfile = {
  documentTypes: ["note"],
  personRoles: ["author"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Name of the Notes folder holding the note. Folders are user-created, so the set of names is open.",
    },
    {
      path: "extra.folder",
      type: "string",
      description: "Notes folder holding the note — the same name the tag carries.",
    },
    {
      path: "extra.isPinned",
      type: "boolean",
      description: "Whether the note is pinned to the top of its folder.",
    },
  ],
};

/** One document per reminder, tagged with its list and its inline hashtags. */
export const appleRemindersDocumentProfile: DocumentEventProfile = {
  documentTypes: ["reminder"],
  personRoles: ["author"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "The reminder's list name followed by its inline hashtags. Both are user-created, so the set of values is open.",
    },
    {
      path: "extra.list",
      type: "string",
      description: "Name of the Reminders list the reminder belongs to.",
    },
    {
      path: "extra.hashtags",
      type: "string-array",
      description:
        "Inline hashtags on the reminder, lowercased with the leading '#' removed. Absent when the reminder has none.",
    },
    {
      path: "extra.completed",
      type: "boolean",
      description: "Whether the reminder is checked off.",
    },
    {
      path: "extra.flagged",
      type: "boolean",
      description: "Whether the reminder carries the Reminders flag.",
    },
    {
      path: "extra.priority",
      type: "string",
      description:
        "Priority set on the reminder. Absent when it has none; a priority outside the three Reminders levels appears as its raw number.",
      canonicalValues: ["high", "medium", "low"],
      valueAliases: {
        high: ["urgent", "top priority"],
        low: ["minor"],
      },
    },
  ],
};

/**
 * One document per chat per calendar day, holding that day's messages. Every
 * chat member is a participant — including people who said nothing that day —
 * and email addresses or phone numbers written in the messages are mentioned.
 */
export const appleIMessageDocumentProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["participant", "mentioned"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description: "Messaging service the day's conversation was carried over.",
      canonicalValues: MESSAGE_SERVICES,
      valueAliases: MESSAGE_SERVICE_ALIASES,
    },
    {
      path: "extra.service",
      type: "string",
      description: "Messaging service carrying the conversation — the same value the tag carries.",
      canonicalValues: MESSAGE_SERVICES,
      valueAliases: MESSAGE_SERVICE_ALIASES,
    },
    {
      path: "extra.isGroup",
      type: "boolean",
      description: "Whether the chat has more than one other member.",
    },
    {
      path: "extra.messageCount",
      type: "number",
      description: "Number of messages exchanged in the chat that day, excluding reactions.",
    },
    {
      path: "extra.chatName",
      type: "string",
      // A one-to-one chat has no group name, so this holds the other party's
      // own display name — the same value that becomes their participant name.
      identifiesPeople: true,
      description: "Name given to the chat, as group chats usually have. Absent when it has none.",
    },
  ],
};

/** One document per contact card. */
export const appleContactsDocumentProfile: DocumentEventProfile = {
  documentTypes: ["contact"],
  personRoles: ["contact"],
  metadataFields: [
    {
      path: "extra.organization",
      type: "string",
      description: "Company on the contact card. Absent when the card names none.",
    },
    {
      path: "extra.jobTitle",
      type: "string",
      description: "Job title on the contact card. Absent when the card names none.",
    },
    {
      path: "extra.department",
      type: "string",
      description: "Department on the contact card. Absent when the card names none.",
    },
    {
      path: "extra.isMe",
      type: "boolean",
      description: "Whether this is the address book's own card for its owner.",
    },
  ],
};

/**
 * One document per event. The organizer is the author, invitees are attendees,
 * and addresses written in the event notes are mentioned.
 */
export const appleCalendarDocumentProfile: DocumentEventProfile = {
  documentTypes: ["event"],
  personRoles: ["author", "attendee", "mentioned"],
  metadataFields: [
    {
      path: "extra.calendarName",
      type: "string",
      description: "Name of the calendar the event sits on.",
    },
    {
      path: "extra.location",
      type: "string",
      description:
        "Where the event takes place — its location name, or the street address when it has no name. Absent when the event has no location.",
    },
    {
      path: "extra.status",
      type: "string",
      description: "Confirmation status of the event. Absent when the event carries no status.",
      allowedValues: ["confirmed", "tentative", "cancelled"],
      valueAliases: {
        tentative: ["maybe", "unconfirmed", "provisional"],
        cancelled: ["canceled", "called off"],
      },
    },
    {
      path: "extra.allDay",
      type: "boolean",
      description: "Whether the event spans whole days rather than a time range.",
    },
    {
      path: "extra.conferenceUrl",
      type: "string",
      description:
        "Video-meeting link attached to the event, detected in its notes, or its URL field. Absent when it has none.",
    },
    {
      path: "extra.recurrence",
      type: "string",
      description:
        "Human-readable description of how the event repeats. Absent for one-off events.",
    },
  ],
};

/**
 * One document per calendar day, aggregating that day's phone and FaceTime
 * calls. Everyone on a call that day is a participant, the account owner
 * included.
 */
export const appleCallLogDocumentProfile: DocumentEventProfile = {
  documentTypes: ["call-log"],
  personRoles: ["participant"],
  metadataFields: [
    {
      path: "extra.callCount",
      type: "number",
      description: "Calls placed or received on the day this document covers.",
    },
    {
      path: "extra.totalDurationSeconds",
      type: "number",
      description: "Seconds spent on connected calls that day; missed calls contribute nothing.",
    },
  ],
};

/** One document per day, aggregating carrier voicemail and every caller. */
export const appleVoicemailDocumentProfile: DocumentEventProfile = {
  documentTypes: ["voicemail"],
  personRoles: ["participant"],
  metadataFields: [
    {
      path: "extra.voicemailCount",
      type: "number",
      description: "Carrier voicemails received on the day this document covers.",
    },
    {
      path: "extra.totalDurationSeconds",
      type: "number",
      description: "Combined duration in seconds of the day's voicemails.",
    },
    {
      path: "extra.transcriptCount",
      type: "number",
      description: "Voicemails for which Phone.app has supplied a transcript.",
    },
  ],
};

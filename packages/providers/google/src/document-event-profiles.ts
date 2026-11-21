// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Google sources' documents can be asked about — the document-side
 * counterpart of the analytics schemas' categorical vocabularies.
 *
 * Every entry below describes the wire contract of the normalizers in
 * `gmail.ts` / `calendar.ts` / `drive.ts`: the document types they emit, the person roles
 * they really assert, and the metadata they really populate. A declaration
 * the normalizer does not honour would let a natural-language condition
 * compile into a predicate that can never match, so the values here are held
 * to what those files write, and `document-event-profiles.test.ts` pins them
 * to the normalizers' actual output.
 */

import { DRIVE_FOLDERS_FIELD } from "./drive-folders.js";
import { GMAIL_LABELS_FIELD } from "./gmail-labels.js";
import { MAX_PEOPLE_PER_MESSAGE } from "./gmail-message.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * The output revision from which a Gmail record carries its label ids and
 * every recipient of its message, `Bcc` included, in the normalized form a
 * filter compares.
 */
export const GMAIL_OUTPUT_REVISION = 2;

/** The output revision from which a Drive record carries its folder ids. */
export const GOOGLE_DRIVE_OUTPUT_REVISION = 2;

/**
 * Gmail's built-in labels. Gmail returns these labels with `name` equal to
 * their `id`, so the resolved `metadata.tags` entry is the uppercase
 * identifier itself rather than the title-case string the web UI shows.
 * The vocabulary is open rather than closed: every user-created label
 * resolves to its own name and lands in the same array.
 *
 * SPAM and TRASH are deliberately absent — those messages are dropped during
 * normalization, so no indexed document ever carries either label.
 */
const GMAIL_SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];

export const gmailDocumentEventProfile: DocumentEventProfile = {
  // One document per message, plus one child document per attachment whose
  // text was successfully extracted.
  documentTypes: ["email", "attachment"],
  // `From` becomes the sender, `To` + `Cc` become recipients, and email
  // addresses or phone numbers found in the body become mentions. An
  // attachment document inherits the sender and recipients of its message and
  // takes its mentions from its own extracted text.
  personRoles: ["sender", "recipient", "mentioned"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Gmail labels on the message, resolved to their names. Built-in labels appear as their uppercase identifiers (INBOX, STARRED, CATEGORY_PROMOTIONS); a user-created label appears as the name its owner gave it, and a nested one as a slash path such as 'Receipts/2026'. Attachment documents carry no labels.",
      canonicalValues: GMAIL_SYSTEM_LABELS,
      valueAliases: {
        INBOX: ["inbox", "in the inbox"],
        SENT: ["sent", "sent mail", "mail I sent"],
        UNREAD: ["unread", "not yet read"],
        STARRED: ["starred", "flagged"],
        IMPORTANT: ["important", "marked important"],
        CATEGORY_PERSONAL: ["primary", "primary tab", "personal tab"],
        CATEGORY_SOCIAL: ["social", "social tab"],
        CATEGORY_PROMOTIONS: ["promotions", "promotional", "marketing"],
        CATEGORY_UPDATES: ["updates", "updates tab", "notifications tab"],
        CATEGORY_FORUMS: ["forums", "forums tab", "mailing list"],
      },
    },
    {
      path: GMAIL_LABELS_FIELD,
      type: "string-array",
      description:
        "Gmail's own ids for the labels on the message: user-created labels as an opaque id such as 'Label_12', and the built-in INBOX, SENT, DRAFT, STARRED, IMPORTANT, CHAT and CATEGORY_ labels as their uppercase identifier. Read state (UNREAD) and other built-in markers are not included. An id stays the same when its label is renamed. Empty when the message has none. Opaque: the names are in `tags`. Attachment documents carry none; an attachment is filed with its message.",
      // Gmail nests a label inside another by its name, so the list is a
      // tree; a message carries only the labels put on it, not the ones above.
      filter: {
        capability: "tree",
        minVersion: GMAIL_OUTPUT_REVISION,
        scope: "global",
        noun: { one: "label", many: "labels" },
        levels: [{ one: "label", many: "labels" }],
        picker: "tree",
        inside: { one: "label", many: "labels" },
      },
    },
    {
      path: "extra.threadId",
      type: "string",
      description:
        "Gmail's identifier for the conversation this message belongs to. Every message in a back-and-forth carries the same value, so it is what identifies a thread — a reply cannot be recognised as a reply to anything without it. Opaque: never shown to a person and never parsed for meaning. Attachment documents carry no thread id, so a condition about a conversation matches the messages and not their attachments.",
    },
    {
      path: "bulkMail",
      type: "boolean",
      description:
        "True when the message carried a List-Unsubscribe header — newsletters, marketing, mailing lists and anything else mass-distributed. Absent, never false, on the rest.",
    },
    {
      path: "automatedSender",
      type: "boolean",
      description:
        "True when the message came from a machine that expects no reply — a no-reply or notifications sender address, or an Auto-Submitted header. Distinct from bulk mail: this is transactional notification traffic. Absent, never false, on the rest.",
    },
  ],
  // A message involves whoever sent it and whoever it was addressed to, each
  // by address; nothing is read from the rest of its thread. Records written
  // before this revision left out `Bcc` recipients and stored addresses as
  // the header spelled them, so they cannot be compared.
  personFilter: {
    minVersion: GMAIL_OUTPUT_REVISION,
    roles: ["sender", "recipient"],
    identifiers: ["email", "domain"],
    maxPeople: MAX_PEOPLE_PER_MESSAGE,
  },
};

export const googleDriveDocumentEventProfile: DocumentEventProfile = {
  // One document per file whose text could be read.
  documentTypes: ["file"],
  // A file's owner; people with edit access as authors and people with view
  // or comment access as recipients; and email addresses or phone numbers
  // found in the text as mentions.
  personRoles: ["owner", "author", "recipient", "mentioned"],
  metadataFields: [
    {
      path: DRIVE_FOLDERS_FIELD,
      type: "string-array",
      description:
        "Drive's own ids for the folders the file sits in directly, not the folders above them. An id stays the same when its folder is renamed or moved. Empty when the file sits in no folder the account can see, such as a file shared on its own. Opaque: never shown to a person.",
      filter: {
        capability: "tree",
        minVersion: GOOGLE_DRIVE_OUTPUT_REVISION,
        scope: "global",
        noun: { one: "folder", many: "folders" },
        levels: [{ one: "folder", many: "folders" }],
        picker: "tree",
        inside: { one: "folder", many: "folders" },
      },
    },
  ],
};

export const googleCalendarDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["event"],
  // The organizer is recorded as the event's author, invitees as attendees,
  // and email addresses or phone numbers in the description as mentions.
  personRoles: ["author", "attendee", "mentioned"],
  metadataFields: [
    {
      path: "extra.status",
      type: "string",
      description:
        "The event's lifecycle state. A cancelled event is removed from the index instead of being written, so only these two states reach a document.",
      allowedValues: ["confirmed", "tentative"],
      valueAliases: {
        tentative: ["provisional", "not yet confirmed", "penciled in"],
      },
    },
    {
      path: "extra.iCalUID",
      type: "string",
      description:
        "RFC 5545 identifier for the event — the same value every system that exposes it uses, including ICS invitations delivered by email. Stable across edits: moving an event changes its time, not this. It is what a condition about one particular event has to be written against, since a title can be shared and a time is the thing being watched for. Opaque: never shown to a person and never parsed for meaning.",
    },
    {
      path: "extra.calendarName",
      type: "string",
      // A primary calendar is named after its owner's address, and a calendar
      // shared by someone else is usually named after them, so filtering on
      // this names a human as surely as an attendee filter does.
      identifiesPeople: true,
      description:
        "Display name of the calendar the event lives on, as its owner named it — the way to distinguish a work calendar from a personal or shared one. Absent when the calendar has no name.",
    },
    {
      path: "extra.location",
      type: "string",
      description:
        "Location text exactly as entered on the event: a room, a street address, or a meeting link. Absent when the event has none.",
    },
  ],
};

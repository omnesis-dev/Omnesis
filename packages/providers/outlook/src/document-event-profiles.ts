// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a watch may ask about an Outlook document.
 *
 * A profile is the wire contract of a normalizer: every field it declares must
 * actually be written, with the vocabulary stated here. The watch journal
 * projects a document's metadata strictly through this declaration, so a field
 * that is not declared is simply absent at evaluation time — a condition
 * referencing it compiles into a predicate that can never match, and fails
 * silently rather than loudly. The tests beside this file pin each declared
 * path against real normalizer output so the two cannot drift.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

export const outlookCalendarDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["event"],
  // The organizer is recorded as the event's author, invitees as attendees,
  // and email addresses or phone numbers in the body as mentions.
  personRoles: ["author", "attendee", "mentioned"],
  metadataFields: [
    {
      path: "extra.status",
      type: "string",
      description:
        "The event's lifecycle state. A cancelled event is retracted from the index rather than written, so only a confirmed one reaches a document.",
      allowedValues: ["confirmed"],
    },
    {
      path: "extra.showAs",
      type: "string",
      description:
        "How the event marks the calendar's availability — Outlook's own axis, separate from whether the event exists. A free block is a placeholder rather than a commitment; out-of-office and working-elsewhere are whole-day states rather than meetings.",
      allowedValues: ["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"],
      valueAliases: {
        tentative: ["provisional", "not yet confirmed", "penciled in"],
        oof: ["out of office", "away", "on leave", "annual leave"],
        workingElsewhere: ["working remotely", "working from home", "offsite"],
        free: ["available", "not busy", "a placeholder"],
      },
    },
    {
      path: "extra.allDay",
      type: "boolean",
      description:
        "True for an entry that occupies whole days rather than a time range — an observance, a leave day, a birthday. False for a meeting with a start and an end.",
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
      // A calendar shared in from another mailbox is usually named after its
      // owner, so filtering on this names a human as surely as an attendee
      // filter does.
      identifiesPeople: true,
      description:
        "Display name of the calendar the event lives on, as its owner named it — the way to distinguish a work calendar from a personal, shared, or subscribed one. Absent when the calendar has no name.",
    },
    {
      path: "extra.location",
      type: "string",
      description:
        "Location text exactly as entered on the event: a room, a street address, or a meeting link. Absent when the event has none.",
    },
  ],
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { id } from "./background-content.mjs";

export function addCopies(state) {
  const { put } = state;
  const { letters, files, events } = state;
  put(
    "outlook-email",
    "emails.json",
    letters.slice(0, 350).map((m, i) => ({
      ...m,
      externalId: id("outlook", i),
      threadId: `sb-outlook-thread-${Math.floor(i / 2)}`,
      folder: i % 8 === 0 ? "Archive" : "Inbox",
      subject: `Club correspondence: ${m.subject}`,
    })),
  );
  put(
    "outlook-calendar",
    "events.json",
    events(100, "outlook-event").map((e) => ({
      externalId: e.externalId,
      iCalUId: e.iCalUID,
      subject: e.title,
      body: e.description,
      location: e.location,
      startTime: e.startTime,
      endTime: e.endTime,
      organizer: "self",
      attendees: e.attendees,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      calendar: "Community club",
    })),
  );
  put(
    "onedrive",
    "items.json",
    files.slice(0, 120).map((f, i) => ({
      ...f,
      externalId: id("onedrive", i),
      size: Buffer.byteLength(f.content),
      eTag: `etag-sb-${i}`,
      webUrl: `https://files.example.com/personal/${i}`,
      folderPath: "Club documents",
      sharedBy: i % 2 ? "p_priya" : null,
    })),
  );
  put(
    "maildir",
    "messages.json",
    letters.slice(500, 700).map((m, i) => ({
      id: id("maildir", i),
      messageId: `${id("maildir-message", i)}@example.com`,
      from: m.from,
      to: m.to,
      subject: `Archived correspondence: ${m.subject}`,
      body: m.body,
      sentAt: m.sentAt,
      folders: ["Archive"],
      flags: "S",
    })),
  );
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { join } from "node:path";
import { deliverMessage } from "@omnesis/provider-maildir/testing";
import {
  loadActiveUniverse,
  loadSourceFixtureJson,
  resolvePerson,
  type PersonRef,
} from "@omnesis/providers-synth-common";
import type { FixtureAddress, FixtureMessage } from "@omnesis/provider-maildir/testing";

/** One message in the universe, with every folder a copy of it is stored in. */
export interface MaildirFixtureEntry {
  id: string;
  messageId: string;
  from: PersonRef;
  to: PersonRef[];
  cc?: PersonRef[];
  subject: string;
  body: string;
  sentAt: string;
  inReplyTo?: string;
  /** Folder names as the mail tool writes them, such as `INBOX` or `[Gmail]/All Mail`. */
  folders: string[];
  /** Maildir flag letters; a message with none is an unread delivery in `new`. */
  flags?: string;
  headers?: Record<string, string>;
}

export function loadMessages(): MaildirFixtureEntry[] {
  return loadSourceFixtureJson<MaildirFixtureEntry[]>(
    loadActiveUniverse(),
    "maildir",
    "messages.json",
  );
}

function address(ref: PersonRef): FixtureAddress {
  const person = resolvePerson(ref);
  const email = person.emails[0];
  if (!email) throw new Error(`Maildir fixture persona ${ref} has no email address`);
  return { name: person.name, address: email };
}

function render(entry: MaildirFixtureEntry): FixtureMessage {
  return {
    messageId: entry.messageId,
    from: address(entry.from),
    to: entry.to.map(address),
    cc: entry.cc?.map(address),
    subject: entry.subject,
    date: entry.sentAt,
    text: entry.body,
    inReplyTo: entry.inReplyTo,
    references: entry.inReplyTo ? [entry.inReplyTo] : undefined,
    headers: entry.headers,
  };
}

/**
 * Write the universe's messages into a Maildir under `root`, one copy per
 * folder, as a mail tool mirroring the account would. File names derive from
 * the fixture, so writing again over an existing tree changes nothing.
 */
export function materializeMaildir(root: string, entries: readonly MaildirFixtureEntry[]): void {
  for (const entry of entries) {
    const seconds = Math.floor(Date.parse(entry.sentAt) / 1000);
    for (const [index, folder] of entry.folders.entries()) {
      const uniq = `${seconds}.${entry.id}-${index}.synth`;
      const mailboxDir = join(root, ...folder.split("/"));
      const flags = entry.flags ?? "";
      const name = flags ? `cur/${uniq}:2,${[...flags].sort().join("")}` : `new/${uniq}`;
      if (existsSync(join(mailboxDir, name))) continue;
      deliverMessage(mailboxDir, uniq, render(entry), flags ? { flags } : { subdir: "new" });
    }
  }
}

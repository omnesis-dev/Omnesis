// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** Binary MIME parts backed by files inside the active universe. */
  attachments?: MaildirFixtureAttachment[];
}

export interface MaildirFixtureAttachment {
  /** Path relative to the universe directory, not the source directory. */
  assetPath: string;
  filename: string;
  mimeType: string;
}

/** Fixture safety limits, independent of extraction settings. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Load bounded binary data; resolve symlinks before enforcing the universe boundary. */
export function loadFixtureAttachments(
  attachments: readonly MaildirFixtureAttachment[],
  universeDir: string,
): NonNullable<FixtureMessage["attachments"]> {
  if (!Array.isArray(attachments) || attachments.length > 20)
    throw new Error("Maildir fixture attachments must be an array of at most 20 parts");
  const root = realpathSync(universeDir);
  let totalBytes = 0;
  return attachments.map((attachment) => {
    if (
      !attachment ||
      typeof attachment.filename !== "string" ||
      !attachment.filename.trim() ||
      !/^[^\x00-\x1f\x7f"\\/]{1,255}$/.test(attachment.filename) ||
      attachment.filename === "." ||
      attachment.filename === ".." ||
      typeof attachment.mimeType !== "string" ||
      attachment.mimeType.length > 127 ||
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(attachment.mimeType)
    )
      throw new Error("Maildir fixture attachment has an invalid filename or MIME type");
    const path = attachment.assetPath;
    if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path))
      throw new Error("Maildir fixture asset path must be universe-relative");
    const requested = resolve(root, path);
    if (!contained(root, requested)) throw new Error("Maildir fixture asset escapes its universe");
    const resolved = realpathSync(requested);
    if (!contained(root, resolved)) throw new Error("Maildir fixture asset escapes its universe");
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES)
        throw new Error("Maildir fixture asset must be a regular file of at most 25 MiB");
      if (totalBytes + stat.size > MAX_MESSAGE_ATTACHMENT_BYTES)
        throw new Error("Maildir fixture message attachments exceed 50 MiB");
      const content = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < content.length) {
        const count = readSync(fd, content, length, content.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length !== stat.size) throw new Error("Maildir fixture asset changed while being read");
      totalBytes += length;
      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: content.subarray(0, length),
      };
    } finally {
      closeSync(fd);
    }
  });
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

function render(entry: MaildirFixtureEntry, universeDir?: string): FixtureMessage {
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
    attachments:
      entry.attachments !== undefined
        ? loadFixtureAttachments(entry.attachments, universeDir ?? loadActiveUniverse().dir)
        : undefined,
  };
}

/**
 * Write the universe's messages into a Maildir under `root`, one copy per
 * folder, as a mail tool mirroring the account would. File names derive from
 * the fixture, so writing again over an existing tree changes nothing.
 */
export function materializeMaildir(
  root: string,
  entries: readonly MaildirFixtureEntry[],
  universeDir?: string,
): void {
  for (const entry of entries) {
    const seconds = Math.floor(Date.parse(entry.sentAt) / 1000);
    for (const [index, folder] of entry.folders.entries()) {
      const uniq = `${seconds}.${entry.id}-${index}.synth`;
      const mailboxDir = join(root, ...folder.split("/"));
      const flags = entry.flags ?? "";
      const name = flags ? `cur/${uniq}:2,${[...flags].sort().join("")}` : `new/${uniq}`;
      if (existsSync(join(mailboxDir, name))) continue;
      deliverMessage(
        mailboxDir,
        uniq,
        render(entry, universeDir),
        flags ? { flags } : { subdir: "new" },
      );
    }
  }
}

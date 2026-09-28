// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading one message file: a cheap header scan that names the message, and a
 * full parse that yields everything the document is built from.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import PostalMime from "postal-mime";
import type { Address, Email } from "postal-mime";
import type { MailAddress } from "@omnesis/core";

/** How much of a file the header scan reads. Headers past this are not consulted. */
const HEADER_SCAN_BYTES = 64 * 1024;
/** A message larger than this is indexed from its headers alone. */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
/**
 * How deep MIME parts may nest. Real mail rarely passes a handful; the
 * library's own ceiling is far higher than any message needs.
 */
const MIME_OPTIONS = { maxNestingDepth: 32 };
const MAX_ATTACHMENTS = 200;
const MAX_ATTACHMENT_FILENAME_CHARS = 255;

/** What the header scan learns: the message's identity and when it was sent. */
export interface ScannedMessage {
  /** The external id every copy of this message shares. */
  key: string;
  /** Milliseconds since the epoch. */
  dateMs: number;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: Uint8Array;
}

export interface ParsedMessage {
  subject?: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  date?: Date;
  text?: string;
  html?: string;
  listUnsubscribe?: string;
  autoSubmitted?: string;
  precedence?: string;
  attachments: ParsedAttachment[];
  /** True when the file was too large to parse beyond its headers. */
  headersOnly: boolean;
}

/**
 * Read the start of a message file: `maxBytes` of it, or only the header
 * scan's share when the whole file is larger than `maxBytes`.
 *
 * Opened without following a link and without blocking, and refused unless
 * it is a regular file: a named pipe would otherwise stall the collector on
 * the open, and a file swapped for a link since the walk could point anywhere.
 */
function readPrefix(path: string, maxBytes: number): { bytes: Buffer; size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw Object.assign(new Error("Not a regular file"), { code: "ENOTREGULAR" });
    }
    const size = stat.size;
    const length = size > maxBytes ? Math.min(size, HEADER_SCAN_BYTES) : size;
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, bytes, offset, length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return { bytes: bytes.subarray(0, offset), size };
  } finally {
    closeSync(fd);
  }
}

/** The header block of a raw message: everything before the first empty line. */
function headerBlock(bytes: Buffer): Buffer {
  const crlf = bytes.indexOf("\r\n\r\n");
  const lf = bytes.indexOf("\n\n");
  const ends = [crlf === -1 ? -1 : crlf + 4, lf === -1 ? -1 : lf + 2].filter((i) => i > 0);
  return ends.length > 0 ? bytes.subarray(0, Math.min(...ends)) : bytes;
}

function stripAngles(id: string | undefined): string | undefined {
  const trimmed = id?.trim().replace(/^<|>$/g, "").trim();
  return trimmed ? trimmed : undefined;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * The external id of a message.
 *
 * Its Message-ID when it has one, so the copies a mail tool writes into
 * several folders — Gmail's labels arrive as one folder each, plus All Mail —
 * are one document rather than one per folder. A message without a
 * Message-ID is identified by the one file it lives in.
 */
export function messageKey(messageId: string | undefined, mailboxId: string, uniq: string): string {
  const id = stripAngles(messageId);
  return id ? `mid:${sha(id)}` : `file:${sha(`${mailboxId}\0${uniq}`)}`;
}

/** Delivery time a Maildir file name starts with, in seconds, when it carries one. */
function deliveryTimeMs(uniq: string): number | undefined {
  const match = /^(\d{9,11})\./.exec(uniq);
  return match ? Number(match[1]) * 1000 : undefined;
}

function validDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/**
 * Read a message's headers and name it.
 *
 * The date is the `Date` header, else the delivery time a Maildir file name
 * begins with, else the file's modification time — every message gets one,
 * because the data cutoff and the document's time both need it.
 */
export async function scanMessage(
  path: string,
  mailboxId: string,
  uniq: string,
  mtimeMs: () => number,
): Promise<ScannedMessage> {
  const { bytes } = readPrefix(path, HEADER_SCAN_BYTES);
  const headers = await PostalMime.parse(headerBlock(bytes), MIME_OPTIONS);
  const dateMs =
    validDate(headers.date)?.getTime() ?? deliveryTimeMs(uniq) ?? Math.trunc(mtimeMs());
  return { key: messageKey(headers.messageId, mailboxId, uniq), dateMs };
}

function flattenAddresses(addresses: Address[] | Address | undefined): MailAddress[] {
  const list = addresses === undefined ? [] : Array.isArray(addresses) ? addresses : [addresses];
  const out: MailAddress[] = [];
  for (const entry of list) {
    const members = entry.group ?? [entry];
    for (const member of members) {
      if (!member.address) continue;
      out.push(
        member.name ? { name: member.name, address: member.address } : { address: member.address },
      );
    }
  }
  return out;
}

function headerValue(email: Email, key: string): string | undefined {
  return email.headers.find((header) => header.key === key)?.value;
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/**
 * The attachments worth naming: a part with a filename and some bytes.
 *
 * A part with no filename cannot be named or identified stably, and an empty
 * one holds nothing to read. Deduplicated by filename and size — the shape a
 * calendar invite sent both inline and attached takes — first part wins.
 */
function collectAttachments(email: Email): ParsedAttachment[] {
  const seen = new Set<string>();
  const out: ParsedAttachment[] = [];
  for (const attachment of email.attachments) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const filename = attachment.filename?.slice(0, MAX_ATTACHMENT_FILENAME_CHARS);
    if (!filename) continue;
    const content = attachmentBytes(attachment.content);
    if (content.byteLength === 0) continue;
    const dedupe = `${filename}\0${content.byteLength}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      filename,
      mimeType: attachment.mimeType.toLowerCase(),
      size: content.byteLength,
      content,
    });
  }
  return out;
}

/** Parse a whole message file. */
export async function parseMessageFile(path: string): Promise<ParsedMessage> {
  const { bytes, size } = readPrefix(path, MAX_MESSAGE_BYTES);
  const headersOnly = size > MAX_MESSAGE_BYTES;
  const email = await PostalMime.parse(headersOnly ? headerBlock(bytes) : bytes, MIME_OPTIONS);
  return {
    subject: email.subject?.trim() || undefined,
    from: flattenAddresses(email.from),
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    bcc: flattenAddresses(email.bcc),
    messageId: stripAngles(email.messageId),
    inReplyTo: stripAngles(email.inReplyTo),
    references: (email.references ?? "")
      .split(/\s+/)
      .map((id) => stripAngles(id))
      .filter((id): id is string => id !== undefined),
    date: validDate(email.date),
    text: email.text,
    html: email.html,
    listUnsubscribe: headerValue(email, "list-unsubscribe"),
    autoSubmitted: headerValue(email, "auto-submitted"),
    precedence: headerValue(email, "precedence"),
    attachments: headersOnly ? [] : collectAttachments(email),
    headersOnly,
  };
}

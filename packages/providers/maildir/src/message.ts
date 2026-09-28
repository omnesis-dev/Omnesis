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
  /**
   * True when the file was larger than the parse reads: its text comes from
   * the part of the file that was read — the text parts of a message come
   * before its attachments — and its attachments are left out.
   */
  oversized: boolean;
}

/**
 * Read the start of a message file: at most `maxBytes` of it.
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
    const length = Math.min(size, maxBytes);
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

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function isUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The charset a header block declares, when the runtime can decode it. */
function declaredCharset(header: string): string | undefined {
  const label = /charset\s*=\s*"?([\w.:-]+)/i.exec(header)?.[1];
  if (!label) return undefined;
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return undefined;
  }
}

/**
 * Make 8-bit text that is not UTF-8 readable before the parser sees it.
 *
 * Older mail often carries raw Latin-1 in its headers — a subject or a name
 * sent without the encoded-word form the standard asks for — and some bodies
 * declare no charset at all. The parser reads such bytes as UTF-8 and turns
 * every accented letter into a replacement character. Header lines that are
 * not valid UTF-8 are re-read in the charset the message declares, else
 * windows-1252 (the superset of Latin-1 mail clients actually wrote); a
 * single-part body with no declared charset that is not valid UTF-8 is
 * labelled windows-1252 so the parser decodes it as such. Valid UTF-8 is
 * never touched.
 */
function repairCharsets(bytes: Buffer): Buffer {
  const head = headerBlock(bytes);
  const body = bytes.subarray(head.length);
  const headText = head.toString("latin1");
  const fallback = declaredCharset(headText) ?? "windows-1252";
  let changed = false;

  let repairedHead = head;
  if (!isUtf8(head)) {
    const decoder = new TextDecoder(fallback);
    const lines: Buffer[] = [];
    let start = 0;
    while (start < head.length) {
      const nl = head.indexOf(0x0a, start);
      const end = nl === -1 ? head.length : nl + 1;
      const line = head.subarray(start, end);
      lines.push(isUtf8(line) ? line : Buffer.from(decoder.decode(line), "utf8"));
      start = end;
    }
    repairedHead = Buffer.concat(lines);
    changed = true;
  }

  const singlePart = !/^content-type:\s*multipart\//im.test(headText);
  if (singlePart && !/charset\s*=/i.test(headText) && body.length > 0 && !isUtf8(body)) {
    const label = "; charset=windows-1252";
    const text = repairedHead.toString("utf8");
    const withType = /^content-type:[^\r\n]*/im.test(text)
      ? text.replace(/^(content-type:[^\r\n]*)/im, `$1${label}`)
      : text.replace(/(\r?\n)(\r?\n)?$/, `$1Content-Type: text/plain${label}$1$2`);
    repairedHead = Buffer.from(withType, "utf8");
    changed = true;
  }
  return changed ? Buffer.concat([repairedHead, body]) : bytes;
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
 * When the message reached its mail server: the date the topmost `Received`
 * header ends with. The receiving server writes it, so it holds even when the
 * sender's `Date` header is missing or unreadable.
 */
function receivedDate(email: Email): Date | undefined {
  const received = email.headers.find((header) => header.key === "received")?.value;
  const stamp = received?.slice(received.lastIndexOf(";") + 1).trim();
  return validDate(stamp);
}

/** The first message id in a header that should hold one, ignoring comments and extras. */
function firstMessageId(value: string | undefined): string | undefined {
  const bracketed = /<([^<>\s]+)>/.exec(value ?? "")?.[1];
  return bracketed ?? stripAngles(value?.trim().split(/\s+/)[0]);
}

/**
 * Read a message's headers and name it.
 *
 * The date is the `Date` header, else when its mail server received it, else
 * the time a Maildir file name begins with, else the file's modification time
 * — every message gets one, because the data cutoff and the document's time
 * both need it. The file name comes late because a mirroring tool stamps it
 * with when it downloaded the message, not when the message arrived.
 */
export async function scanMessage(
  path: string,
  mailboxId: string,
  uniq: string,
  mtimeMs: () => number,
): Promise<ScannedMessage> {
  const { bytes } = readPrefix(path, HEADER_SCAN_BYTES);
  const headers = await PostalMime.parse(repairCharsets(headerBlock(bytes)), MIME_OPTIONS);
  const dateMs =
    (validDate(headers.date) ?? receivedDate(headers))?.getTime() ??
    deliveryTimeMs(uniq) ??
    Math.trunc(mtimeMs());
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
 * one holds nothing to read. A calendar invitation is the exception: sent as
 * a bare `text/calendar` part it often has no name, and it is the substance
 * of the message, so it is read as `invite.ics`. Deduplicated by filename and size — the shape a
 * calendar invite sent both inline and attached takes — first part wins.
 */
function collectAttachments(email: Email): ParsedAttachment[] {
  const seen = new Set<string>();
  const out: ParsedAttachment[] = [];
  for (const attachment of email.attachments) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const filename =
      attachment.filename?.slice(0, MAX_ATTACHMENT_FILENAME_CHARS) ||
      (attachment.mimeType.toLowerCase() === "text/calendar" ? "invite.ics" : undefined);
    if (!filename) continue;
    const content = attachmentBytes(attachment.content);
    if (content.byteLength === 0) continue;
    const dedupe = `${filename}\0${content.byteLength}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const mimeType = attachment.mimeType.toLowerCase();
    out.push({
      filename,
      mimeType,
      size: content.byteLength,
      content: mimeType === "text/plain" ? asUtf8Text(content) : content,
    });
  }
  return out;
}

/**
 * A text attachment as UTF-8, for an extractor that reads text as UTF-8.
 * The parser hands a part's raw bytes over without its declared charset, and
 * text attached to older mail is usually windows-1252; bytes that are not
 * valid UTF-8 are re-read as that.
 */
function asUtf8Text(content: Uint8Array): Uint8Array {
  if (isUtf8(content)) return content;
  return Buffer.from(new TextDecoder("windows-1252").decode(content), "utf8");
}

/** Parse a whole message file. */
export async function parseMessageFile(path: string): Promise<ParsedMessage> {
  const { bytes, size } = readPrefix(path, MAX_MESSAGE_BYTES);
  const oversized = size > MAX_MESSAGE_BYTES;
  const email = await PostalMime.parse(repairCharsets(bytes), MIME_OPTIONS);
  return {
    subject: email.subject?.trim() || undefined,
    from: flattenAddresses(email.from),
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    bcc: flattenAddresses(email.bcc),
    messageId: stripAngles(email.messageId),
    inReplyTo: firstMessageId(email.inReplyTo),
    references: (email.references ?? "")
      .split(/\s+/)
      .map((id) => stripAngles(id))
      .filter((id): id is string => id !== undefined),
    date: validDate(email.date) ?? receivedDate(email),
    text: email.text,
    html: email.html,
    listUnsubscribe: headerValue(email, "list-unsubscribe"),
    autoSubmitted: headerValue(email, "auto-submitted"),
    precedence: headerValue(email, "precedence"),
    attachments: oversized ? [] : collectAttachments(email),
    oversized,
  };
}

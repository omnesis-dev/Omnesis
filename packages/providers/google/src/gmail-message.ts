// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading one Gmail API message: its text, its date, its people and the
 * document content built from them. Pure functions over the API's
 * `MessagePart` tree, so the source class keeps only fetching and state.
 */

import {
  charsetOfContentType,
  decodeMailText,
  mailPeopleMentions,
  parseEmailHeader,
  splitEmailList,
  type MailAddress,
} from "@omnesis/core";
import type { gmail_v1 } from "googleapis";
import type { PersonMention } from "@omnesis/types";

/** More people than this on one message are dropped rather than handed to the people graph. */
const MAX_PEOPLE_PER_MESSAGE = 1_000;

/** Value of a header on a part, matched case-insensitively. */
export function partHeader(part: gmail_v1.Schema$MessagePart, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part.headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? undefined;
}

/**
 * Every part of a type that is the message's own text rather than an
 * attached file, in the order they appear: a part with a file name is a file
 * the sender attached, even when it is `text/plain`. A message can carry its
 * text in several parts — one per stretch between inline images, or nested
 * in parallel and mixed parts by an unusual mailer — and each holds part of
 * what the sender wrote.
 */
function bodyParts(
  part: gmail_v1.Schema$MessagePart,
  mimeType: string,
): gmail_v1.Schema$MessagePart[] {
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return [part];
  return (part.parts ?? []).flatMap((child) => bodyParts(child, mimeType));
}

/**
 * The decoded text of a body part. The API returns the part's bytes after
 * transfer decoding, in the charset the part declares; they are read in that
 * charset, or as windows-1252 when they are not UTF-8 and it names none.
 */
function partText(part: gmail_v1.Schema$MessagePart): string {
  const bytes = Buffer.from(part.body!.data!, "base64url");
  return decodeMailText(bytes, charsetOfContentType(partHeader(part, "Content-Type")));
}

/** The decoded text of every body part of a type, joined in order; undefined when there is none. */
function joinedText(payload: gmail_v1.Schema$MessagePart, mimeType: string, separator: string) {
  const parts = bodyParts(payload, mimeType);
  return parts.length > 0 ? parts.map(partText).join(separator) : undefined;
}

/** The message's plain-text and HTML body parts, decoded. */
export function messageParts(payload: gmail_v1.Schema$MessagePart): {
  text?: string;
  html?: string;
} {
  return {
    text: joinedText(payload, "text/plain", "\n\n"),
    html: joinedText(payload, "text/html", "\n"),
  };
}

/** The earliest date a `Date` header may carry and still be believed. */
const EARLIEST_BELIEVABLE_MS = Date.UTC(1980, 0, 1);
/** How far past the moment of reading a `Date` header may lie (clock skew, time zones). */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * When a message was sent.
 *
 * The `Date` header, which the sender's mail program wrote. Gmail's own
 * `internalDate` is when the message reached this mailbox — for mail imported
 * from another account, the day of the import, which can be years late — so
 * it is used only when the header is missing, unparseable or implausible
 * (before 1980, or more than a day in the future). When `internalDate` is
 * implausible too, the time the receiving server stamped on the topmost
 * `Received` header is used.
 */
export function messageDate(
  dateHeader: string | undefined,
  internalDate: string | null | undefined,
  now: number,
  receivedHeader?: string,
): string {
  const believable = (ms: number) =>
    Number.isFinite(ms) && ms >= EARLIEST_BELIEVABLE_MS && ms <= now + FUTURE_SLACK_MS;
  const header = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  if (believable(header)) return new Date(header).toISOString();
  const internal = internalDate ? Number.parseInt(internalDate, 10) : Number.NaN;
  if (believable(internal)) return new Date(internal).toISOString();
  // A Received header ends with `; <date>`.
  const semicolon = receivedHeader?.lastIndexOf(";") ?? -1;
  const received = semicolon >= 0 ? Date.parse(receivedHeader!.slice(semicolon + 1)) : Number.NaN;
  if (believable(received)) return new Date(received).toISOString();
  return new Date(Number.isFinite(internal) ? internal : now).toISOString();
}

/** A `From`/`To`/`Cc`/`Bcc` header value as the addresses it names. */
function addressesOf(header: string | undefined): MailAddress[] {
  if (!header) return [];
  const out: MailAddress[] = [];
  for (const entry of splitEmailList(header)) {
    const parsed = parseEmailHeader(entry);
    if (!parsed.email) continue;
    out.push(
      parsed.name ? { name: parsed.name, address: parsed.email } : { address: parsed.email },
    );
  }
  return out;
}

/**
 * The people a message names: the sender, every recipient — `Bcc` included,
 * which Gmail keeps on the owner's sent mail — and addresses and phone numbers
 * the body quotes. See `mailPeopleMentions` for the rules they share with the
 * other mail sources.
 *
 * SECURITY CAVEAT: every identity comes from a sender-controlled header or
 * body. None is authentication-verified — `Authentication-Results` is not
 * consulted for an aligned DKIM/DMARC pass — so a spoofed sender is ingested
 * as a normal mention. Treat these as unverified: fine for search and graph
 * completeness, but a retrieval-trust gate must not score a person as
 * credible off them without verifying first.
 */
export function messagePeople(
  headers: { from?: string; to?: string; cc?: string; bcc?: string },
  body: string,
): PersonMention[] {
  return mailPeopleMentions(
    {
      from: addressesOf(headers.from),
      to: addressesOf(headers.to),
      cc: addressesOf(headers.cc),
      bcc: addressesOf(headers.bcc),
    },
    body,
    MAX_PEOPLE_PER_MESSAGE,
  );
}

/**
 * The document text of a message: the subject as a heading, the address and
 * date lines, a rule, then the body. The rule has a blank line on each side,
 * because a line directly above `---` turns into a Markdown heading.
 */
export function messageContent(fields: {
  subject: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  date: string;
  body: string;
}): string {
  const lines = [`# ${fields.subject}`, "", `**From:** ${fields.from}`, `**To:** ${fields.to}`];
  if (fields.cc) lines.push(`**Cc:** ${fields.cc}`);
  if (fields.bcc) lines.push(`**Bcc:** ${fields.bcc}`);
  lines.push(`**Date:** ${fields.date}`, "", "---", "");
  if (fields.body) lines.push(fields.body);
  return lines.join("\n");
}

/**
 * Whether an inline image's text says something its message does not: a
 * phone number or an email address missing from the message, or at least a
 * few words the message never uses. A logo repeating the sender's name adds
 * nothing; a signature block sent as an image does.
 */
export function addsToMessage(imageText: string, messageText: string): boolean {
  const messageDigits = messageText.replace(/\D/g, "");
  const phones = (imageText.match(/\+?\d[\d ().-]{7,}\d/g) ?? [])
    .map((p) => p.replace(/\D/g, ""))
    .filter((digits) => digits.length >= 9);
  // The last nine digits match a number however its country code is written.
  if (phones.some((digits) => !messageDigits.includes(digits.slice(-9)))) return true;
  const lowerMessage = messageText.toLowerCase();
  const emails = imageText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
  if (emails.some((e) => !lowerMessage.includes(e.toLowerCase()))) return true;
  const known = new Set(lowerMessage.match(/[\p{L}]{3,}/gu) ?? []);
  const fresh = new Set(
    (imageText.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).filter((w) => !known.has(w)),
  );
  return fresh.size >= MIN_FRESH_WORDS;
}

/** How many words an inline image must add to its message to be kept. */
const MIN_FRESH_WORDS = 4;

/**
 * A conservative author-only prefix for vocabulary evidence. Prefer the plain
 * MIME alternative; HTML-only mail is omitted rather than guessing which DOM
 * fragments are quotations. Stop at the first quote, forwarded header, reply
 * introduction or signature. The regular document body is unaffected.
 */
export function selfAuthoredMailText(parts: { text?: string; html?: string }): string {
  const source = parts.text ?? "";
  let text = source.slice(0, 32_768);
  if (source.length > text.length && /[\p{L}\p{M}\p{N}‘’'.-]/u.test(source[text.length] ?? ""))
    text = text.replace(/[\p{L}\p{M}\p{N}‘’'.-]+$/u, "");
  if (/<\/?[a-z][^>]*>/i.test(text)) return "";
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (
      /^\s*>/.test(line) ||
      /^\s*--\s*$/.test(line) ||
      /^\s*-{2,}.*-{2,}\s*$/.test(line) ||
      /^\s*(?:From|Sent|To|Subject|De|Envoyé|À|Objet):\s/i.test(line) ||
      /^\s*(?:On|Le|Am|El|Il|Em) .{0,500}:\s*$/i.test(line)
    )
      break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

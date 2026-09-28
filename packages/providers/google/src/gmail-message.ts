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
 * The first part of a type that is the message's own text rather than an
 * attached file: a part with a file name or an attachment id is a file the
 * sender attached, even when it is `text/plain`.
 */
function bodyPart(
  part: gmail_v1.Schema$MessagePart,
  mimeType: string,
): gmail_v1.Schema$MessagePart | null {
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = bodyPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

/**
 * The decoded text of a body part. The API returns the part's bytes after
 * transfer decoding, in the charset the part declares; they are read in that
 * charset, or as windows-1252 when they are not UTF-8 and it names none.
 */
function partText(part: gmail_v1.Schema$MessagePart | null): string | undefined {
  if (!part?.body?.data) return undefined;
  const bytes = Buffer.from(part.body.data, "base64url");
  return decodeMailText(bytes, charsetOfContentType(partHeader(part, "Content-Type")));
}

/** The message's plain-text and HTML body parts, decoded. */
export function messageParts(payload: gmail_v1.Schema$MessagePart): {
  text?: string;
  html?: string;
} {
  return {
    text: partText(bodyPart(payload, "text/plain")),
    html: partText(bodyPart(payload, "text/html")),
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
 * (before 1980, or more than a day in the future).
 */
export function messageDate(
  dateHeader: string | undefined,
  internalDate: string | null | undefined,
  now: number,
): string {
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  if (
    Number.isFinite(parsed) &&
    parsed >= EARLIEST_BELIEVABLE_MS &&
    parsed <= now + FUTURE_SLACK_MS
  ) {
    return new Date(parsed).toISOString();
  }
  const internal = internalDate ? Number.parseInt(internalDate, 10) : Number.NaN;
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

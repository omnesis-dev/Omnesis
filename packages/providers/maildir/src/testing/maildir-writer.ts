// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Writing Maildir trees the way a mail tool does, for tests and the synthetic
 * universe. Messages are rendered as RFC 5322 text and delivered through
 * `tmp` then renamed into place, as a delivering tool does.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureAddress {
  name?: string;
  address: string;
}

export interface FixtureAttachment {
  filename: string;
  mimeType: string;
  content: string;
}

export interface FixtureMessage {
  messageId?: string;
  from: FixtureAddress;
  to: FixtureAddress[];
  cc?: FixtureAddress[];
  subject: string;
  /** ISO 8601. */
  date: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  /** Extra headers, such as `List-Unsubscribe`. */
  headers?: Record<string, string>;
  attachments?: FixtureAttachment[];
}

function formatAddress(address: FixtureAddress): string {
  return address.name ? `"${address.name}" <${address.address}>` : `<${address.address}>`;
}

function base64Lines(content: string): string {
  return (
    Buffer.from(content)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
}

/** Render a message as the bytes a mail tool would store. */
export function renderMessage(message: FixtureMessage): string {
  const headers: string[] = [
    `From: ${formatAddress(message.from)}`,
    `To: ${message.to.map(formatAddress).join(", ")}`,
  ];
  if (message.cc?.length) headers.push(`Cc: ${message.cc.map(formatAddress).join(", ")}`);
  headers.push(`Subject: ${message.subject}`);
  headers.push(`Date: ${new Date(message.date).toUTCString().replace("GMT", "+0000")}`);
  if (message.messageId) headers.push(`Message-ID: <${message.messageId}>`);
  if (message.inReplyTo) headers.push(`In-Reply-To: <${message.inReplyTo}>`);
  if (message.references?.length) {
    headers.push(`References: ${message.references.map((id) => `<${id}>`).join(" ")}`);
  }
  for (const [name, value] of Object.entries(message.headers ?? {}))
    headers.push(`${name}: ${value}`);
  headers.push("MIME-Version: 1.0");

  const textPart = [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.text),
  ].join("\r\n");
  const htmlPart = message.html
    ? [
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(message.html),
      ].join("\r\n")
    : undefined;
  const bodyPart = htmlPart
    ? [
        'Content-Type: multipart/alternative; boundary="alt-boundary"',
        "",
        "--alt-boundary",
        textPart,
        "--alt-boundary",
        htmlPart,
        "--alt-boundary--",
      ].join("\r\n")
    : textPart;

  if (!message.attachments?.length) {
    return `${headers.join("\r\n")}\r\n${bodyPart}\r\n`;
  }
  const parts = [bodyPart];
  for (const attachment of message.attachments) {
    parts.push(
      [
        `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(attachment.content),
      ].join("\r\n"),
    );
  }
  return [
    ...headers,
    'Content-Type: multipart/mixed; boundary="mixed-boundary"',
    "",
    ...parts.flatMap((part) => ["--mixed-boundary", part]),
    "--mixed-boundary--",
    "",
  ].join("\r\n");
}

/** Create a mailbox directory with its `cur`, `new` and `tmp`. */
export function createMailbox(dir: string): string {
  for (const sub of ["cur", "new", "tmp"]) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

export interface DeliverOptions {
  /** `new` for an unread delivery; `cur` (the default) for a message a client has seen. */
  subdir?: "new" | "cur";
  /** Maildir flag letters for a message in `cur`, such as `S` or `FS`. */
  flags?: string;
}

/** The file name a message in `cur` carries for a set of flags. */
export function maildirFileName(uniq: string, subdir: "new" | "cur", flags = ""): string {
  return subdir === "new" ? uniq : `${uniq}:2,${[...flags].sort().join("")}`;
}

/** Deliver one message into a mailbox, returning its path. */
export function deliverMessage(
  mailboxDir: string,
  uniq: string,
  message: FixtureMessage | string,
  options: DeliverOptions = {},
): string {
  createMailbox(mailboxDir);
  const subdir = options.subdir ?? "cur";
  const temporary = join(mailboxDir, "tmp", uniq);
  writeFileSync(temporary, typeof message === "string" ? message : renderMessage(message));
  const destination = join(mailboxDir, subdir, maildirFileName(uniq, subdir, options.flags));
  renameSync(temporary, destination);
  return destination;
}

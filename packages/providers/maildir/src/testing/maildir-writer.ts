// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Writing Maildir trees the way a mail tool does, for tests and the synthetic
 * universe. Messages are rendered as RFC 5322 text and delivered through
 * `tmp` then renamed into place, as a delivering tool does.
 */

import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureAddress {
  name?: string;
  address: string;
}

export interface FixtureAttachment {
  filename: string;
  mimeType: string;
  content: string | Uint8Array;
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

function base64Lines(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return (bytes.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
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

/** Create a folder the way Thunderbird's "file per message" store does: `cur` and `tmp`, no `new`. */
export function createThunderbirdFolder(dir: string): string {
  for (const sub of ["cur", "tmp"]) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

/** Thunderbird's flag words: `X-Mozilla-Status` (4 hex digits) and `X-Mozilla-Status2` (8). */
export interface MozillaStatus {
  status?: number;
  status2?: number;
}

function mozillaStatusHeaders({ status = 0, status2 = 0 }: MozillaStatus): string {
  const hex = (value: number, width: number) => value.toString(16).padStart(width, "0");
  return `X-Mozilla-Status: ${hex(status, 4)}\r\nX-Mozilla-Status2: ${hex(status2, 8)}\r\n`;
}

/**
 * Store one message in a Thunderbird folder, as Thunderbird names and writes
 * it: `cur/<name>.eml`, starting with its status headers. Returns its path.
 */
export function storeThunderbirdMessage(
  folderDir: string,
  name: string,
  message: FixtureMessage | string,
  status: MozillaStatus = {},
): string {
  createThunderbirdFolder(folderDir);
  const temporary = join(folderDir, "tmp", `${name}.eml`);
  const body = typeof message === "string" ? message : renderMessage(message);
  writeFileSync(temporary, mozillaStatusHeaders(status) + body);
  const destination = join(folderDir, "cur", `${name}.eml`);
  renameSync(temporary, destination);
  return destination;
}

/**
 * Change a stored message's flags the way Thunderbird does: its status
 * headers are rewritten in place, at the same width, so the file keeps its
 * name and size and only its modification time moves.
 */
export function setThunderbirdStatus(path: string, status: MozillaStatus, mtime: Date): void {
  const text = readFileSync(path, "latin1").replace(
    /^X-Mozilla-Status: [0-9a-f]{4}\r\nX-Mozilla-Status2: [0-9a-f]{8}\r\n/,
    mozillaStatusHeaders(status),
  );
  writeFileSync(path, text, "latin1");
  utimesSync(path, mtime, mtime);
}

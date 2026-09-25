// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { SyncError } from "@omnesis/types";
import type { MessageAddressObject, MessageEnvelopeObject, MessageStructureObject } from "imapflow";
import type {
  ImapAddress,
  ImapAttachmentPart,
  ImapClient,
  ImapEnvelope,
  ImapMailbox,
  ImapMessage,
  ImapMessageMetadata,
} from "./source.js";

const MAILBOX_LIST_TIMEOUT_MS = 30_000;

export interface ImapConnectionCredentials {
  host: string;
  username: string;
  password: string;
}

interface ImapReadableSocket {
  prependListener(event: "data", listener: (chunk: Buffer) => void): void;
  removeListener(event: "data", listener: (chunk: Buffer) => void): void;
}

export function createImapClient(credentials: ImapConnectionCredentials): ImapClient {
  return new ImapFlowAdapter(credentials);
}

class ImapFlowAdapter implements ImapClient {
  private readonly client: ImapFlow;
  private readonly serverScope: string;

  constructor(credentials: ImapConnectionCredentials) {
    this.serverScope = createHash("sha256").update(credentials.host).digest("hex").slice(0, 16);
    this.client = new ImapFlow({
      host: credentials.host,
      port: 993,
      secure: true,
      auth: { user: credentials.username, pass: credentials.password },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      maxLineLength: 1024 * 1024,
      maxLiteralSize: 2 * 1024 * 1024,
      maxResponseSize: 32 * 1024 * 1024,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async list(maxEntries: number, maxBytes: number): Promise<ImapMailbox[]> {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    ) {
      throw new Error("Invalid IMAP mailbox limit");
    }
    const socket = (this.client as unknown as { socket?: ImapReadableSocket }).socket;
    if (!socket) throw new Error("IMAP socket unavailable for bounded mailbox listing");
    let listed = 0;
    let listedBytes = 0;
    let lineState: "start" | "after-star" | "command" | "ignore" = "start";
    let command = "";
    let limitExceeded = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stopListing = (): void => {
      if (limitExceeded) return;
      limitExceeded = true;
      this.client.close();
    };
    const countListLines = (chunk: Buffer): void => {
      listedBytes += chunk.byteLength;
      if (listedBytes > maxBytes) {
        stopListing();
        return;
      }
      for (const byte of chunk) {
        if (byte === 0x0a) {
          lineState = "start";
          command = "";
          continue;
        }
        if (lineState === "start") {
          if (byte === 0x00) continue;
          lineState = byte === 0x2a ? "after-star" : "ignore";
          continue;
        }
        if (lineState === "after-star") {
          if (byte === 0x20 || byte === 0x09) continue;
          if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) {
            command = String.fromCharCode(byte).toUpperCase();
            lineState = "command";
          } else {
            lineState = "ignore";
          }
          continue;
        }
        if (lineState !== "command") continue;
        if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) {
          if (command.length < 5) command += String.fromCharCode(byte).toUpperCase();
          else lineState = "ignore";
          continue;
        }
        if (byte === 0x20 || byte === 0x09) {
          if (command === "LIST" || command === "XLIST" || command === "LSUB") {
            listed += 1;
            if (listed > maxEntries) stopListing();
          }
        }
        lineState = "ignore";
      }
    };
    socket.prependListener("data", countListLines);
    try {
      let mailboxes;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            this.client.close();
            reject(new Error("IMAP mailbox listing timed out"));
          }, MAILBOX_LIST_TIMEOUT_MS);
          timeout.unref?.();
        });
        mailboxes = await Promise.race([this.client.list(), deadline]);
      } catch (error) {
        if (limitExceeded) {
          throw new Error(`IMAP mailbox listing exceeds limit (${maxEntries})`, { cause: error });
        }
        throw error;
      }
      if (limitExceeded || mailboxes.length > maxEntries) {
        throw new Error(`IMAP mailbox listing exceeds limit (${maxEntries})`);
      }
      return mailboxes.map((mailbox) => ({
        path: mailbox.path,
        flags: mailbox.flags,
        specialUse: mailbox.specialUse,
      }));
    } catch (error) {
      throw mapImapError(error);
    } finally {
      if (timeout) clearTimeout(timeout);
      socket.removeListener("data", countListLines);
    }
  }

  async open(path: string): Promise<{ uidValidity: string; uidNext: number }> {
    try {
      const mailbox = await this.client.mailboxOpen(path, { readOnly: true });
      return {
        uidValidity: `${this.serverScope}:${mailbox.uidValidity}`,
        uidNext: mailbox.uidNext,
      };
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async search(query: { since?: Date; uid?: string }): Promise<number[]> {
    try {
      const result = await this.client.search(query, { uid: true });
      if (result === false) throw new Error("IMAP SEARCH failed");
      return result;
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async fetch(uids: number[], maxBytes: number): Promise<ImapMessage[]> {
    try {
      const rows = await this.client.fetchAll(
        uids,
        {
          uid: true,
          envelope: true,
          bodyStructure: true,
          headers: ["references", "list-unsubscribe", "auto-submitted", "precedence"],
          internalDate: true,
        },
        { uid: true },
      );
      const messages: ImapMessage[] = [];
      for (const row of rows) {
        const body = await this.downloadBody(row.uid, row.bodyStructure, maxBytes);
        const headers = unfoldHeaders(row.headers);
        const attachments = findAttachmentParts(row.bodyStructure);
        messages.push({
          uid: row.uid,
          envelope: toEnvelope(row.envelope),
          internalDate: toDate(row.internalDate),
          references: parseReferences(headers),
          listUnsubscribe: headerValue(headers, "list-unsubscribe"),
          autoSubmitted: headerValue(headers, "auto-submitted"),
          precedence: headerValue(headers, "precedence"),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...body,
        });
      }
      return messages;
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async fetchMetadata(
    uids: number[],
    opts?: { attachments?: boolean },
  ): Promise<ImapMessageMetadata[]> {
    try {
      const rows = await this.client.fetchAll(
        uids,
        {
          uid: true,
          internalDate: true,
          envelope: true,
          ...(opts?.attachments ? { bodyStructure: true } : {}),
        },
        { uid: true },
      );
      return rows.map((row) => {
        // A reply that omits the requested BODYSTRUCTURE must fail loudly:
        // treating it as "no attachments" would silently drop the message's
        // child ids from the snapshot and order their deletion.
        if (opts?.attachments && !row.bodyStructure) {
          throw new Error("IMAP server omitted requested BODYSTRUCTURE");
        }
        const attachments = opts?.attachments ? findAttachmentParts(row.bodyStructure) : [];
        return {
          uid: row.uid,
          // Same fallback chain the paged read uses (`internalDate ??
          // envelope date`): one message with a broken INTERNALDATE but a
          // valid Date: header must not wedge the snapshot forever.
          date: toDate(row.internalDate) ?? toDate(row.envelope?.date),
          ...(attachments.length > 0 ? { attachments } : {}),
        };
      });
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async fetchAttachment(uid: number, part: string, maxBytes: number): Promise<Uint8Array> {
    try {
      // Request one byte of headroom: a decoded part larger than the cap then
      // provably exceeds it, without consulting `expectedSize` (which reports
      // the whole message's RFC822.SIZE, not this part's). Extracting a
      // cut-off binary would silently index a fragment, so oversize throws.
      const download = await this.client.download(uid, part, { uid: true, maxBytes: maxBytes + 1 });
      // An expunge between the page fetch and this download makes imapflow
      // resolve with an empty object rather than reject.
      if (!download?.content) {
        throw new Error(`IMAP part ${part} of UID ${uid} vanished before download`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of download.content) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxBytes) throw new Error(`IMAP attachment part exceeds ${maxBytes} bytes`);
        chunks.push(bytes);
      }
      return new Uint8Array(Buffer.concat(chunks));
    } catch (error) {
      throw mapImapError(error);
    }
  }

  private async downloadBody(
    uid: number,
    structure: MessageStructureObject | undefined,
    maxBytes: number,
  ): Promise<Pick<ImapMessage, "text" | "html" | "truncated">> {
    const textPart = findTextPart(structure, "text/plain");
    const htmlPart = findTextPart(structure, "text/html");
    const part = textPart ?? htmlPart;
    if (!part) return {};
    const primary = await this.downloadPart(uid, part, maxBytes);
    const body =
      primary.contentType === "text/html"
        ? { html: primary.content, truncated: primary.truncated }
        : { text: primary.content, truncated: primary.truncated };
    // The HTML sibling of a preferred plain part still carries the schema.org
    // JSON-LD markup transactional multipart/alternative mail embeds, so it is
    // downloaded too, solely for normalization to scan. A truncated sibling
    // yields unparseable markup, which the scan tolerates as "none".
    if (body.text !== undefined && htmlPart !== undefined && htmlPart !== part) {
      const sibling = await this.downloadPart(uid, htmlPart, maxBytes);
      return { ...body, html: sibling.content };
    }
    return body;
  }

  private async downloadPart(
    uid: number,
    part: string,
    maxBytes: number,
  ): Promise<{ content: string; contentType: string; truncated: boolean }> {
    const download = await this.client.download(uid, part, { uid: true, maxBytes });
    // An expunge between the page fetch and this download makes imapflow
    // resolve with an empty object rather than reject; the page fails and the
    // next cycle's search no longer lists the message.
    if (!download?.content) {
      throw new Error(`IMAP part ${part} of UID ${uid} vanished before download`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of download.content) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) throw new Error(`IMAP body part exceeds ${maxBytes} bytes`);
      chunks.push(bytes);
    }
    return {
      content: Buffer.concat(chunks).toString("utf8"),
      // imapflow leaves contentType unset when the part's MIME headers carry
      // no Content-Type even though BODYSTRUCTURE reported the server default
      // — treat it as the RFC 2045 default, text/plain.
      contentType: download.meta.contentType?.toLowerCase() ?? "text/plain",
      // Known bound: imapflow caps the transform INPUT at maxBytes, and a
      // format=flowed or exotic-charset decode can shrink the output below
      // the cap — such a part reads as untruncated. Detecting that would
      // need byte accounting inside imapflow's decode pipeline.
      truncated: download.meta.expectedSize > size && size >= maxBytes,
    };
  }

  async close(): Promise<void> {
    if (!this.client.usable) {
      this.client.close();
      return;
    }
    try {
      await this.client.logout();
    } catch (error) {
      this.client.close();
      throw error;
    }
  }
}

export function mapImapError(error: unknown): Error {
  if (error instanceof SyncError) return error;
  const code = errorCode(error);
  if (
    code === "AUTHENTICATIONFAILED" ||
    (typeof error === "object" &&
      error !== null &&
      "authenticationFailed" in error &&
      error.authenticationFailed === true)
  ) {
    // Scoped `connection`: the host/username/app-password triple validated
    // in provider.ts IS this account's whole credential — there is exactly
    // one source (`imap`) built from it, but what died is the credential
    // itself, not anything specific to that source's own sync state.
    return new SyncError("auth", "IMAP credentials were rejected", {
      cause: error,
      scope: "connection",
    });
  }
  if (
    [
      "CONNECT_TIMEOUT",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      // imapflow's own connection-state codes: a command issued on a dropped
      // or closing connection, and its socket-inactivity timeout.
      "NOCONNECTION",
      "ECONNECTIONCLOSED",
      "ETIMEOUT",
    ].includes(code)
  ) {
    return new SyncError("network", "IMAP server is unreachable", { cause: error });
  }
  // imapflow's server-throttle marker — the server asked us to slow down.
  if (code === "ETHROTTLE") {
    return new SyncError("transient", "IMAP server throttled the connection", { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String(error.code).toUpperCase();
}

/**
 * Attackers control BODYSTRUCTURE, so the walk is bounded: at most this many
 * attachment parts are surfaced per message (a deterministic walk-order
 * prefix, identical on the paged read and the snapshot enumeration), and a
 * filename is capped to this many characters before it feeds dedup and the
 * stable child id.
 */
const MAX_ATTACHMENT_PARTS = 200;
const MAX_ATTACHMENT_FILENAME_CHARS = 255;

/**
 * Walk BODYSTRUCTURE for attachment parts — anything carrying a filename or
 * an explicit attachment disposition. A part with no filename cannot be named
 * or stably identified, so it is left to the marker-less void, mirroring the
 * Gmail walker's filename requirement. Deduplicated by (filename, size), the
 * shape a calendar invite exposed twice takes, first part in walk order wins.
 */
export function findAttachmentParts(
  structure: MessageStructureObject | undefined,
): ImapAttachmentPart[] {
  const parts: ImapAttachmentPart[] = [];
  walkAttachmentParts(structure, parts, true);
  const seen = new Set<string>();
  const deduped: ImapAttachmentPart[] = [];
  for (const part of parts) {
    const key = `${part.filename}\0${part.size ?? "null"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(part);
  }
  return deduped;
}

function walkAttachmentParts(
  structure: MessageStructureObject | undefined,
  out: ImapAttachmentPart[],
  isRoot: boolean,
): void {
  if (!structure || out.length >= MAX_ATTACHMENT_PARTS) return;
  const rawFilename = structure.dispositionParameters?.filename ?? structure.parameters?.name;
  // A single-part message whose whole body is the attachment has no part id;
  // it downloads through the same part-1 fallback the body reader uses.
  const partId = structure.part ?? (isRoot ? "1" : undefined);
  // A zero-length part downloads as `{}` and carries no text to extract;
  // skipped identically here and in the snapshot enumeration.
  if (partId && typeof rawFilename === "string" && rawFilename.length > 0 && structure.size !== 0) {
    const isAttachment =
      structure.disposition?.toLowerCase() === "attachment" ||
      !structure.type.toLowerCase().startsWith("multipart/");
    if (isAttachment) {
      out.push({
        part: partId,
        filename: rawFilename.slice(0, MAX_ATTACHMENT_FILENAME_CHARS),
        mimeType: structure.type.toLowerCase(),
        size: typeof structure.size === "number" ? structure.size : null,
      });
    }
  }
  for (const child of structure.childNodes ?? []) {
    walkAttachmentParts(child, out, false);
  }
}

function findTextPart(
  structure: MessageStructureObject | undefined,
  contentType: "text/plain" | "text/html",
  isRoot = true,
): string | undefined {
  if (
    !structure ||
    structure.disposition?.toLowerCase() === "attachment" ||
    structure.dispositionParameters?.filename ||
    structure.parameters?.name
  ) {
    return undefined;
  }
  if (
    structure.type.toLowerCase() === contentType &&
    (structure.part || isRoot) &&
    // A zero-length part has nothing to download — imapflow resolves `{}`
    // for it, which reads as a vanished part and wedges the page on that
    // message forever. Marketing mail commonly ships an empty text/plain
    // alternative beside its real HTML part; skipping the empty part lets
    // the sibling (or an empty body) stand in.
    structure.size !== 0
  ) {
    return structure.part ?? "1";
  }
  for (const child of structure.childNodes ?? []) {
    const part = findTextPart(child, contentType, false);
    if (part) return part;
  }
  return undefined;
}

function unfoldHeaders(headers?: Buffer): string | undefined {
  if (!headers?.byteLength) return undefined;
  return headers.toString("utf8").replace(/\r?\n[\t ]+/g, " ");
}

/** `name` must be a literal header name — it is interpolated into a RegExp. */
function headerValue(unfolded: string | undefined, name: string): string | undefined {
  if (!unfolded) return undefined;
  const value = unfolded
    .match(new RegExp(`(?:^|\\r?\\n)${name}:[\\t ]*([^\\r\\n]*)`, "i"))?.[1]
    ?.trim();
  return value || undefined;
}

function parseReferences(unfolded?: string): string[] | undefined {
  const value = headerValue(unfolded, "references");
  if (!value) return undefined;
  const ids = value.match(/<[^<>\s]+>/g) ?? value.split(/\s+/);
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 100);
  return unique.length > 0 ? unique : undefined;
}

function toEnvelope(envelope?: MessageEnvelopeObject): ImapEnvelope {
  return {
    subject: envelope?.subject,
    date: envelope?.date,
    from: toAddresses(envelope?.from),
    to: toAddresses(envelope?.to),
    cc: toAddresses(envelope?.cc),
    bcc: toAddresses(envelope?.bcc),
    messageId: envelope?.messageId,
    inReplyTo: envelope?.inReplyTo,
  };
}

function toAddresses(addresses?: MessageAddressObject[]): ImapAddress[] | undefined {
  const result = (addresses ?? []).flatMap((address) =>
    address.address ? [{ name: address.name, address: address.address }] : [],
  );
  return result.length > 0 ? result : undefined;
}

function toDate(value?: Date | string): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import TurndownService from "turndown";
import { parseHTML } from "linkedom";
import ICAL from "ical.js";
import { createLogger } from "@omnesis/core";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:text");

/**
 * Extract text from text-based attachments (plain text, CSV, HTML, Markdown, JSON, ICS).
 * Returns null if extraction fails or content is empty.
 */
export async function extractTextContent(
  data: Uint8Array,
  mimeType: string,
  opts?: { maxTextLength?: number },
): Promise<ExtractionResult | null> {
  if (data.length === 0) return null;

  const maxLen = opts?.maxTextLength ?? 512_000;

  try {
    switch (mimeType) {
      case "text/plain":
      case "text/csv":
      case "text/markdown":
      case "application/json":
        return extractPlainText(data, maxLen);
      case "text/html":
        return extractHtmlText(data, maxLen);
      case "text/calendar":
        return extractCalendarText(data, maxLen);
      default:
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Text extraction failed for ${mimeType} (${data.length} bytes): ${msg}`);
    return null;
  }
}

function extractPlainText(data: Uint8Array, maxLen: number): ExtractionResult | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (!text.trim()) return null;

  if (text.length > maxLen) {
    return { text: text.slice(0, maxLen), truncated: true };
  }
  return { text, truncated: false };
}

/**
 * Minimum input size below which the "implausibly small extraction" guard is
 * disabled. A 200-byte HTML doc legitimately producing 1 byte of markdown is
 * not interesting; the guard exists to catch cases like the 198 KB Oney bank
 * statement that turned into "s".
 */
const HTML_GUARD_MIN_INPUT_BYTES = 1024;

/**
 * Ratio threshold below which we declare extraction failed. Empirically: a
 * legit HTML doc with content + boilerplate compresses to ~5–30% of its
 * source (turndown drops style/CSS/markup); anything under 1% almost
 * certainly means the parser hit a degenerate input and produced nothing
 * useful.
 */
const HTML_GUARD_MIN_OUTPUT_RATIO = 0.01;

function extractHtmlText(data: Uint8Array, maxLen: number): ExtractionResult | null {
  // Decode the bytes. Honour any declared charset (Outlook bank emails arrive
  // as windows-1252 even when the MIME envelope says text/html). On failure
  // fall back to UTF-8 with replacement characters — historical behaviour.
  const html = decodeHtmlBytes(data);
  if (!html.trim()) return null;

  // If the body looks quoted-printable (e.g. mishandled MIME upstream),
  // decode before parsing — otherwise linkedom sees `=3D` instead of `=` and
  // most tags are mangled, producing near-empty output.
  const normalised = looksQuotedPrintable(html) ? decodeQuotedPrintable(html) : html;

  // Wrap in full document structure for linkedom
  const wrappedHtml = normalised.includes("<html")
    ? normalised
    : `<!DOCTYPE html><html><body>${normalised}</body></html>`;
  const { document } = parseHTML(wrappedHtml);

  // Remove script and style elements
  for (const el of document.querySelectorAll("script, style")) {
    el.remove();
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const markdown = turndown.turndown(document.body.innerHTML);

  if (!markdown.trim()) return null;

  // Guard against silent failures — if the extractor returned almost
  // nothing from a non-trivial input, it likely hit something it couldn't
  // parse (encoding mismatch, mangled MIME, hostile markup) and the caller
  // is better off treating it as an extraction failure than indexing useless
  // single-character content.
  if (
    data.length >= HTML_GUARD_MIN_INPUT_BYTES &&
    markdown.trim().length / data.length < HTML_GUARD_MIN_OUTPUT_RATIO
  ) {
    log.warn(
      `HTML extraction produced implausibly small output: ${markdown.trim().length} chars from ${data.length} bytes — treating as failed`,
    );
    return null;
  }

  if (markdown.length > maxLen) {
    return { text: markdown.slice(0, maxLen), truncated: true };
  }
  return { text: markdown, truncated: false };
}

/**
 * Decode an HTML byte buffer honouring any `<meta charset>` or
 * `<meta http-equiv="Content-Type" content="…charset=…">` declaration.
 * Sniffing happens on a UTF-8 / ASCII-best-effort first pass — these meta
 * tags live in the head, well before any high-bit content, so a UTF-8
 * decode of the first 4 KB is enough to find them.
 */
function decodeHtmlBytes(data: Uint8Array): string {
  const SNIFF_BYTES = Math.min(data.length, 4096);
  const sniff = new TextDecoder("utf-8", { fatal: false }).decode(data.subarray(0, SNIFF_BYTES));

  const charsetMatch =
    sniff.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) ||
    sniff.match(/content=["'][^"']*charset=([\w-]+)/i);
  const declared = charsetMatch?.[1]?.toLowerCase();

  // utf-8 is the implicit default — no need to re-decode.
  if (!declared || declared === "utf-8" || declared === "utf8") {
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }

  try {
    return new TextDecoder(declared, { fatal: false }).decode(data);
  } catch {
    // Unknown / unsupported label — fall back to UTF-8 with replacement
    // chars rather than failing the extraction outright.
    log.debug(`Unsupported HTML charset "${declared}" — falling back to UTF-8`);
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }
}

/**
 * Heuristic: a body looks quoted-printable if it contains the QP soft-break
 * pattern (`=\r?\n`) AND a meaningful density of `=XX` hex escapes. This is a
 * cheap pre-check; the actual decode pass is forgiving of partial matches.
 */
function looksQuotedPrintable(html: string): boolean {
  const sample = html.slice(0, 4096);
  if (!/=\r?\n/.test(sample)) return false;
  const matches = sample.match(/=[0-9A-F]{2}/g);
  // ≥10 hex escapes in the first 4 KB is a strong signal — random text or
  // signed URLs may include occasional `=XX`-shaped runs but not at this
  // density.
  return (matches?.length ?? 0) >= 10;
}

/**
 * Decode a quoted-printable string as defined by RFC 2045 §6.7. Handles
 * both `=\r\n` and `=\n` soft line breaks, and `=XX` hex escapes.
 * Leaves bytes that look like QP escapes but aren't valid hex untouched
 * (lenient mode — these are rare and harmless).
 */
function decodeQuotedPrintable(qp: string): string {
  // Decode soft line breaks, then turn the string into the byte sequence it
  // encodes (=XX → that byte; literal chars → their byte) and decode the
  // buffer as text. Decoding per-`=XX`-char (String.fromCharCode) corrupts
  // multi-byte UTF-8: `é` (=C3=A9) would become "Ã©". Prefer UTF-8 (the
  // dominant email/HTML charset); fall back to Latin-1 for bodies that are
  // genuinely ISO-8859-1 (e.g. a lone =A3 meaning £, which is invalid UTF-8).
  const unfolded = qp.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i];
    if (
      ch === "=" &&
      i + 2 < unfolded.length &&
      /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  const buf = new Uint8Array(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("latin1").decode(buf);
  }
}

function extractCalendarText(data: Uint8Array, maxLen: number): ExtractionResult | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (!text.trim()) return null;

  let jcalData: unknown;
  try {
    jcalData = ICAL.parse(text);
  } catch {
    log.debug(`Failed to parse ICS data (${data.length} bytes)`);
    return null;
  }

  const comp = new ICAL.Component(jcalData as unknown[]);
  const events = comp.getAllSubcomponents("vevent");
  const todos = comp.getAllSubcomponents("vtodo");

  if (events.length === 0 && todos.length === 0) return null;

  const parts: string[] = [];
  // RFC 5545 UIDs from each VEVENT — the cross-source link key.
  // VTODOs also carry UIDs but we have no todo source on the resolve side
  // today, so skip them. Dedupe in case an ICS file has multiple VEVENTs
  // with the same UID (recurring-event RECURRENCE-ID overrides).
  const uids = new Set<string>();

  for (const vevent of events) {
    const event = new ICAL.Event(vevent);
    parts.push(formatEvent(event, vevent));
    const uid = vevent.getFirstPropertyValue("uid") as string | null;
    if (typeof uid === "string" && uid.trim().length > 0) {
      uids.add(uid.trim());
    }
  }

  for (const vtodo of todos) {
    parts.push(formatTodo(vtodo));
  }

  const result = parts.join("\n\n");
  if (!result.trim()) return null;

  const extra = uids.size > 0 ? { iCalUIDs: [...uids] } : undefined;

  if (result.length > maxLen) {
    return { text: result.slice(0, maxLen), truncated: true, extra };
  }
  return { text: result, truncated: false, extra };
}

function formatEvent(event: ICAL.Event, vevent: ICAL.Component): string {
  const lines: string[] = [];
  const summary = event.summary || "(no title)";
  lines.push(`## Event: ${summary}`);

  const dtstart = event.startDate;
  const dtend = event.endDate;
  if (dtstart) {
    if (dtstart.isDate) {
      // All-day event
      if (dtend && !dtend.toString().startsWith(dtstart.toString())) {
        lines.push(`**When:** ${formatDate(dtstart)} – ${formatDate(dtend)}`);
      } else {
        lines.push(`**When:** ${formatDate(dtstart)} (all day)`);
      }
    } else {
      if (dtend) {
        lines.push(`**When:** ${formatDateTime(dtstart)} – ${formatDateTime(dtend)}`);
      } else {
        lines.push(`**When:** ${formatDateTime(dtstart)}`);
      }
    }
  }

  const location = event.location;
  if (location) {
    lines.push(`**Location:** ${location}`);
  }

  // Attendees
  const attendees = vevent.getAllProperties("attendee");
  if (attendees.length > 0) {
    const names = attendees.map((a: ICAL.Property) => {
      const cn = a.getParameter("cn");
      const val = a.getFirstValue() as string;
      const email = val?.replace(/^mailto:/i, "");
      return cn ? `${cn}` : email || "unknown";
    });
    lines.push(`**Attendees:** ${names.join(", ")}`);
  }

  const description = event.description;
  if (description) {
    lines.push("");
    lines.push(description.trim());
  }

  return lines.join("\n");
}

function formatTodo(vtodo: ICAL.Component): string {
  const lines: string[] = [];
  const summary = (vtodo.getFirstPropertyValue("summary") as string) || "(no title)";
  lines.push(`## Todo: ${summary}`);

  const due = vtodo.getFirstPropertyValue("due") as ICAL.Time | null;
  if (due) {
    lines.push(`**Due:** ${due.isDate ? formatDate(due) : formatDateTime(due)}`);
  }

  const status = vtodo.getFirstPropertyValue("status") as string | null;
  if (status) {
    lines.push(`**Status:** ${status}`);
  }

  const description = vtodo.getFirstPropertyValue("description") as string | null;
  if (description) {
    lines.push("");
    lines.push(description.trim());
  }

  return lines.join("\n");
}

function formatDate(dt: ICAL.Time): string {
  return `${dt.year}-${String(dt.month).padStart(2, "0")}-${String(dt.day).padStart(2, "0")}`;
}

function formatDateTime(dt: ICAL.Time): string {
  const date = formatDate(dt);
  const time = `${String(dt.hour).padStart(2, "0")}:${String(dt.minute).padStart(2, "0")}`;
  return `${date} ${time}`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import PostalMime from "postal-mime";
import TurndownService from "turndown";
import { createLogger } from "@omnesis/core";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:eml");

/**
 * Extract text from EML (RFC 822) email messages.
 * Returns null if extraction fails or content is empty.
 */
export async function extractEmlText(
  data: Uint8Array,
  opts?: { maxTextLength?: number },
): Promise<ExtractionResult | null> {
  if (data.length === 0) return null;

  const maxLen = opts?.maxTextLength ?? 512_000;

  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    if (!text.trim()) return null;

    const parser = new PostalMime();
    const email = await parser.parse(text);

    return formatEmail(email, maxLen);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`EML extraction failed (${data.length} bytes): ${msg}`);
    return null;
  }
}

interface ParsedEmail {
  subject?: string;
  from?: { name?: string; address?: string };
  to?: Array<{ name?: string; address?: string }>;
  cc?: Array<{ name?: string; address?: string }>;
  date?: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename?: string | null;
    mimeType?: string;
    size?: number;
    disposition?: string | null;
  }>;
}

function formatEmail(email: ParsedEmail, maxLen: number): ExtractionResult | null {
  const lines: string[] = [];

  // Subject as heading
  const subject = email.subject || "(no subject)";
  lines.push(`# ${subject}`);
  lines.push("");

  // Headers
  if (email.from) {
    const from = formatAddress(email.from);
    if (from) lines.push(`**From:** ${from}`);
  }

  if (email.to && email.to.length > 0) {
    const to = email.to.map(formatAddress).filter(Boolean).join(", ");
    if (to) lines.push(`**To:** ${to}`);
  }

  if (email.cc && email.cc.length > 0) {
    const cc = email.cc.map(formatAddress).filter(Boolean).join(", ");
    if (cc) lines.push(`**Cc:** ${cc}`);
  }

  if (email.date) {
    lines.push(`**Date:** ${email.date}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  // Body — prefer text, fallback to HTML
  let body = "";
  if (email.text?.trim()) {
    body = email.text.trim();
  } else if (email.html?.trim()) {
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    body = turndown.turndown(email.html).trim();
  }

  if (body) {
    lines.push(body);
  }

  // Attachment listing (non-inline only, no recursive extraction)
  const attachments = (email.attachments ?? []).filter(
    (a) => a.disposition !== "inline" && a.filename,
  );
  if (attachments.length > 0) {
    lines.push("");
    lines.push("---");
    const attList = attachments.map((a) => {
      const parts: string[] = [a.filename || "unnamed"];
      if (a.mimeType) {
        parts.push(`(${mimeLabel(a.mimeType)}${a.size ? `, ${formatSize(a.size)}` : ""})`);
      }
      return parts.join(" ");
    });
    lines.push(`**Attachments:** ${attList.join(", ")}`);
  }

  const result = lines.join("\n");
  if (!result.trim() || (!body && attachments.length === 0)) return null;

  const truncated = false;
  if (result.length > maxLen) {
    return { text: result.slice(0, maxLen), truncated: true };
  }
  return { text: result, truncated: truncated };
}

function formatAddress(addr: { name?: string; address?: string }): string {
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address || addr.name || "";
}

function mimeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": "PDF",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
    "application/msword": "DOC",
    "application/vnd.ms-excel": "XLS",
    "application/x-msexcel": "XLS",
    "application/vnd.ms-powerpoint": "PPT",
    "application/vnd.oasis.opendocument.text": "ODT",
    "application/vnd.oasis.opendocument.spreadsheet": "ODS",
    "application/vnd.oasis.opendocument.presentation": "ODP",
    "application/rtf": "RTF",
    "text/rtf": "RTF",
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "text/plain": "Text",
    "text/csv": "CSV",
  };
  return map[mimeType] ?? mimeType.split("/").pop()?.toUpperCase() ?? mimeType;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

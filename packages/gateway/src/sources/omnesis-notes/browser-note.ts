// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { extractUrls, normalizeUrl } from "@omnesis/core";
import type { NoteEntry, NotePageContext } from "./storage.js";

/** Context stays attached even when a browser note's user text changes. */
export function browserNoteContext(page: NotePageContext): string {
  const title = page.title?.replace(/\s+/g, " ").trim();
  const quote = page.selection
    ? `\n\nSelected passage:\n${page.selection
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`
    : "";
  return `\n\nPage: ${title ? `${title} — ` : ""}${page.url}${quote}`;
}

export function browserNoteUserText(entry: NoteEntry): string {
  if (!entry.page) return entry.text;
  const suffix = browserNoteContext(entry.page);
  return entry.text.endsWith(suffix) ? entry.text.slice(0, -suffix.length) : entry.text;
}

/** Opaque optimistic revision includes content, so identical timestamps cannot lose an edit. */
export function browserNoteRevision(entry: NoteEntry): string {
  return createHash("sha256")
    .update(JSON.stringify([entry.id, entry.updatedAt, entry.text]))
    .digest("hex");
}

/** Only exact normalized URL evidence associates an individual entry with a page. */
export function browserNoteMatchesPage(entry: NoteEntry, url: string): boolean {
  return (
    (entry.page !== undefined && normalizeUrl(entry.page.url) === url) ||
    extractUrls(entry.text).some((candidate) => normalizeUrl(candidate) === url)
  );
}

/** Immutable capture identity is independent of later edits to the saved text. */
export function browserNoteCaptureDigest(text: string, page: NotePageContext): string {
  return createHash("sha256")
    .update(JSON.stringify([text, page.url, page.title ?? null, page.selection ?? null]))
    .digest("hex");
}

/** Internal capture identity never appears in a client-facing note or page object. */
export function publicBrowserNoteEntry(entry: NoteEntry): NoteEntry {
  if (!entry.page?.captureDigest) return entry;
  const { captureDigest: _digest, ...page } = entry.page;
  return { ...entry, page };
}

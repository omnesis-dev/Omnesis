// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, fileKindName } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { LocalFileEntry } from "./types.js";
import type { ExtractionResult } from "@omnesis/core";

/** Folder segments become facet tags — at most this many, longest-prefix. */
const MAX_TAG_SEGMENTS = 8;
const MAX_TAG_LENGTH = 64;
/** Below this much non-space text the document is noise, not signal. */
const LOW_SIGNAL_TEXT_CHARS = 100;

function folderTags(dirSegments: string[]): string[] {
  return dirSegments
    .filter((s) => s.length > 0)
    .slice(0, MAX_TAG_SEGMENTS)
    .map((s) => (s.length > MAX_TAG_LENGTH ? s.slice(0, MAX_TAG_LENGTH) : s));
}

export interface NormalizedFile {
  doc: DocumentInput;
  contentHash: string;
}

export function normalizeFile(
  entry: LocalFileEntry,
  extractedText: string,
  extractedExtra: ExtractionResult["extra"],
  providerId: ProviderId,
  sourceId: SourceId,
): NormalizedFile {
  const text = extractedText.length > 0 ? extractedText : "";
  const content = [
    `# ${entry.displayPath.split("/").pop()}`,
    "",
    `**Type:** ${fileKindName(entry.mimeType)}`,
    `**Location:** ${entry.displayPath}`,
    "",
    "---",
    "",
    text,
  ].join("\n");

  const contentHash = computeContentHash(content);
  // Hash the raw extracted text — not the rendered wrapper — so the same
  // bytes match across sources that render differently. This is the
  // cross-source `duplicate-content` join key (Drive, mail attachments).
  const extractedContentHash = computeContentHash(text);
  const nonSpace = text.replace(/\s/g, "").length;

  const doc: DocumentInput = {
    providerId,
    sourceId,
    externalId: "", // filled by the caller with the stableId
    title: entry.displayPath.split("/").pop() ?? entry.displayPath,
    content,
    contentHash,
    extractedContentHash,
    metadata: {
      // No reliable destination exists: `file:` is blocked in both clients
      // and a device-qualified path is an internal identity URI. Omitted
      // per the sourceUrl contract; the path below is display, not action.
      tags: folderTags(entry.dirSegments),
      documentType: "file",
      // Your-own-data source: no platform identity, just authorship.
      people: [{ role: "author", isSelf: true }],
      ...(nonSpace < LOW_SIGNAL_TEXT_CHARS ? { lowSignal: true as const } : {}),
      extra: {
        ...(extractedExtra ?? {}),
        path: entry.displayPath,
        directory: entry.dirSegments.join("/"),
        mimeType: entry.mimeType,
        fileSize: entry.size,
      },
    },
    sourceCreatedAt: new Date(entry.ctime).toISOString(),
    sourceUpdatedAt: new Date(entry.mtime).toISOString(),
  };
  return { doc, contentHash };
}

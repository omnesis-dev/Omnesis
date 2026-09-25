// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { normalizeFile } from "./normalizer.js";
import type { LocalFileEntry } from "./types.js";

const providerId = ProviderId("local-files:host");
const sourceId = SourceId("local-files:host");

function entry(overrides: Partial<LocalFileEntry> = {}): LocalFileEntry {
  return {
    absolutePath: "/tmp/Docs/Insurance/quote.pdf",
    displayPath: "~/Docs/Insurance/quote.pdf",
    dirSegments: ["Docs", "Insurance"],
    mimeType: "application/pdf",
    via: "extract",
    mtime: 1_700_000_000_000,
    ctime: 1_700_000_000_000,
    size: 1024,
    inode: 42,
    device: 7,
    ...overrides,
  };
}

describe("normalizeFile", () => {
  test("emits a file document with the cross-source join key", () => {
    const text = "Total due: 120 credits. See account summary attached.";
    const { doc, contentHash } = normalizeFile(entry(), text, undefined, providerId, sourceId);
    expect(doc.metadata.documentType).toBe("file");
    expect(doc.metadata.sourceUrl).toBeUndefined();
    expect(doc.extractedContentHash).toBe(computeContentHash(text));
    expect(doc.contentHash).toBe(contentHash);
    expect(doc.contentHash).not.toBe(doc.extractedContentHash);
    expect(doc.metadata.people).toEqual([{ role: "author", isSelf: true }]);
    expect(doc.metadata.tags).toEqual(["Docs", "Insurance"]);
    expect(doc.metadata.extra).toMatchObject({
      path: "~/Docs/Insurance/quote.pdf",
      directory: "Docs/Insurance",
      mimeType: "application/pdf",
      fileSize: 1024,
    });
    expect(doc.title).toBe("quote.pdf");
  });

  test("flags near-empty documents as low-signal", () => {
    const { doc } = normalizeFile(entry(), "   \n  hi  ", undefined, providerId, sourceId);
    expect(doc.metadata.lowSignal).toBe(true);
  });

  test("carries extractor extras through", () => {
    const { doc } = normalizeFile(entry(), "scanned text", { ocr: true }, providerId, sourceId);
    expect(doc.metadata.extra).toMatchObject({ ocr: true });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { gzipSync } from "node:zlib";
import { describe, test, expect } from "vitest";
import { parseNoteBody, parseNoteProtobuf, coreDataToDate, coreDataToISO } from "./note-parser.js";

/**
 * Build a minimal protobuf buffer for testing.
 * This manually constructs the wire format for NoteStoreProto -> Document -> Note
 */

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(data.length), data]);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)]);
}

function encodeStringField(fieldNumber: number, str: string): Buffer {
  const strBuf = Buffer.from(str, "utf-8");
  return encodeLengthDelimited(fieldNumber, strBuf);
}

/**
 * Build a Note protobuf with text and optional attribute runs
 */
function buildNoteProto(
  text: string,
  runs?: { length: number; style?: number; link?: string; isTodo?: boolean; todoDone?: boolean }[],
): Buffer {
  const parts: Buffer[] = [encodeStringField(2, text)];

  if (runs) {
    for (const run of runs) {
      const runParts: Buffer[] = [encodeVarintField(1, run.length)];

      if (run.style !== undefined || run.isTodo) {
        const styleParts: Buffer[] = [];
        if (run.style !== undefined) {
          styleParts.push(encodeVarintField(1, run.style));
        }
        if (run.isTodo) {
          const todoParts = [encodeVarintField(2, run.todoDone ? 1 : 0)];
          styleParts.push(encodeLengthDelimited(5, Buffer.concat(todoParts)));
        }
        runParts.push(encodeLengthDelimited(2, Buffer.concat(styleParts)));
      }

      if (run.link) {
        runParts.push(encodeStringField(9, run.link));
      }

      parts.push(encodeLengthDelimited(5, Buffer.concat(runParts)));
    }
  }

  const noteBuf = Buffer.concat(parts);
  // Note is field 3 of Document
  const documentBuf = encodeLengthDelimited(3, noteBuf);
  // Document is field 2 of NoteStoreProto
  return encodeLengthDelimited(2, documentBuf);
}

describe("parseNoteBody", () => {
  test("parses a simple text note", () => {
    const proto = buildNoteProto("My Title\nHello, world!\nSecond line.");
    const gzipped = gzipSync(proto);

    const result = parseNoteBody(gzipped);
    // Title is stripped (first line), so we should get the body
    expect(result).toContain("Hello, world!");
    expect(result).toContain("Second line.");
    expect(result).not.toContain("My Title");
  });

  test("returns empty string for invalid data", () => {
    const result = parseNoteBody(Buffer.from("not gzipped data"));
    expect(result).toBe("");
  });

  test("returns empty string for empty buffer", () => {
    const result = parseNoteBody(Buffer.alloc(0));
    expect(result).toBe("");
  });
});

describe("parseNoteProtobuf", () => {
  test("extracts plain text from protobuf", () => {
    const proto = buildNoteProto("Title\nBody text here.");
    const result = parseNoteProtobuf(proto);
    expect(result).toBe("Body text here.");
  });

  test("handles note with only title", () => {
    const proto = buildNoteProto("Just a title\n");
    const result = parseNoteProtobuf(proto);
    expect(result).toBe("");
  });

  test("handles heading attribute run", () => {
    const text = "Title\nSection Header\nBody text.\n";
    const proto = buildNoteProto(text, [
      { length: 6 }, // "Title\n"
      { length: 15, style: 1 }, // "Section Header\n" with heading style
      { length: 11 }, // "Body text.\n"
    ]);

    const result = parseNoteProtobuf(proto);
    expect(result).toContain("## Section Header");
    expect(result).toContain("Body text.");
  });

  test("handles todo/checklist items", () => {
    const text = "Title\nBuy milk\nClean house\n";
    const proto = buildNoteProto(text, [
      { length: 6 }, // "Title\n"
      { length: 9, isTodo: true, todoDone: false }, // "Buy milk\n"
      { length: 12, isTodo: true, todoDone: true }, // "Clean house\n"
    ]);

    const result = parseNoteProtobuf(proto);
    expect(result).toContain("- [ ] Buy milk");
    expect(result).toContain("- [x] Clean house");
  });

  test("handles bullet list items", () => {
    const text = "Title\nItem one\nItem two\n";
    const proto = buildNoteProto(text, [
      { length: 6 }, // "Title\n"
      { length: 9, style: 100 }, // "Item one\n" dotted list
      { length: 9, style: 101 }, // "Item two\n" dashed list
    ]);

    const result = parseNoteProtobuf(proto);
    expect(result).toContain("- Item one");
    expect(result).toContain("- Item two");
  });

  test("handles numbered list items", () => {
    const text = "Title\nFirst\nSecond\n";
    const proto = buildNoteProto(text, [
      { length: 6 }, // "Title\n"
      { length: 6, style: 102 }, // "First\n" numbered
      { length: 7, style: 102 }, // "Second\n" numbered
    ]);

    const result = parseNoteProtobuf(proto);
    expect(result).toContain("1. First");
    expect(result).toContain("1. Second");
  });

  test("handles links", () => {
    const text = "Title\nClick here for info.\n";
    const proto = buildNoteProto(text, [
      { length: 6 }, // "Title\n"
      { length: 10, link: "https://example.com" }, // "Click here"
      { length: 11 }, // " for info.\n"
    ]);

    const result = parseNoteProtobuf(proto);
    expect(result).toContain("[Click here](https://example.com)");
  });

  test("merges fragmented runs that share the same link target into one", () => {
    // Reproduces apple-notes-url-fragmented-into-character-chunks: Apple
    // Notes splits a URL's display text across multiple runs (typeface /
    // kerning), so the renderer used to emit one markdown link per run.
    // Body: "Title\nParagraph anthropic.com\n"
    const text = "Title\nParagraph http://anthropic.com\n";
    const url = "http://anthropic.com";
    const proto = buildNoteProto(text, [
      { length: 6 }, // "Title\n"
      { length: 10 }, // "Paragraph "
      { length: 4, link: url }, // "http"
      { length: 3, link: url }, // "://"
      { length: 4, link: url }, // "anth"
      { length: 5, link: url }, // "ropic"
      { length: 4, link: url }, // ".com"
      { length: 1 }, // "\n"
    ]);

    const result = parseNoteProtobuf(proto);
    // The auto-link collapse drops the markdown wrapping because the
    // anchor text equals the URL.
    expect(result).toContain("Paragraph http://anthropic.com");
    expect(result).not.toContain("[http]");
    expect(result).not.toContain("[://]");
    expect(result).not.toContain("[ropic]");
  });

  test("merges fragmented runs but preserves anchor text when it differs from the URL", () => {
    const text = "Title\nClick here site\n";
    const url = "https://example.com";
    const proto = buildNoteProto(text, [
      { length: 6 }, // "Title\n"
      { length: 5, link: url }, // "Click"
      { length: 5, link: url }, // " here"
      { length: 5 }, // " site"
      { length: 1 }, // "\n"
    ]);

    const result = parseNoteProtobuf(proto);
    expect(result).toContain("[Click here](https://example.com) site");
    // Each fragment shouldn't appear as its own link.
    expect(result).not.toContain("[Click](");
    expect(result).not.toContain("[ here](");
  });

  test("handles monospaced text", () => {
    const text = "Title\ncode block\n";
    const proto = buildNoteProto(text, [
      { length: 6 }, // "Title\n"
      { length: 11, style: 4 }, // "code block\n" monospaced
    ]);

    const result = parseNoteProtobuf(proto);
    expect(result).toContain("`code block`");
  });

  test("handles multiline body", () => {
    const text = "My Note\nLine 1\nLine 2\nLine 3\n";
    const proto = buildNoteProto(text);

    const result = parseNoteProtobuf(proto);
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
    expect(result).toContain("Line 3");
    expect(result).not.toContain("My Note");
  });
});

describe("coreDataToDate", () => {
  test("converts Core Data timestamp to JS Date", () => {
    // 2024-03-08 00:00:00 UTC
    // Unix: 1709856000
    // Core Data: 1709856000 - 978307200 = 731548800
    const date = coreDataToDate(731548800);
    expect(date.toISOString()).toBe("2024-03-08T00:00:00.000Z");
  });

  test("converts Apple epoch (0) to 2001-01-01", () => {
    const date = coreDataToDate(0);
    expect(date.toISOString()).toBe("2001-01-01T00:00:00.000Z");
  });

  test("coreDataToISO returns ISO string", () => {
    const iso = coreDataToISO(731548800);
    expect(iso).toBe("2024-03-08T00:00:00.000Z");
  });
});

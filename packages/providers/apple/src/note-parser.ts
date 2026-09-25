// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { gunzipSync } from "node:zlib";
import { createLogger, toErrorMessage } from "@omnesis/core";

const log = createLogger("apple-notes:parser");

/**
 * Protobuf wire types
 */
const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32BIT = 5;

interface ProtoField {
  fieldNumber: number;
  wireType: number;
  value: Buffer | number | bigint;
}

/**
 * Paragraph style constants from the Apple Notes protobuf
 */
const PARAGRAPH_STYLES: Record<number, string> = {
  0: "title",
  1: "heading",
  2: "subheading",
  4: "monospaced",
  100: "dotted-list",
  101: "dashed-list",
  102: "numbered-list",
  103: "todo",
};

/**
 * Parse a protobuf varint from the buffer at the given offset.
 * Returns [value, bytesRead].
 */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset < buf.length) {
    const byte = buf[offset++];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("Varint too long");
  }

  return [result >>> 0, bytesRead];
}

/**
 * Parse all top-level fields from a protobuf message buffer.
 */
function parseProtoFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const [tag, tagBytes] = readVarint(buf, offset);
    offset += tagBytes;

    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    if (fieldNumber === 0) break;

    switch (wireType) {
      case WIRE_VARINT: {
        const [value, valueBytes] = readVarint(buf, offset);
        offset += valueBytes;
        fields.push({ fieldNumber, wireType, value });
        break;
      }
      case WIRE_64BIT: {
        const value = buf.subarray(offset, offset + 8);
        offset += 8;
        fields.push({ fieldNumber, wireType, value: Buffer.from(value) });
        break;
      }
      case WIRE_LENGTH_DELIMITED: {
        const [length, lengthBytes] = readVarint(buf, offset);
        offset += lengthBytes;
        const value = buf.subarray(offset, offset + length);
        offset += length;
        fields.push({ fieldNumber, wireType, value: Buffer.from(value) });
        break;
      }
      case WIRE_32BIT: {
        const value = buf.subarray(offset, offset + 4);
        offset += 4;
        fields.push({ fieldNumber, wireType, value: Buffer.from(value) });
        break;
      }
      default:
        // Unknown wire type — can't continue parsing
        return fields;
    }
  }

  return fields;
}

/**
 * Get a nested submessage by following a path of field numbers.
 * e.g., getNestedMessage(buf, [2, 3]) gets field 2 then field 3 within it.
 */
function getNestedMessage(buf: Buffer, path: number[]): Buffer | null {
  let current = buf;

  for (const fieldNum of path) {
    const fields = parseProtoFields(current);
    const field = fields.find(
      (f) => f.fieldNumber === fieldNum && f.wireType === WIRE_LENGTH_DELIMITED,
    );
    if (!field || !(field.value instanceof Buffer)) return null;
    current = field.value;
  }

  return current;
}

/**
 * Get a varint field value from a protobuf buffer.
 */
function getVarintField(buf: Buffer, fieldNumber: number): number | null {
  const fields = parseProtoFields(buf);
  const field = fields.find((f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_VARINT);
  return field ? (field.value as number) : null;
}

/**
 * Get a string field from a protobuf buffer.
 */
function getStringField(buf: Buffer, fieldNumber: number): string | null {
  const fields = parseProtoFields(buf);
  const field = fields.find(
    (f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_LENGTH_DELIMITED,
  );
  if (!field || !(field.value instanceof Buffer)) return null;
  return field.value.toString("utf-8");
}

/**
 * Get all length-delimited fields with a given field number.
 */
function getAllLengthFields(buf: Buffer, fieldNumber: number): Buffer[] {
  const fields = parseProtoFields(buf);
  return fields
    .filter(
      (f) =>
        f.fieldNumber === fieldNumber &&
        f.wireType === WIRE_LENGTH_DELIMITED &&
        f.value instanceof Buffer,
    )
    .map((f) => f.value as Buffer);
}

interface AttributeRun {
  length: number;
  style?: string;
  isTodo?: boolean;
  todoDone?: boolean;
  link?: string;
  attachmentId?: string;
  indent?: number;
}

/**
 * Parse an attribute run from its protobuf buffer.
 */
function parseAttributeRun(buf: Buffer): AttributeRun {
  const length = getVarintField(buf, 1) ?? 0;
  const run: AttributeRun = { length };

  // Field 2: paragraph_style
  const paragraphStyleBuf = getNestedMessage(buf, [2]);
  if (paragraphStyleBuf) {
    const styleNum = getVarintField(paragraphStyleBuf, 1);
    if (styleNum !== null && PARAGRAPH_STYLES[styleNum]) {
      run.style = PARAGRAPH_STYLES[styleNum];
    }
    const indent = getVarintField(paragraphStyleBuf, 4);
    if (indent !== null) {
      run.indent = indent;
    }
    // Field 5: todo
    const todoBuf = getNestedMessage(paragraphStyleBuf, [5]);
    if (todoBuf) {
      run.isTodo = true;
      run.todoDone = getVarintField(todoBuf, 2) === 1;
    }
  }

  // Field 9: link URL
  const link = getStringField(buf, 9);
  if (link) run.link = link;

  // Field 12: attachment info
  const attachBuf = getNestedMessage(buf, [12]);
  if (attachBuf) {
    run.attachmentId = getStringField(attachBuf, 1) ?? undefined;
  }

  return run;
}

/**
 * Parse the gzipped protobuf note body into markdown text.
 *
 * The protobuf structure is:
 *   NoteStoreProto (field 2) -> Document (field 3) -> Note
 *   Note.note_text (field 2) = plain text
 *   Note.attribute_run (field 5, repeated) = formatting runs
 */
export function parseNoteBody(gzippedData: Buffer): string {
  try {
    const decompressed = gunzipSync(gzippedData);
    return parseNoteProtobuf(decompressed);
  } catch (err) {
    log.debug("Failed to parse note body", {
      error: toErrorMessage(err),
    });
    return "";
  }
}

/**
 * Parse the decompressed protobuf into markdown.
 * Exported for testing.
 */
export function parseNoteProtobuf(buf: Buffer): string {
  // Path: field 2 (Document) -> field 3 (Note)
  const noteBuf = getNestedMessage(buf, [2, 3]);
  if (!noteBuf) return "";

  // Field 2: plain text
  const noteText = getStringField(noteBuf, 2);
  if (!noteText) return "";

  // Field 5: attribute runs (repeated)
  const runBufs = getAllLengthFields(noteBuf, 5);
  if (runBufs.length === 0) {
    // No attribute runs — strip the title and return plain text
    return stripTitle(noteText);
  }

  const runs = runBufs.map(parseAttributeRun);

  // Apply attribute runs to the text to produce markdown
  return applyAttributeRuns(noteText, runs);
}

/**
 * Strip the first line (title) from the note text.
 */
function stripTitle(text: string): string {
  const idx = text.indexOf("\n");
  if (idx === -1) return "";
  const body = text.slice(idx + 1);
  // Remove leading blank lines
  return body.replace(/^\n+/, "").trim();
}

/**
 * Apply attribute runs to the note text to produce markdown.
 *
 * In Apple Notes protobuf, each attribute run covers N characters and
 * specifies paragraph-level formatting (heading, list, todo) that applies
 * to lines whose trailing newline falls within that run.
 */
function applyAttributeRuns(text: string, runs: AttributeRun[]): string {
  // First, build a per-character map of which run each character belongs to
  const charRuns: AttributeRun[] = [];
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      charRuns.push(run);
    }
  }

  // Split text into lines and find the run that owns each line's newline
  const lines: string[] = [];
  let lineStart = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      const lineText = text.slice(lineStart, i);
      // The run owning the newline character determines the line's formatting
      const lineRun = charRuns[i] ?? runs[runs.length - 1];
      lines.push(formatLine(lineText, lineRun));
      lineStart = i + 1;
    }
  }

  // Handle any trailing text without a final newline
  if (lineStart < text.length) {
    const lineText = text.slice(lineStart);
    const lineRun = charRuns[lineStart] ?? runs[runs.length - 1];
    lines.push(formatLine(lineText, lineRun));
  }

  // Apply inline formatting (links, attachments) — rebuild lines
  // by re-scanning runs for inline-only attributes
  const formattedLines = applyInlineFormatting(text, runs, lines);

  // Remove the title line (first line) — Apple Notes always puts title first
  if (formattedLines.length > 0) {
    formattedLines.shift();
    while (formattedLines.length > 0 && formattedLines[0].trim() === "") {
      formattedLines.shift();
    }
  }

  return formattedLines.join("\n").trim();
}

/**
 * Apply inline formatting (links, attachments) to already-formatted lines.
 */
function applyInlineFormatting(text: string, runs: AttributeRun[], lines: string[]): string[] {
  // Check if any runs have inline formatting
  const hasInline = runs.some((r) => r.link || r.attachmentId);
  if (!hasInline) return lines;

  // Rebuild from scratch with inline formatting
  const result: string[] = [];
  let charIndex = 0;
  let currentLine = "";
  let currentLineRun: AttributeRun = runs[0];

  for (const run of runs) {
    const runText = text.slice(charIndex, charIndex + run.length);
    charIndex += run.length;

    const parts = runText.split("\n");

    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // Emit line with its paragraph formatting
        result.push(formatLine(currentLine, currentLineRun));
        currentLine = "";
        currentLineRun = run;
      }

      const part = parts[i];
      if (run.link && part.length > 0) {
        currentLine += `[${part}](${run.link})`;
      } else if (run.attachmentId && part.length > 0) {
        currentLine += `[attachment: ${run.attachmentId}]`;
      } else {
        currentLine += part;
      }

      // The run whose text includes the newline owns the line format
      if (i < parts.length - 1) {
        currentLineRun = run;
      }
    }
  }

  if (currentLine.length > 0) {
    result.push(formatLine(currentLine, currentLineRun));
  }

  return result.map(mergeAdjacentLinks);
}

/**
 * Collapse consecutive markdown links that share the same target into one.
 *
 * Apple Notes stores a hyperlink as an attributed-string annotation that
 * spans a character range, but the *runs* inside that range can be split
 * arbitrarily (kerning, font shaping, …) — so a URL like
 * "http://anthropic.com" arrives as e.g. `[http](url)[://](url)[anth](url)…`.
 * The renderer emits one markdown link per run, polluting the body. This
 * post-pass walks the line and merges any `[a](url)[b](url)` pair sharing
 * the same target into `[ab](url)`, iterating until stable so chains of
 * any length collapse. When the resulting anchor text equals the URL we
 * also drop the markdown wrapping — a plain `http://anthropic.com` is what
 * the user typed, and the URL extractor still finds it.
 */
function mergeAdjacentLinks(line: string): string {
  let prev: string;
  let curr = line;
  do {
    prev = curr;
    curr = curr.replace(/\[([^\]]*)\]\(([^)]+)\)\[([^\]]*)\]\(\2\)/g, "[$1$3]($2)");
  } while (curr !== prev);
  // Auto-link collapse: [http://x](http://x) → http://x
  return curr.replace(/\[((?:https?|mailto):[^\]]+)\]\(\1\)/g, "$1");
}

/**
 * Format a line based on its paragraph style.
 */
function formatLine(text: string, run: AttributeRun): string {
  if (text.trim() === "") return "";

  const indent = run.indent ? "  ".repeat(run.indent) : "";

  // Todo check — can come from style=103 or from the todo submessage
  if (run.isTodo || run.style === "todo") {
    return `${indent}- [${run.todoDone ? "x" : " "}] ${text}`;
  }

  switch (run.style) {
    case "title":
      return `# ${text}`;
    case "heading":
      return `## ${text}`;
    case "subheading":
      return `### ${text}`;
    case "monospaced":
      return `${indent}\`${text}\``;
    case "dotted-list":
    case "dashed-list":
      return `${indent}- ${text}`;
    case "numbered-list":
      return `${indent}1. ${text}`;
    default:
      return `${indent}${text}`;
  }
}

// Core Data timestamp helpers were lifted into `./epoch.ts` (alongside the
// iMessage seconds-vs-nanoseconds heuristic) so the Apple/Core Data epoch
// offset is defined exactly once. Re-exported here for callers that import
// them from this module.
export { coreDataToDate, coreDataToISO, isoToCoreData } from "./epoch.js";

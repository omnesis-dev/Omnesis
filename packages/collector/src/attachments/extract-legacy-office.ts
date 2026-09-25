// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as CFB from "cfb";
import WordExtractor from "word-extractor";
import { createLogger } from "@omnesis/core";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:legacy-office");

const DOC_MIME = "application/msword";
const XLS_MIME_TYPES = new Set(["application/vnd.ms-excel", "application/x-msexcel"]);
const PPT_MIME = "application/vnd.ms-powerpoint";

const PPT_TEXT_CHARS_ATOM = 0x0fa0;
const PPT_TEXT_BYTES_ATOM = 0x0fa8;
const CFB_STREAM_TYPE = 2;

interface SheetRef {
  name: string;
  offset: number;
}

interface BiffRecord {
  type: number;
  offset: number;
  data: Uint8Array;
}

type SheetCells = Map<number, Map<number, string>>;

interface BiffChunkCursor {
  chunks: Uint8Array[];
  chunkIndex: number;
  offset: number;
}

interface BoundedRender {
  text: string;
  truncated: boolean;
}

/**
 * Extract text from legacy binary Office formats.
 *
 * `.doc` uses `word-extractor` first, then falls back to OLE text-run recovery.
 * `.xls` parses the common BIFF8 cell records directly. `.ppt` extracts text
 * atoms from the PowerPoint OLE stream and falls back to printable OLE runs.
 */
export async function extractLegacyOfficeText(
  data: Uint8Array,
  mimeType: string,
  opts?: { maxTextLength?: number },
): Promise<ExtractionResult | null> {
  if (data.length === 0) return null;

  const maxLen = opts?.maxTextLength ?? 512_000;

  try {
    if (mimeType === DOC_MIME) return await extractDoc(data, maxLen);
    if (XLS_MIME_TYPES.has(mimeType)) return extractXls(data, maxLen);
    if (mimeType === PPT_MIME) return extractPpt(data, maxLen);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Legacy Office extraction failed for ${mimeType} (${data.length} bytes): ${msg}`);
    return null;
  }
}

async function extractDoc(data: Uint8Array, maxLen: number): Promise<ExtractionResult | null> {
  try {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(Buffer.from(data));
    const parts = [
      doc.getHeaders({ includeFooters: false }),
      doc.getBody(),
      doc.getTextboxes({ includeHeadersAndFooters: true }),
      doc.getFootnotes(),
      doc.getEndnotes(),
      doc.getAnnotations(),
      doc.getFooters(),
    ]
      .map(normalizeText)
      .filter((part) => part.length > 0);

    const clipped = clipText(parts.join("\n\n"), maxLen);
    if (clipped) {
      log.debug(`DOC extracted via word-extractor: ${clipped.text.length} chars`);
      return clipped;
    }
  } catch {
    // Some old `.doc` payloads are malformed-but-readable OLE containers. The
    // stream fallback below still recovers searchable text from those files.
  }

  const fallback = extractOleTextRuns(data, maxLen, {
    preferredStreams: ["WordDocument", "0Table", "1Table"],
    minRunLength: 5,
  });
  if (fallback) log.debug(`DOC extracted via OLE text runs: ${fallback.text.length} chars`);
  return fallback;
}

function extractXls(data: Uint8Array, maxLen: number): ExtractionResult | null {
  const container = readOle(data);
  const workbook = findOleStream(container, ["Workbook", "Book"]);
  if (!workbook) {
    return extractOleTextRuns(data, maxLen, { preferredStreams: ["Workbook", "Book"] });
  }

  const records = readBiffRecords(workbook);
  if (records.length === 0) return null;

  const sheetRefs = parseSheetRefs(records);
  const sharedStrings = parseSharedStringTable(records);
  const sheets = sheetRefs.length > 0 ? sheetRefs : [{ name: "Workbook", offset: 0 }];
  const cells = sheets.map((): SheetCells => new Map());

  for (const record of records) {
    const sheetIndex = sheetIndexForOffset(sheets, record.offset);
    if (sheetIndex < 0) continue;
    parseCellRecord(record, sharedStrings, cells[sheetIndex]);
  }

  const rendered = renderWorkbook(sheets, cells, maxLen);
  if (rendered) {
    log.debug(`XLS extracted: ${rendered.pages ?? 0} sheets, ${rendered.text.length} chars`);
    return rendered;
  }

  const fallback = extractOleTextRuns(data, maxLen, { preferredStreams: ["Workbook", "Book"] });
  if (fallback) log.debug(`XLS extracted via OLE text runs: ${fallback.text.length} chars`);
  return fallback;
}

function extractPpt(data: Uint8Array, maxLen: number): ExtractionResult | null {
  const container = readOle(data);
  const ppt = findOleStream(container, ["PowerPoint Document"]);
  if (ppt) {
    const parts = extractPptTextAtoms(ppt);
    const clipped = clipText(parts.join("\n\n"), maxLen);
    if (clipped) {
      log.debug(`PPT extracted via text atoms: ${clipped.text.length} chars`);
      return clipped;
    }
  }

  const fallback = extractOleTextRunsFromContainer(container, maxLen, {
    preferredStreams: ["PowerPoint Document"],
    minRunLength: 5,
  });
  if (fallback) log.debug(`PPT extracted via OLE text runs: ${fallback.text.length} chars`);
  return fallback;
}

function readOle(data: Uint8Array): CFB.CFB$Container {
  return CFB.read(Buffer.from(data), { type: "buffer" });
}

function findOleStream(container: CFB.CFB$Container, names: string[]): Uint8Array | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const entry of container.FileIndex) {
    if (entry.type !== CFB_STREAM_TYPE) continue;
    if (!wanted.has(entry.name.toLowerCase())) continue;
    return entryContent(entry);
  }
  return null;
}

function entryContent(entry: CFB.CFB$Entry): Uint8Array {
  return entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
}

function readBiffRecords(bytes: Uint8Array): BiffRecord[] {
  const records: BiffRecord[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const type = readU16(bytes, offset);
    const length = readU16(bytes, offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;
    records.push({ type, offset, data: bytes.slice(dataStart, dataEnd) });
    offset = dataEnd;
  }
  return records;
}

function parseSheetRefs(records: BiffRecord[]): SheetRef[] {
  const refs: SheetRef[] = [];
  for (const record of records) {
    if (record.type !== 0x0085) continue;
    const ref = parseBoundSheet(record.data);
    if (ref) refs.push(ref);
  }
  return refs.sort((a, b) => a.offset - b.offset);
}

function parseBoundSheet(data: Uint8Array): SheetRef | null {
  if (data.length < 8) return null;
  const offset = readU32(data, 0);
  const nameLength = data[6];
  const flags = data[7];
  const name = decodeBiffStringPayload(data, 8, nameLength, (flags & 0x01) !== 0);
  return { name: normalizeText(name) || "Sheet", offset };
}

function parseSharedStringTable(records: BiffRecord[]): string[] {
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.type !== 0x00fc) continue;

    const chunks = [record.data];
    let cursor = index + 1;
    while (cursor < records.length && records[cursor].type === 0x003c) {
      chunks.push(records[cursor].data);
      cursor++;
    }

    return parseSstPayload(chunks);
  }
  return [];
}

function parseSstPayload(chunks: Uint8Array[]): string[] {
  const cursor: BiffChunkCursor = { chunks, chunkIndex: 0, offset: 0 };
  const totalRefs = cursorReadU32(cursor);
  const uniqueCount = cursorReadU32(cursor);
  if (totalRefs === null || uniqueCount === null) return [];

  const strings: string[] = [];

  for (let i = 0; i < uniqueCount; i++) {
    const parsed = readBiffStringFromCursor(cursor);
    if (!parsed) break;
    strings.push(parsed);
  }

  return strings;
}

function parseCellRecord(record: BiffRecord, sharedStrings: string[], cells: SheetCells): void {
  const data = record.data;
  switch (record.type) {
    case 0x00fd: {
      if (data.length < 10) return;
      const value = sharedStrings[readU32(data, 6)] ?? "";
      putCell(cells, readU16(data, 0), readU16(data, 2), value);
      return;
    }
    case 0x0204: {
      if (data.length < 8) return;
      const parsed = readBiffString(data, 6);
      if (!parsed) return;
      putCell(cells, readU16(data, 0), readU16(data, 2), parsed.value);
      return;
    }
    case 0x0203: {
      if (data.length < 14) return;
      putCell(cells, readU16(data, 0), readU16(data, 2), formatNumber(readDouble(data, 6)));
      return;
    }
    case 0x027e: {
      if (data.length < 10) return;
      putCell(cells, readU16(data, 0), readU16(data, 2), formatNumber(decodeRk(readU32(data, 6))));
      return;
    }
    case 0x00bd: {
      if (data.length < 8) return;
      const row = readU16(data, 0);
      const firstCol = readU16(data, 2);
      const lastCol = readU16(data, data.length - 2);
      let offset = 4;
      for (let col = firstCol; col <= lastCol && offset + 6 <= data.length - 2; col++) {
        putCell(cells, row, col, formatNumber(decodeRk(readU32(data, offset + 2))));
        offset += 6;
      }
      return;
    }
    case 0x0006: {
      if (data.length < 14) return;
      const value = readDouble(data, 6);
      if (Number.isFinite(value)) {
        putCell(cells, readU16(data, 0), readU16(data, 2), formatNumber(value));
      }
      return;
    }
    case 0x0205: {
      if (data.length < 8) return;
      const value = data[7] === 0 ? (data[6] === 1 ? "TRUE" : "FALSE") : "";
      putCell(cells, readU16(data, 0), readU16(data, 2), value);
      return;
    }
    default:
      return;
  }
}

function sheetIndexForOffset(sheets: SheetRef[], offset: number): number {
  let index = -1;
  for (let i = 0; i < sheets.length; i++) {
    if (offset >= sheets[i].offset) index = i;
    else break;
  }
  if (index === -1 && sheets.length === 1 && sheets[0].offset === 0) return 0;
  return index;
}

function putCell(cells: SheetCells, row: number, column: number, rawValue: string): void {
  const value = normalizeText(rawValue);
  if (!value) return;
  const rowCells = cells.get(row) ?? new Map<number, string>();
  rowCells.set(column, value);
  cells.set(row, rowCells);
}

function renderWorkbook(
  sheets: SheetRef[],
  sheetCells: SheetCells[],
  maxLen: number,
): ExtractionResult | null {
  const parts: string[] = [];
  const state = { totalLen: 0, truncated: false };
  let nonEmptySheets = 0;

  for (let i = 0; i < sheets.length; i++) {
    const header = `## Sheet: ${sheets[i].name}\n`;
    const csv = renderSheet(
      sheetCells[i],
      Math.max(0, maxLen - state.totalLen - header.length - 1),
    );
    if (!csv.text.trim()) continue;

    nonEmptySheets++;
    if (!appendBounded(parts, state, header, maxLen)) break;
    if (!appendBounded(parts, state, csv.text, maxLen)) break;
    if (!appendBounded(parts, state, "\n", maxLen)) break;
    if (csv.truncated) {
      state.truncated = true;
      break;
    }
  }

  const text = parts.join("\n").trim();
  if (!text) return null;
  return { text, pages: nonEmptySheets, truncated: state.truncated };
}

function renderSheet(cells: SheetCells, maxLen: number): BoundedRender {
  const rows: string[] = [];
  const state = { totalLen: 0, truncated: false };
  for (const rowIndex of Array.from(cells.keys()).sort((a, b) => a - b)) {
    const row = cells.get(rowIndex);
    if (!row) continue;
    const line = renderCsvRow(row);
    if (!line.trim()) continue;
    if (rows.length > 0 && !appendBounded(rows, state, "\n", maxLen)) break;
    if (!appendBounded(rows, state, line, maxLen)) break;
  }
  return { text: rows.join(""), truncated: state.truncated };
}

function renderCsvRow(row: Map<number, string>): string {
  const lastColumn = Math.max(...row.keys());
  const values: string[] = [];
  for (let col = 0; col <= lastColumn; col++) values.push(row.get(col) ?? "");
  while (values.length > 0 && !values.at(-1)?.trim()) values.pop();
  return values.some((value) => value.trim()) ? values.map(csvCell).join(",") : "";
}

function readBiffString(
  data: Uint8Array,
  offset: number,
): { value: string; nextOffset: number } | null {
  if (offset + 3 > data.length) return null;
  const length = readU16(data, offset);
  const flags = data[offset + 2];
  let cursor = offset + 3;
  const richTextRuns = (flags & 0x08) !== 0 ? readU16(data, cursor) : 0;
  if ((flags & 0x08) !== 0) cursor += 2;
  const phoneticSize = (flags & 0x04) !== 0 ? readU32(data, cursor) : 0;
  if ((flags & 0x04) !== 0) cursor += 4;

  const isUtf16 = (flags & 0x01) !== 0;
  const byteLength = length * (isUtf16 ? 2 : 1);
  if (cursor + byteLength > data.length) return null;

  const value = decodeBiffStringPayload(data, cursor, length, isUtf16);
  cursor += byteLength + richTextRuns * 4 + phoneticSize;
  return { value, nextOffset: Math.min(cursor, data.length) };
}

function readBiffStringFromCursor(cursor: BiffChunkCursor): string | null {
  const length = cursorReadU16(cursor);
  const flags = cursorReadByte(cursor);
  if (length === null || flags === null) return null;

  const richTextRuns = (flags & 0x08) !== 0 ? cursorReadU16(cursor) : 0;
  if (richTextRuns === null) return null;
  const phoneticSize = (flags & 0x04) !== 0 ? cursorReadU32(cursor) : 0;
  if (phoneticSize === null) return null;

  let isUtf16 = (flags & 0x01) !== 0;
  let remainingChars = length;
  const parts: string[] = [];

  while (remainingChars > 0) {
    if (cursorCurrentRemaining(cursor) === 0) {
      if (!cursorMoveToNextChunk(cursor)) return null;
      const continuationFlags = cursorReadByte(cursor);
      if (continuationFlags === null) return null;
      isUtf16 = (continuationFlags & 0x01) !== 0;
    }

    const bytesPerChar = isUtf16 ? 2 : 1;
    const charsInChunk = Math.min(
      remainingChars,
      Math.floor(cursorCurrentRemaining(cursor) / bytesPerChar),
    );
    if (charsInChunk <= 0) return null;

    const bytes = cursorReadBytesInCurrent(cursor, charsInChunk * bytesPerChar);
    if (!bytes) return null;
    parts.push(Buffer.from(bytes).toString(isUtf16 ? "utf16le" : "latin1"));
    remainingChars -= charsInChunk;
  }

  const extraBytes = richTextRuns * 4 + phoneticSize;
  if (extraBytes > 0 && !cursorReadBytes(cursor, extraBytes)) return null;

  return parts.join("");
}

function decodeBiffStringPayload(
  data: Uint8Array,
  offset: number,
  charLength: number,
  isUtf16: boolean,
): string {
  const byteLength = charLength * (isUtf16 ? 2 : 1);
  if (offset + byteLength > data.length) return "";
  const slice = data.slice(offset, offset + byteLength);
  return Buffer.from(slice).toString(isUtf16 ? "utf16le" : "latin1");
}

function extractPptTextAtoms(bytes: Uint8Array): string[] {
  const parts: string[] = [];
  let offset = 0;

  while (offset + 8 <= bytes.length) {
    const recordType = readU16(bytes, offset + 2);
    const length = readU32(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;

    if (recordType === PPT_TEXT_CHARS_ATOM) {
      const text = normalizeText(Buffer.from(bytes.slice(dataStart, dataEnd)).toString("utf16le"));
      if (text) parts.push(text);
    } else if (recordType === PPT_TEXT_BYTES_ATOM) {
      const text = normalizeText(Buffer.from(bytes.slice(dataStart, dataEnd)).toString("latin1"));
      if (text) parts.push(text);
    }

    offset = dataEnd;
  }

  return dedupe(parts);
}

function extractOleTextRuns(
  data: Uint8Array,
  maxLen: number,
  opts: { preferredStreams?: string[]; minRunLength?: number } = {},
): ExtractionResult | null {
  return extractOleTextRunsFromContainer(readOle(data), maxLen, opts);
}

function extractOleTextRunsFromContainer(
  container: CFB.CFB$Container,
  maxLen: number,
  opts: { preferredStreams?: string[]; minRunLength?: number } = {},
): ExtractionResult | null {
  const streams = container.FileIndex.filter(
    (entry) => entry.type === CFB_STREAM_TYPE && entry.content.length > 0,
  ).sort(
    (a, b) =>
      streamPriority(a.name, opts.preferredStreams) - streamPriority(b.name, opts.preferredStreams),
  );

  const parts: string[] = [];
  const minRunLength = opts.minRunLength ?? 6;
  for (const stream of streams) {
    const bytes = entryContent(stream);
    parts.push(...extractUtf16Runs(bytes, minRunLength));
    parts.push(...extractSingleByteRuns(bytes, Math.max(minRunLength, 8)));
  }

  return clipText(dedupe(parts).join("\n\n"), maxLen);
}

function streamPriority(name: string, preferredStreams: string[] | undefined): number {
  if (!preferredStreams) return 100;
  const index = preferredStreams.findIndex(
    (preferred) => preferred.toLowerCase() === name.toLowerCase(),
  );
  return index === -1 ? 100 : index;
}

function extractUtf16Runs(bytes: Uint8Array, minChars: number): string[] {
  const runs: string[] = [];
  for (const parity of [0, 1]) {
    let offset = parity;
    while (offset + 1 < bytes.length) {
      const start = offset;
      while (offset + 1 < bytes.length && isTextCodePoint(readU16(bytes, offset))) offset += 2;
      const chars = (offset - start) / 2;
      if (chars >= minChars) {
        const text = normalizeText(Buffer.from(bytes.slice(start, offset)).toString("utf16le"));
        if (looksLikeUsefulText(text, minChars)) runs.push(text);
      }
      offset = Math.max(offset + 2, start + 2);
    }
  }
  return runs;
}

function extractSingleByteRuns(bytes: Uint8Array, minChars: number): string[] {
  const runs: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    while (offset < bytes.length && isSingleByteText(bytes[offset])) offset++;
    if (offset - start >= minChars) {
      const text = normalizeText(Buffer.from(bytes.slice(start, offset)).toString("latin1"));
      if (looksLikeUsefulText(text, minChars)) runs.push(text);
    }
    offset = Math.max(offset + 1, start + 1);
  }
  return runs;
}

function isTextCodePoint(value: number): boolean {
  return value === 0x09 || value === 0x0a || value === 0x0d || (value >= 0x20 && value < 0xfffe);
}

function isSingleByteText(value: number): boolean {
  return value === 0x09 || value === 0x0a || value === 0x0d || (value >= 0x20 && value <= 0x7e);
}

function looksLikeUsefulText(text: string, minChars: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length < minChars) return false;
  const lettersOrDigits = trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return lettersOrDigits >= Math.max(2, Math.floor(trimmed.length * 0.25));
}

function decodeRk(raw: number): number {
  const multiplied = (raw & 0x01) !== 0;
  const isInteger = (raw & 0x02) !== 0;
  let value: number;
  if (isInteger) {
    value = raw >> 2;
  } else {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(raw & 0xfffffffc, 4);
    value = buffer.readDoubleLE(0);
  }
  return multiplied ? value / 100 : value;
}

function readU16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

function readDouble(data: Uint8Array, offset: number): number {
  return Buffer.from(data.slice(offset, offset + 8)).readDoubleLE(0);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

function csvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

function normalizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clipText(text: string, maxLen: number): ExtractionResult | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (normalized.length <= maxLen) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, maxLen), truncated: true };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function appendBounded(
  parts: string[],
  state: { totalLen: number; truncated: boolean },
  value: string,
  maxLen: number,
): boolean {
  if (state.totalLen >= maxLen) {
    state.truncated = true;
    return false;
  }

  const remaining = maxLen - state.totalLen;
  if (value.length > remaining) {
    if (remaining > 0) {
      parts.push(value.slice(0, remaining));
      state.totalLen += remaining;
    }
    state.truncated = true;
    return false;
  }

  parts.push(value);
  state.totalLen += value.length;
  return true;
}

function cursorReadByte(cursor: BiffChunkCursor): number | null {
  if (!cursorMoveToNextChunk(cursor)) return null;
  return cursor.chunks[cursor.chunkIndex][cursor.offset++];
}

function cursorReadU16(cursor: BiffChunkCursor): number | null {
  const bytes = cursorReadBytes(cursor, 2);
  return bytes ? readU16(bytes, 0) : null;
}

function cursorReadU32(cursor: BiffChunkCursor): number | null {
  const bytes = cursorReadBytes(cursor, 4);
  return bytes ? readU32(bytes, 0) : null;
}

function cursorReadBytes(cursor: BiffChunkCursor, count: number): Uint8Array | null {
  const out = new Uint8Array(count);
  let copied = 0;

  while (copied < count) {
    if (!cursorMoveToNextChunk(cursor)) return null;
    const chunk = cursor.chunks[cursor.chunkIndex];
    const available = chunk.length - cursor.offset;
    const take = Math.min(count - copied, available);
    out.set(chunk.slice(cursor.offset, cursor.offset + take), copied);
    copied += take;
    cursor.offset += take;
  }

  return out;
}

function cursorReadBytesInCurrent(cursor: BiffChunkCursor, count: number): Uint8Array | null {
  if (cursorCurrentRemaining(cursor) < count) return null;
  const chunk = cursor.chunks[cursor.chunkIndex];
  const out = chunk.slice(cursor.offset, cursor.offset + count);
  cursor.offset += count;
  return out;
}

function cursorMoveToNextChunk(cursor: BiffChunkCursor): boolean {
  while (cursor.chunkIndex < cursor.chunks.length) {
    if (cursor.offset < cursor.chunks[cursor.chunkIndex].length) return true;
    cursor.chunkIndex++;
    cursor.offset = 0;
  }
  return false;
}

function cursorCurrentRemaining(cursor: BiffChunkCursor): number {
  if (cursor.chunkIndex >= cursor.chunks.length) return 0;
  return cursor.chunks[cursor.chunkIndex].length - cursor.offset;
}

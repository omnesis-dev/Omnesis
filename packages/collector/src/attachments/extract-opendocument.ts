// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import JSZip from "jszip";
import { DOMParser } from "linkedom";
import { createLogger } from "@omnesis/core";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:opendocument");

const ODT_MIME = "application/vnd.oasis.opendocument.text";
const ODS_MIME = "application/vnd.oasis.opendocument.spreadsheet";
const ODP_MIME = "application/vnd.oasis.opendocument.presentation";
const MAX_CONTENT_XML_BYTES = 5_000_000;

interface XmlElementContainer {
  getElementsByTagName(tagName: string): ArrayLike<Element>;
}

interface XmlNodeContainer extends XmlElementContainer {
  childNodes: ArrayLike<Node>;
}

export async function extractOpenDocumentText(
  data: Uint8Array,
  mimeType: string,
  opts?: { maxTextLength?: number },
): Promise<ExtractionResult | null> {
  if (data.length === 0) return null;

  const maxLen = opts?.maxTextLength ?? 512_000;

  try {
    const zip = await JSZip.loadAsync(data);
    const contentXml = await readZipText(zip, "content.xml", MAX_CONTENT_XML_BYTES);
    if (!contentXml) return null;

    switch (mimeType) {
      case ODT_MIME:
        return extractTextDocument(contentXml, maxLen);
      case ODS_MIME:
        return extractSpreadsheet(contentXml, maxLen);
      case ODP_MIME:
        return extractPresentation(contentXml, maxLen);
      default:
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`OpenDocument extraction failed for ${mimeType} (${data.length} bytes): ${msg}`);
    return null;
  }
}

function extractTextDocument(contentXml: string, maxLen: number): ExtractionResult | null {
  const doc = parseXml(contentXml);
  const blocks = collectBlocks(doc);
  const clipped = clipText(blocks.join("\n\n"), maxLen);
  if (clipped) log.debug(`ODT extracted: ${clipped.text.length} chars`);
  return clipped;
}

function extractSpreadsheet(contentXml: string, maxLen: number): ExtractionResult | null {
  const doc = parseXml(contentXml);
  const parts: string[] = [];
  const state = { totalLen: 0, truncated: false };
  let nonEmptySheets = 0;

  for (const [index, table] of xmlElements(doc, "table:table").entries()) {
    const fallbackName = `Sheet ${index + 1}`;
    const name = normalizeText(table.getAttribute("table:name") ?? "") || fallbackName;
    const header = `## Sheet: ${name}\n`;
    const csv = tableToCsv(table, Math.max(0, maxLen - state.totalLen - header.length - 1));
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

  const text = normalizeText(parts.join("\n"));
  if (!text) return null;
  log.debug(`ODS extracted: ${nonEmptySheets} sheets, ${text.length} chars`);
  return { text, pages: nonEmptySheets, truncated: state.truncated };
}

function extractPresentation(contentXml: string, maxLen: number): ExtractionResult | null {
  const doc = parseXml(contentXml);
  const parts: string[] = [];
  let slideNum = 0;
  let totalLen = 0;
  let truncated = false;

  for (const page of xmlElements(doc, "draw:page")) {
    slideNum++;
    const blocks = collectBlocks(page);
    if (blocks.length === 0) continue;

    const name = normalizeText(page.getAttribute("draw:name") ?? "");
    const header = name ? `## Slide ${slideNum}: ${name}\n` : `## Slide ${slideNum}\n`;
    const slideContent = `${header}${blocks.join("\n")}\n`;

    if (totalLen + slideContent.length > maxLen) {
      const remaining = maxLen - totalLen;
      if (remaining > 0) parts.push(slideContent.slice(0, remaining));
      truncated = true;
      break;
    }

    parts.push(slideContent);
    totalLen += slideContent.length;
  }

  const text = normalizeText(parts.join("\n"));
  if (!text) return null;
  log.debug(`ODP extracted: ${slideNum} slides, ${text.length} chars`);
  return { text, pages: slideNum, truncated };
}

function collectBlocks(root: XmlNodeContainer): string[] {
  const blocks: string[] = [];

  function visit(node: Node): void {
    if (node.nodeType !== 1) {
      for (const child of Array.from(node.childNodes)) visit(child);
      return;
    }

    const element = node as Element;
    const tag = elementTag(element);
    if (tag === "text:p" || tag === "text:h") {
      const text = normalizeText(inlineText(element));
      if (text) blocks.push(text);
      return;
    }

    if (tag === "table:table") {
      const csv = tableToCsv(element);
      if (csv.text.trim()) blocks.push(csv.text);
      return;
    }

    for (const child of Array.from(element.childNodes)) visit(child);
  }

  for (const child of Array.from(root.childNodes)) visit(child);
  return blocks;
}

function tableToCsv(
  table: Element,
  maxLen: number = Number.POSITIVE_INFINITY,
): { text: string; truncated: boolean } {
  const rows: string[] = [];
  const state = { totalLen: 0, truncated: false };
  for (const row of xmlElements(table, "table:table-row")) {
    const rowRepeat = boundedRepeat(row.getAttribute("table:number-rows-repeated"));
    const values = rowCells(row);
    if (!values.some((value) => value.trim())) continue;
    const line = values.map(csvCell).join(",");
    for (let i = 0; i < rowRepeat; i++) {
      if (rows.length > 0 && !appendBounded(rows, state, "\n", maxLen)) {
        return tableTextResult(rows, state);
      }
      if (!appendBounded(rows, state, line, maxLen)) return tableTextResult(rows, state);
    }
  }
  return tableTextResult(rows, state);
}

function tableTextResult(
  rows: string[],
  state: { totalLen: number; truncated: boolean },
): { text: string; truncated: boolean } {
  const text = rows.join("");
  return {
    text,
    truncated: state.truncated,
  };
}

function rowCells(row: Element): string[] {
  const values: string[] = [];
  for (const cell of Array.from(row.childNodes).filter(isElement)) {
    const tag = elementTag(cell);
    if (tag !== "table:table-cell" && tag !== "table:covered-table-cell") continue;

    const repeat = boundedRepeat(cell.getAttribute("table:number-columns-repeated"));
    const value = cellValue(cell);
    for (let i = 0; i < repeat; i++) values.push(value);
  }

  while (values.length > 0 && !values.at(-1)?.trim()) values.pop();
  return values;
}

function cellValue(cell: Element): string {
  const text = normalizeText(collectBlocks(cell).join(" "));
  if (text) return text;

  return normalizeText(
    cell.getAttribute("office:string-value") ??
      cell.getAttribute("office:value") ??
      cell.getAttribute("office:date-value") ??
      cell.getAttribute("office:time-value") ??
      "",
  );
}

function inlineText(element: Element): string {
  const parts: string[] = [];

  function visit(node: Node): void {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;

    const child = node as Element;
    const tag = elementTag(child);
    if (tag === "text:tab") {
      parts.push("\t");
      return;
    }
    if (tag === "text:line-break") {
      parts.push("\n");
      return;
    }
    if (tag === "text:s") {
      parts.push(" ".repeat(boundedRepeat(child.getAttribute("text:c"))));
      return;
    }

    for (const grandchild of Array.from(child.childNodes)) visit(grandchild);
  }

  for (const child of Array.from(element.childNodes)) visit(child);
  return parts.join("");
}

function boundedRepeat(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 1;
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 1_000);
}

function parseXml(xml: string): XmlNodeContainer {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as XmlNodeContainer;
}

function xmlElements(parent: XmlElementContainer, tagName: string): Element[] {
  return Array.from(parent.getElementsByTagName(tagName));
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function elementTag(element: Element): string {
  return element.tagName.toLowerCase();
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

async function readZipText(zip: JSZip, path: string, maxBytes: number): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stream = file.nodeStream("nodebuffer") as NodeJS.ReadableStream & {
      destroy?: () => void;
      pause?: () => void;
    };

    function finish(value: string | null): void {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    stream.on("data", (chunk: Buffer | Uint8Array) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        log.warn(`OpenDocument ${path} exceeds ${maxBytes} bytes after decompression`);
        stream.pause?.();
        stream.destroy?.();
        finish(null);
        return;
      }
      chunks.push(buf);
    });

    stream.on("error", (err) => {
      if (!settled) reject(err);
    });
    stream.on("end", () => {
      finish(Buffer.concat(chunks, total).toString("utf8"));
    });
  });
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

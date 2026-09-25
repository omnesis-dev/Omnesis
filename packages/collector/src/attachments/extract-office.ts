// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { posix as pathPosix } from "node:path";
import JSZip from "jszip";
import { DOMParser } from "linkedom";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { createLogger } from "@omnesis/core";
import type { ExtractionResult } from "./types.js";

const log = createLogger("attachments:office");

/**
 * Extract text from Office documents (DOCX, XLSX, PPTX).
 * Returns null if extraction fails or content is empty.
 */
export async function extractOfficeText(
  data: Uint8Array,
  mimeType: string,
  opts?: { maxTextLength?: number },
): Promise<ExtractionResult | null> {
  if (data.length === 0) return null;

  const maxLen = opts?.maxTextLength ?? 512_000;

  try {
    switch (mimeType) {
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return await extractDocx(data, maxLen);
      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        return await extractXlsx(data, maxLen);
      case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        return await extractPptx(data, maxLen);
      default:
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Office extraction failed for ${mimeType} (${data.length} bytes): ${msg}`);
    return null;
  }
}

async function extractDocx(data: Uint8Array, maxLen: number): Promise<ExtractionResult | null> {
  try {
    const htmlResult = await mammoth.convertToHtml({ buffer: Buffer.from(data) });
    if (htmlResult.value?.trim()) {
      const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
      });
      let text = turndown.turndown(htmlResult.value);
      if (!text.trim()) return fallbackDocxRawText(data, maxLen);

      let truncated = false;
      if (text.length > maxLen) {
        text = text.slice(0, maxLen);
        truncated = true;
      }
      log.debug(`DOCX extracted via mammoth HTML: ${text.length} chars`);
      return { text, truncated };
    }
  } catch {
    // HTML conversion failed, try raw text
  }

  return fallbackDocxRawText(data, maxLen);
}

async function fallbackDocxRawText(
  data: Uint8Array,
  maxLen: number,
): Promise<ExtractionResult | null> {
  const rawResult = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  let text = rawResult.value?.trim() ?? "";
  if (!text) return null;

  let truncated = false;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen);
    truncated = true;
  }
  log.debug(`DOCX extracted via mammoth raw text: ${text.length} chars`);
  return { text, truncated };
}

interface XlsxSheet {
  name: string;
  path: string;
}

interface XmlElementContainer {
  getElementsByTagName(tagName: string): ArrayLike<Element>;
}

async function extractXlsx(data: Uint8Array, maxLen: number): Promise<ExtractionResult | null> {
  const zip = await JSZip.loadAsync(data);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("text");
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("text");
  if (!workbookXml || !workbookRelsXml) return null;

  const sheets = parseWorkbookSheets(workbookXml, workbookRelsXml);
  if (sheets.length === 0) return null;

  const sharedStrings = await readSharedStrings(zip);

  const parts: string[] = [];
  let nonEmptySheets = 0;
  let totalLen = 0;
  let truncated = false;

  for (const sheet of sheets) {
    const sheetXml = await zip.file(sheet.path)?.async("text");
    if (!sheetXml) continue;

    const csv = worksheetToCsv(sheetXml, sharedStrings);
    if (!csv.trim()) continue;

    nonEmptySheets++;
    const header = `## Sheet: ${sheet.name}\n`;
    const sheetContent = header + csv + "\n";

    if (totalLen + sheetContent.length > maxLen) {
      const remaining = maxLen - totalLen;
      if (remaining > header.length) {
        parts.push(sheetContent.slice(0, remaining));
      }
      truncated = true;
      break;
    }

    parts.push(sheetContent);
    totalLen += sheetContent.length;
  }

  if (parts.length === 0) return null;

  const text = parts.join("\n").trim();
  if (!text) return null;

  log.debug(`XLSX extracted: ${nonEmptySheets} sheets, ${text.length} chars`);
  return { text, pages: nonEmptySheets, truncated };
}

function parseWorkbookSheets(workbookXml: string, workbookRelsXml: string): XlsxSheet[] {
  const doc = parseXml(workbookXml);
  const rels = parseWorkbookRelationships(workbookRelsXml);
  const sheets: XlsxSheet[] = [];

  for (const sheet of xmlElements(doc, "sheet")) {
    const relId = sheet.getAttribute("r:id");
    if (!relId) continue;
    const path = rels.get(relId);
    if (!path) continue;

    const fallbackName = `Sheet ${sheets.length + 1}`;
    sheets.push({
      name: sheet.getAttribute("name")?.trim() || fallbackName,
      path,
    });
  }

  return sheets;
}

function parseWorkbookRelationships(workbookRelsXml: string): Map<string, string> {
  const doc = parseXml(workbookRelsXml);
  const rels = new Map<string, string>();

  for (const rel of xmlElements(doc, "Relationship")) {
    if (rel.getAttribute("TargetMode") === "External") continue;
    const id = rel.getAttribute("Id");
    const type = rel.getAttribute("Type") ?? "";
    const target = rel.getAttribute("Target");
    if (!id || !target || !type.endsWith("/worksheet")) continue;

    const path = resolveXlsxPartPath("xl/workbook.xml", target);
    if (path) rels.set(id, path);
  }

  return rels;
}

function resolveXlsxPartPath(sourcePartPath: string, target: string): string | null {
  const raw =
    target.startsWith("/") || target.startsWith("\\")
      ? target.replace(/^[/\\]+/, "")
      : pathPosix.join(pathPosix.dirname(sourcePartPath), target);
  const normalized = pathPosix.normalize(raw.replace(/\\/g, "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return null;
  }
  return normalized.startsWith("xl/") ? normalized : null;
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await zip.file("xl/sharedStrings.xml")?.async("text");
  if (!xml) return [];

  const doc = parseXml(xml);
  return xmlElements(doc, "si").map((si) => xmlTextRuns(si));
}

function worksheetToCsv(sheetXml: string, sharedStrings: string[]): string {
  const doc = parseXml(sheetXml);
  const rows: string[] = [];

  for (const row of xmlElements(doc, "row")) {
    const values: string[] = [];
    let nextColumn = 0;

    for (const cell of xmlElements(row, "c")) {
      const column = cellColumnIndex(cell.getAttribute("r")) ?? nextColumn;
      while (values.length < column) values.push("");
      values[column] = cellText(cell, sharedStrings);
      nextColumn = Math.max(nextColumn, column + 1);
    }

    while (values.length > 0 && !values.at(-1)?.trim()) {
      values.pop();
    }
    if (values.some((value) => value.trim())) {
      rows.push(values.map(csvCell).join(","));
    }
  }

  return rows.join("\n");
}

function cellText(cell: Element, sharedStrings: string[]): string {
  const type = cell.getAttribute("t");
  if (type === "s") {
    const index = Number.parseInt(firstXmlText(cell, "v"), 10);
    return Number.isInteger(index) ? (sharedStrings[index] ?? "") : "";
  }
  if (type === "inlineStr") return xmlTextRuns(cell);
  if (type === "b") {
    const value = firstXmlText(cell, "v");
    if (value === "1") return "TRUE";
    if (value === "0") return "FALSE";
    return value;
  }
  return firstXmlText(cell, "v");
}

function cellColumnIndex(cellRef: string | null): number | null {
  const letters = cellRef?.match(/^[A-Za-z]+/)?.[0];
  if (!letters) return null;

  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function csvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

function firstXmlText(parent: XmlElementContainer, tagName: string): string {
  return xmlElements(parent, tagName)[0]?.textContent ?? "";
}

function xmlTextRuns(parent: Element): string {
  return xmlElements(parent, "t")
    .map((node) => node.textContent ?? "")
    .join("");
}

function parseXml(xml: string): XmlElementContainer {
  return new DOMParser().parseFromString(xml, "text/xml");
}

function xmlElements(parent: XmlElementContainer, tagName: string): Element[] {
  return Array.from(parent.getElementsByTagName(tagName));
}

async function extractPptx(data: Uint8Array, maxLen: number): Promise<ExtractionResult | null> {
  const zip = await JSZip.loadAsync(data);
  const parts: string[] = [];
  let slideNum = 0;
  let totalLen = 0;
  let truncated = false;

  // Find all slides in order
  const slideFiles: string[] = [];
  zip.forEach((path) => {
    const match = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (match) slideFiles.push(path);
  });
  slideFiles.sort((a, b) => {
    const numA = parseInt(a.match(/slide(\d+)/)?.[1] ?? "0");
    const numB = parseInt(b.match(/slide(\d+)/)?.[1] ?? "0");
    return numA - numB;
  });

  for (const slidePath of slideFiles) {
    slideNum++;
    const slideXml = await zip.file(slidePath)?.async("text");
    if (!slideXml) continue;

    const slideText = extractXmlText(slideXml);

    // Try to get speaker notes
    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    const notesXml = await zip.file(notesPath)?.async("text");
    const notesText = notesXml ? extractXmlText(notesXml) : "";

    if (!slideText && !notesText) continue;

    let slideContent = `## Slide ${slideNum}\n`;
    if (slideText) slideContent += slideText + "\n";
    if (notesText) slideContent += `\n> Notes: ${notesText}\n`;
    slideContent += "\n";

    if (totalLen + slideContent.length > maxLen) {
      const remaining = maxLen - totalLen;
      if (remaining > 0) {
        parts.push(slideContent.slice(0, remaining));
      }
      truncated = true;
      break;
    }

    parts.push(slideContent);
    totalLen += slideContent.length;
  }

  if (parts.length === 0) return null;

  const text = parts.join("").trim();
  if (!text) return null;

  log.debug(`PPTX extracted: ${slideNum} slides, ${text.length} chars`);
  return { text, pages: slideFiles.length, truncated };
}

/**
 * Extract all text content from an OOXML slide/notes XML string.
 * Looks for <a:t> elements which contain visible text.
 */
function extractXmlText(xml: string): string {
  const texts: string[] = [];
  // Match <a:t>...</a:t> elements, handling both self-closing and content
  const regex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = match[1].trim();
    if (text) texts.push(text);
  }
  return texts.join(" ").trim();
}

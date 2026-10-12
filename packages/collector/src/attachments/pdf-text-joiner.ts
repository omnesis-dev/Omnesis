// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Geometry-aware joining of pdf.js text items into plain text.
 *
 * pdf.js (via unpdf's `extractTextItems`) returns one positioned run per
 * glyph cluster with no reliable word/line separators — PDFs carry no space
 * or newline tokens, only glyph positions. Naively concatenating the runs
 * (the default `str + (hasEOL ? "\n" : "")`) glues neighbouring runs with no
 * separator. In two-column form PDFs that means a field value runs straight
 * into the next field's label, e.g. `jlopez@example.comWhat is their
 * email address?`.
 *
 * This joiner reconstructs separators from the run geometry instead:
 *   - runs are clustered into visual lines by baseline (`y`) proximity,
 *   - lines are emitted top-to-bottom and joined with newlines,
 *   - ordinary word gaps become spaces; repeated large gaps retain positioned
 *     segments in a labelled fenced block, without inferring table cells.
 *
 * Thresholds are scaled by font size so they hold across documents regardless
 * of absolute units. Gaps for a genuine column break or a missing inter-word
 * space are a sizeable fraction of the font size; runs that pdf.js splits
 * mid-word (a known artefact) sit flush against each other (gap ≈ 0), so the
 * threshold keeps them joined.
 */

import { PDF_LAYOUT_OPEN, PDF_LAYOUT_CLOSE, truncatePdfText } from "./pdf-positioned-text.js";

export interface PdfTextItem {
  /** Text content of the run. */
  str: string;
  /** Left edge in PDF user space (origin bottom-left). */
  x: number;
  /** Baseline position in PDF user space (origin bottom-left). */
  y: number;
  /** Run width in the same units as `x`. */
  width: number;
  /** Font size derived from the run's transform, in the same units as `x`. */
  fontSize: number;
}

/**
 * A baseline within this fraction of the font size is treated as the same
 * visual line. Typical leading is ~1.2× font size, so half a font size of
 * slack absorbs sub/superscripts and minor baseline drift without merging
 * adjacent lines.
 */
const LINE_TOLERANCE_RATIO = 0.5;

/**
 * A horizontal gap wider than this fraction of the font size inserts a space.
 * A rendered space is ~0.25–0.3× font size; mid-word run splits sit flush
 * (gap ≈ 0). This sits at the upper end of the space range so it reliably
 * splits column gaps and word gaps while never breaking a word apart.
 */
const SPACE_GAP_RATIO = 0.3;

interface Line {
  y: number;
  items: PdfTextItem[];
}

/**
 * Join one page's pdf.js text items into plain text with reconstructed
 * spaces, line breaks and ambiguous column positions. Pure and order-independent: items may arrive in any
 * order; lines and intra-line order are recovered from `y` and `x`.
 */
export function joinPageTextItems(items: PdfTextItem[]): string {
  return renderPdfPageText(items).text;
}

export function renderPdfPageText(
  items: PdfTextItem[],
  maxLength = 512_000,
): { text: string; truncated: boolean } {
  // pdf.js synthesizes whitespace runs spanning the entire gap. They are not
  // glyphs and would otherwise hide precisely the column geometry we retain.
  const visible = items.filter((it) => it.str.trim().length > 0);
  if (visible.length === 0) return { text: "", truncated: false };
  const limit = Math.max(0, Math.floor(maxLength));
  if (
    visible.some(
      (it) =>
        ![it.x, it.y, it.width, it.fontSize].every(Number.isFinite) ||
        it.width < 0 ||
        it.fontSize <= 0,
    )
  ) {
    let text = "";
    for (const it of visible) {
      const separator = text ? " " : "";
      const remaining = limit - text.length;
      if (separator.length + it.str.length > remaining)
        return {
          text: text + (separator + it.str.slice(0, remaining)).slice(0, remaining),
          truncated: true,
        };
      text += separator + it.str;
    }
    return { text, truncated: false };
  }
  visible.sort((a, b) => b.y - a.y || a.x - b.x || a.str.localeCompare(b.str));

  // Cluster runs into visual lines by baseline proximity. Same-line runs from
  // different columns share a `y` and are grouped together regardless of the
  // order pdf.js emitted them in.
  const lines: Line[] = [];
  for (const it of visible) {
    const tol = Math.max(it.fontSize, 1) * LINE_TOLERANCE_RATIO;
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) {
      line.items.push(it);
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }

  // PDF user space has its origin at the bottom-left, so a larger `y` sits
  // higher on the page — sort lines top-to-bottom.
  lines.sort((a, b) => b.y - a.y);

  const paragraphs: Line[][] = [];
  for (const line of lines) {
    const previous = paragraphs.at(-1)?.at(-1);
    const size = line.items.reduce((max, it) => Math.max(max, it.fontSize), 1);
    if (
      !previous ||
      previous.y - line.y > 3 * previous.items.reduce((max, it) => Math.max(max, it.fontSize), size)
    )
      paragraphs.push([]);
    paragraphs.at(-1)!.push(line);
  }
  let output = "";
  let truncated = false;
  outer: for (const paragraph of paragraphs) {
    const positioned =
      paragraph.filter((line) => segments(line.items, limit + 1).length > 1).length >= 2;
    if (positioned) {
      const opening = (output ? "\n" : "") + PDF_LAYOUT_OPEN;
      if (output.length + opening.length + PDF_LAYOUT_CLOSE.length > limit) {
        truncated = true;
        break;
      }
      output += opening;
      let first = true;
      for (const line of paragraph) {
        const parts = segments(line.items, limit + 1);
        // Refuse to expand an oversized run into a larger JSON string.
        if (parts.reduce((size, part) => size + part.text.length + 32, 0) > limit - output.length) {
          output += PDF_LAYOUT_CLOSE;
          truncated = true;
          break outer;
        }
        const row =
          `y=${line.y}: ` +
          parts.map((part) => `x=${part.x} ${JSON.stringify(part.text)}`).join(" | ");
        if (output.length + row.length + (first ? 0 : 1) + PDF_LAYOUT_CLOSE.length > limit) {
          output += PDF_LAYOUT_CLOSE;
          truncated = true;
          break outer;
        }
        output += (first ? "" : "\n") + row;
        first = false;
      }
      output += PDF_LAYOUT_CLOSE;
    } else
      for (const line of paragraph) {
        const text = (output ? "\n" : "") + joinLineItems(line.items, limit + 1);
        if (output.length + text.length > limit) {
          output += text.slice(0, limit - output.length);
          truncated = true;
          break outer;
        }
        output += text;
      }
  }
  return { text: truncatePdfText(output, limit), truncated };
}

function segments(items: PdfTextItem[], maxLength: number): Array<{ x: number; text: string }> {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const groups: PdfTextItem[][] = [];
  for (const current of sorted) {
    const previous = groups.at(-1)?.at(-1);
    if (
      !previous ||
      current.x - (previous.x + previous.width) >= 4 * Math.max(previous.fontSize, current.fontSize)
    )
      groups.push([]);
    groups.at(-1)!.push(current);
  }
  return groups.map((group) => ({ x: group[0]!.x, text: joinLineItems(group, maxLength) }));
}

function joinLineItems(items: PdfTextItem[], maxLength = Number.POSITIVE_INFINITY): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = sorted[0].str.slice(0, maxLength);
  for (let i = 1; i < sorted.length; i++) {
    if (text.length >= maxLength) break;
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur.x - (prev.x + prev.width);
    const threshold = Math.min(prev.fontSize, cur.fontSize) * SPACE_GAP_RATIO;
    const alreadySpaced = /\s$/.test(text) || /^\s/.test(cur.str);
    const separator = gap > threshold && !alreadySpaced ? " " : "";
    text += (separator + cur.str.slice(0, maxLength - text.length)).slice(
      0,
      maxLength - text.length,
    );
  }
  return text;
}

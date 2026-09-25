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
 *   - within a line, a space is inserted wherever the horizontal gap between
 *     two runs exceeds a font-size-relative threshold.
 *
 * Thresholds are scaled by font size so they hold across documents regardless
 * of absolute units. Gaps for a genuine column break or a missing inter-word
 * space are a sizeable fraction of the font size; runs that pdf.js splits
 * mid-word (a known artefact) sit flush against each other (gap ≈ 0), so the
 * threshold keeps them joined.
 */

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
 * spaces and line breaks. Pure and order-independent: items may arrive in any
 * order; lines and intra-line order are recovered from `y` and `x`.
 */
export function joinPageTextItems(items: PdfTextItem[]): string {
  const visible = items.filter((it) => it.str.length > 0);
  if (visible.length === 0) return "";

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

  return lines.map((line) => joinLineItems(line.items)).join("\n");
}

function joinLineItems(items: PdfTextItem[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = sorted[0].str;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur.x - (prev.x + prev.width);
    const threshold = Math.min(prev.fontSize, cur.fontSize) * SPACE_GAP_RATIO;
    const alreadySpaced = /\s$/.test(text) || /^\s/.test(cur.str);
    text += gap > threshold && !alreadySpaced ? ` ${cur.str}` : cur.str;
  }
  return text;
}

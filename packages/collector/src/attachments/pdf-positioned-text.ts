// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** These fences contain source text quoted on individual lines, never inferred table cells. */
export const PDF_LAYOUT_OPEN =
  "PDF positioned text (x/y are layout coordinates, not document values):\n~~~text\n";
export const PDF_LAYOUT_CLOSE = "\n~~~";

/** Cut only at complete positioned rows, keeping the fence balanced within the budget. */
export function truncatePdfText(text: string, maxLength: number): string {
  const limit = Math.max(0, Math.floor(maxLength));
  if (text.length <= limit) return text;
  // Inspect the original string: a cut may split a later opening even when an
  // earlier complete layout block already exists in the prefix.
  const start = text.lastIndexOf(PDF_LAYOUT_OPEN, limit);
  if (start < 0) return text.slice(0, limit);
  if (start + PDF_LAYOUT_OPEN.length > limit) return text.slice(0, start).trimEnd();
  const prefix = text.slice(0, limit);
  const bodyStart = start + PDF_LAYOUT_OPEN.length;
  const end = text.indexOf(PDF_LAYOUT_CLOSE, bodyStart);
  if (end >= 0 && end + PDF_LAYOUT_CLOSE.length <= limit) return prefix;
  const availableEnd = limit - PDF_LAYOUT_CLOSE.length;
  const rowEnd = text.lastIndexOf("\n", availableEnd);
  if (rowEnd < bodyStart) return text.slice(0, start).trimEnd();
  return text.slice(0, rowEnd) + PDF_LAYOUT_CLOSE;
}

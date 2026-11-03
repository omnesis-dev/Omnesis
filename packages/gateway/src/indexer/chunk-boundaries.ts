// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Read source-declared independent sections of the literal document body.
 * Offsets are UTF-16 start positions; the final section ends at body.length.
 * Invalid metadata falls back to the document type's ordinary chunking rules.
 */
export function readChunkBoundaries(content: string, value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value[0] !== 0) return null;
  const boundaries: number[] = [];
  let previous = -1;
  for (const offset of value) {
    if (
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset <= previous ||
      offset >= content.length ||
      (offset > 0 &&
        /[\uD800-\uDBFF]/.test(content[offset - 1]) &&
        /[\uDC00-\uDFFF]/.test(content[offset]))
    ) {
      return null;
    }
    boundaries.push(offset);
    previous = offset;
  }
  return boundaries;
}

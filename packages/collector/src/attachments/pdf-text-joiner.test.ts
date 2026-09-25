// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { joinPageTextItems, type PdfTextItem } from "./pdf-text-joiner.js";

/** Build a text item with sensible geometry defaults. */
function item(partial: Partial<PdfTextItem> & { str: string }): PdfTextItem {
  return { x: 0, y: 700, width: partial.str.length * 6, fontSize: 12, ...partial };
}

describe("joinPageTextItems", () => {
  test("returns empty string for no items", () => {
    expect(joinPageTextItems([])).toBe("");
  });

  test("drops zero-length runs", () => {
    expect(joinPageTextItems([item({ str: "" }), item({ str: "" })])).toBe("");
  });

  test("keeps flush runs glued (no spurious mid-word space)", () => {
    // pdf.js sometimes splits a word into adjacent runs sitting flush against
    // each other; the gap is ~0 so no space must be inserted.
    const items = [
      item({ str: "Vehi", x: 100, width: 24 }),
      item({ str: "cl", x: 124, width: 12 }),
      item({ str: "es", x: 136, width: 12 }),
    ];
    expect(joinPageTextItems(items)).toBe("Vehicles");
  });

  test("inserts a space across a column gap (the form-PDF glue bug)", () => {
    // A field value sits in one column and the next field's label in another,
    // on the same baseline. Without geometry they glue into
    // "jlopez@example.comWhat is their email address?".
    const items = [
      item({ str: "jlopez@example.com", x: 100, width: 120 }),
      item({ str: "What is their email address?", x: 320, width: 150 }),
    ];
    expect(joinPageTextItems(items)).toBe("jlopez@example.com What is their email address?");
  });

  test("inserts a newline between separate baselines", () => {
    const items = [
      item({ str: "Line one", x: 100, y: 700 }),
      item({ str: "Line two", x: 100, y: 680 }),
    ];
    expect(joinPageTextItems(items)).toBe("Line one\nLine two");
  });

  test("emits lines top-to-bottom regardless of input order", () => {
    // PDF user space origin is bottom-left: larger y is higher on the page.
    const items = [
      item({ str: "bottom", x: 100, y: 600 }),
      item({ str: "top", x: 100, y: 700 }),
      item({ str: "middle", x: 100, y: 650 }),
    ];
    expect(joinPageTextItems(items)).toBe("top\nmiddle\nbottom");
  });

  test("orders same-line runs left-to-right regardless of input order", () => {
    const items = [
      item({ str: "world", x: 200, y: 700, width: 30 }),
      item({ str: "hello", x: 100, y: 700, width: 30 }),
    ];
    expect(joinPageTextItems(items)).toBe("hello world");
  });

  test("groups same-baseline runs from different columns into one line", () => {
    // Two columns of a form row share a baseline; both belong to one line.
    const items = [
      item({ str: "Reeves", x: 100, y: 700, width: 40 }),
      item({ str: "Family name", x: 300, y: 700, width: 60 }),
      item({ str: "Maya", x: 100, y: 680, width: 30 }),
      item({ str: "Given name", x: 300, y: 680, width: 55 }),
    ];
    expect(joinPageTextItems(items)).toBe("Reeves Family name\nMaya Given name");
  });

  test("does not double up when a run already carries whitespace", () => {
    const items = [
      item({ str: "alpha ", x: 100, width: 30 }),
      item({ str: "beta", x: 200, width: 24 }),
    ];
    expect(joinPageTextItems(items)).toBe("alpha beta");
  });

  test("scales the gap threshold with font size", () => {
    // The same absolute gap that separates words at a small font size is
    // within a single large glyph's advance at a large font size.
    const big = [
      item({ str: "AB", x: 100, width: 40, fontSize: 40 }),
      item({ str: "CD", x: 145, width: 40, fontSize: 40 }),
    ];
    // gap = 5, threshold = 40 * 0.3 = 12 → no space
    expect(joinPageTextItems(big)).toBe("ABCD");

    const small = [
      item({ str: "AB", x: 100, width: 12, fontSize: 8 }),
      item({ str: "CD", x: 117, width: 12, fontSize: 8 }),
    ];
    // gap = 5, threshold = 8 * 0.3 = 2.4 → space
    expect(joinPageTextItems(small)).toBe("AB CD");
  });
});

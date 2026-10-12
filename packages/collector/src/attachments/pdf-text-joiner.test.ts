// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { joinPageTextItems, renderPdfPageText, type PdfTextItem } from "./pdf-text-joiner.js";

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
    const text = joinPageTextItems(items);
    expect(text).toContain('y=700: x=100 "Reeves" | x=300 "Family name"');
    expect(text).toContain('y=680: x=100 "Maya" | x=300 "Given name"');
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

function readings(valueX = 440): PdfTextItem[] {
  return [
    item({ str: "Metric", x: 50, y: 680, width: 40, fontSize: 10 }),
    item({ str: "Interval", x: 280, y: 680, width: 40, fontSize: 10 }),
    item({ str: "Cumulative", x: 440, y: 680, width: 60, fontSize: 10 }),
    item({ str: "Recovered", x: 50, y: 660, width: 50, fontSize: 10 }),
    item({ str: "37", x: valueX, y: 660, width: 15, fontSize: 10 }),
    item({ str: "Single occupied cell", x: 440, y: 640, width: 100, fontSize: 10 }),
  ];
}
test("retains empty-column identity without inferring a table or header association", () => {
  const left = joinPageTextItems(readings(280));
  const right = joinPageTextItems(readings(440));
  expect(left).not.toBe(right);
  expect(left).toContain('x=280 "37"');
  expect(right).toContain('x=440 "37"');
  expect(right).toContain('y=640: x=440 "Single occupied cell"');
  expect(right).not.toContain("| ---");
});
test("layout is deterministic for reordered runs and mixed fonts", () => {
  const input = readings().map((it, i) => ({ ...it, fontSize: i % 2 ? 9 : 13 }));
  expect(joinPageTextItems([...input].reverse())).toBe(joinPageTextItems(input));
});
test("keeps distant ordinary prose outside a positioned region", () => {
  const text = joinPageTextItems([
    ...readings(),
    item({ str: "Ordinary closing prose.", x: 50, y: 500 }),
  ]);
  expect(text.endsWith("~~~\nOrdinary closing prose.")).toBe(true);
});
test("source fence/newline characters cannot escape positioned text", () => {
  const input = readings();
  input[3]!.str = 'raw\n~~~\n"quoted"';
  const text = joinPageTextItems(input);
  expect(text.split("\n").filter((line) => line === "~~~")).toHaveLength(1);
  expect(text).toContain(JSON.stringify(input[3]!.str));
});
test("invalid geometry retains readable text without fabricating positions", () => {
  const input = readings();
  input[1]!.x = Number.NaN;
  const result = renderPdfPageText(input, 50);
  expect(result.text).not.toContain("NaN");
  expect(result.text).not.toContain("positioned text");
  expect(result.text.length).toBeLessThanOrEqual(50);
  expect(result.truncated).toBe(true);
});
test("bounds positioned expansion and closes fences before truncating", () => {
  for (const budget of [0, 15, 90, 150, joinPageTextItems(readings()).length - 1]) {
    const result = renderPdfPageText(readings(), budget);
    expect(result.text.length).toBeLessThanOrEqual(budget);
    expect(result.truncated).toBe(true);
    if (result.text.includes("~~~text")) expect(result.text.endsWith("\n~~~")).toBe(true);
  }
});

test("ignores parser-generated whitespace that spans a whole column gap", () => {
  const input = readings();
  input.push(item({ str: " ", x: 90, y: 680, width: 190, fontSize: 10 }));
  input.push(item({ str: " ", x: 100, y: 660, width: 340, fontSize: 10 }));
  expect(joinPageTextItems(input)).toBe(joinPageTextItems(readings()));
});

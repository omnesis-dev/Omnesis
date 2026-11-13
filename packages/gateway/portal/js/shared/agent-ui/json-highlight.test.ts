// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
// @ts-expect-error — browser module is plain JavaScript.
import { highlightJsonToHtml, jsonHighlightParts } from "./json-highlight.js";

describe("JSON syntax coloring", () => {
  it("distinguishes keys, strings, numbers and literals without changing source", () => {
    const text = '{\n  "label": "a \\"quoted\\" value", "count": -1.25e2, "on": true, "empty": null\n}';
    const parts = jsonHighlightParts(text);
    expect(parts.map((part: { text: string }) => part.text).join("")).toBe(text);
    for (const [className, value] of [
      ["cm-tok-property", '"label"'], ["cm-tok-string", '"a \\"quoted\\" value"'],
      ["cm-tok-number", "-1.25e2"], ["cm-tok-atom", "true"], ["cm-tok-atom", "null"],
    ]) expect(parts).toContainEqual({ className, text: value });
  });

  it("keeps incomplete streamed JSON and Unicode verbatim", () => {
    for (const text of ["", '{"title": "🌙", "pending":', "[1, false, null", '"<img>"']) {
      expect(jsonHighlightParts(text).map((part: { text: string }) => part.text).join("")).toBe(text);
    }
  });

  it("escapes HTML within JSON before producing markup", () => {
    const html = highlightJsonToHtml('{"<img src=x onerror=alert(1)>": "</code><script>bad()</script>&"}');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });
});

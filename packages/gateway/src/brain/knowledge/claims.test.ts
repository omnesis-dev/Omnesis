// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ClaimMarkupError, parseClaimMarkup, stripClaimMarkup } from "./claims.js";

const claim = (id: string, text: string): string =>
  `<claim id="${id}" refs="source:doc">${text}</claim>`;

describe("claim markup", () => {
  it("preserves Markdown and exact nested spans without transferring child support", () => {
    const child = '<claim id="detail" refs="wiki:spec#claim:size">**small**</claim>';
    const outer = `<claim id="plan" refs="source:doc#evidence:paragraph loop:loop_1#field:state">Build a ${child} robot.</claim>`;
    const markdown = `# Plan\n${outer}\nEnd.`;
    const result = parseClaimMarkup(markdown);
    expect(result.text).toBe("# Plan\nBuild a **small** robot.\nEnd.");
    expect(result.claims.map((c) => [c.id, c.parentId, c.text, c.ownText])).toEqual([
      ["plan", null, "Build a **small** robot.", "Build a  robot."],
      ["detail", "plan", "**small**", "**small**"],
    ]);
    for (const parsed of result.claims) {
      expect(result.text.slice(parsed.textSpan.start, parsed.textSpan.end)).toBe(parsed.text);
      expect(markdown.slice(parsed.sourceSpan.start, parsed.sourceSpan.end)).toBe(
        parsed.id === "plan" ? outer : child,
      );
      expect(markdown.slice(parsed.contentSpan.start, parsed.contentSpan.end)).toBe(
        parsed.id === "plan" ? `Build a ${child} robot.` : "**small**",
      );
    }
    expect(result.claims[0]!.refs).toHaveLength(2);
    expect(result.claims[1]!.refs[0]!.raw).toBe("wiki:spec#claim:size");
  });

  it("parses indented nested tags within an active claim", () => {
    const result = parseClaimMarkup(claim("outer", "\n    " + claim("inner", "Details") + "\n"));
    expect(result.claims.map((c) => c.id)).toEqual(["outer", "inner"]);
  });

  it("uses UTF-16 offsets and strips only structural tags", () => {
    const result = parseClaimMarkup(`🚀 ${claim("c", "Ready 🚀")}!`);
    expect(result.claims[0]!.textSpan).toEqual({ start: 3, end: 11 });
    expect(stripClaimMarkup(`🚀 ${claim("c", "Ready 🚀")}!`)).toBe("🚀 Ready 🚀!");
  });

  it.each([
    '`<claim id="c" refs="source:doc">example</claim>`',
    '``code ` <claim id="c" refs="source:doc">example</claim>``',
    "```xml\n<claim malformed>example</claim>\n```",
    "~~~xml\n<claim malformed>example</claim>\n~~~",
    "   ````xml\n<claim malformed>example</claim>\n```\n````",
    "    <claim malformed>example</claim>\n",
    "<!-- <claim malformed>example</claim> -->",
    '\\<claim id="c" refs="source:doc">example\\</claim>',
  ])("does not interpret literal Markdown examples: %s", (markdown) => {
    expect(parseClaimMarkup(markdown)).toEqual({ text: markdown, claims: [] });
  });

  it("resumes structural parsing after code examples and preserves inline code inside claims", () => {
    const markdown = "```xml\n<claim bad>\n```\n" + claim("c", "Use `<claim>` syntax.");
    const result = parseClaimMarkup(markdown);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.text).toBe("Use `<claim>` syntax.");
  });

  it("accepts ordinary HTML and reordered multiline attributes", () => {
    const result = parseClaimMarkup('<b>Note</b> <claim\n refs="source:d"\n id="c">Fact</claim>');
    expect(result.text).toBe("<b>Note</b> Fact");
  });

  it.each([
    '<claim id="c" refs="source:d">unfinished',
    "</claim>",
    "<claim>",
    '<claim id="c" refs="source:d"/>',
    '<claim id="c" refs="source:d"> </claim>',
    '<claim id="c" refs="source:d">x</claim >',
    '<Claim id="c" refs="source:d">x</Claim>',
    '<claim id="c" refs="source:d" extra="x">x</claim>',
    '<claim id="c" id="d" refs="source:d">x</claim>',
    '<claim id="c" refs="source:d" refs="source:e">x</claim>',
    '<claim id="c">x</claim>',
    '<claim id="c" refs="">x</claim>',
    '<claim id="c" refs="source:d source:d">x</claim>',
    '<claim id="c" refs="source:d" onclick="bad">x</claim>',
    '<claim id="c" refs="source:&quot;x">x</claim>',
    "<claim id='c' refs='source:d'>x</claim>",
    '<claim id="c" refs="source:d">x</claim>' + '<claim id="c" refs="source:e">y</claim>',
  ])("rejects invalid structure %s", (markdown) => {
    expect(() => parseClaimMarkup(markdown)).toThrow(ClaimMarkupError);
  });

  it("bounds input, counts, nesting and references", () => {
    expect(() => parseClaimMarkup("abc", { maxCharacters: 2 })).toThrow(/character limit/);
    expect(() => parseClaimMarkup(claim("a", "a") + claim("b", "b"), { maxClaims: 1 })).toThrow(
      /count or depth/,
    );
    expect(() => parseClaimMarkup(claim("a", claim("b", "b")), { maxDepth: 1 })).toThrow(
      /count or depth/,
    );
    expect(() =>
      parseClaimMarkup('<claim id="a" refs="source:a source:b">x</claim>', {
        maxReferencesPerClaim: 1,
      }),
    ).toThrow(/reference limit/);
    expect(() => parseClaimMarkup("", { maxDepth: NaN })).toThrow(/positive safe integers/);
  });

  it("does not claim to verify untagged assertions or referenced evidence", () => {
    expect(parseClaimMarkup("An unverified assertion.").claims).toEqual([]);
    expect(parseClaimMarkup(claim("c", "An unsupported assertion.")).claims).toHaveLength(1);
  });
});

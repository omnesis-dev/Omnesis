// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { describe, expect, it, vi } from "vitest";
// Browser coverage exercises DOMPurify's actual DOM implementation. Here the
// spy verifies that the complete generated output passes the strict policy.
vi.mock("dompurify", () => ({ default: { sanitize: vi.fn((value) => value) } }));
vi.mock("../lib/format.js", () => ({
  sourceIconUrl: (id: string) => (id === "fixture-notes" ? "data:image/png;base64,aGVsbG8=" : null),
}));
import DOMPurify from "dompurify";
import { parseClaimMarkup } from "../../../src/brain/knowledge/claims.js";
import { uncoveredKnowledgeSpans } from "../../../src/brain/knowledge/coverage.js";
// @ts-expect-error Plain JavaScript portal module.
import * as knowledgeMarkdown from "./knowledge-claim-markdown.js";
const { claimMarkupRanges, internalKnowledgeHref, renderKnowledgeMarkdown, extractKnowledgeReferences } = knowledgeMarkdown;
function claim(markdown: string, id: string, parentId: string | null = null) {
  const open = `<claim id="${id}" refs="source:fixture">`;
  const start = markdown.indexOf(open) + open.length;
  const end = parentId ? markdown.indexOf("</claim>", start) : markdown.lastIndexOf("</claim>");
  return { id, parentId, start, end };
}
describe("claim-aware Markdown", () => {
  it("preserves canonical portal query and fragment selectors while hydrating references", () => {
    const documentHref = "/portal/doc/letter%2Fone?evidence=paragraph#selection";
    const pageHref = "/portal/debug/cognition/knowledge/loop_fixture?kind=loop&field=status#detail";
    const markdown = `[Document](${documentHref}) [Outcome](${pageHref})`;
    expect(internalKnowledgeHref(documentHref)).toBeNull();
    expect(internalKnowledgeHref(pageHref)).toBeNull();
    expect(extractKnowledgeReferences(markdown)).toEqual(["source:letter/one", "node:loop_fixture"]);
    const rendered = renderKnowledgeMarkdown(markdown).html;
    expect(rendered).toContain('href="/portal/doc/letter%2Fone?evidence=paragraph#selection"');
    expect(rendered).toContain('href="/portal/debug/cognition/knowledge/loop_fixture?kind=loop&field=status#detail"');
    expect(rendered).toContain('class="kn-link-icon kn-link-icon--source"');
  });

  it("routes bare canonical page IDs locally with icons without rewriting external lookalikes", () => {
    const markdown = "[Task](loop_fixture) [Page](wiki_fixture#claim:detail) [Root](root_fixture) [Remote](https://example.org/loop_fixture) [Relative](notes/loop_fixture)";
    expect(extractKnowledgeReferences(markdown)).toEqual([
      "loop:loop_fixture", "wiki:wiki_fixture#claim:detail", "wiki:root_fixture",
    ]);
    const rendered = renderKnowledgeMarkdown(markdown).html;
    expect(rendered).toContain('href="/portal/debug/cognition/knowledge/loop_fixture?kind=loop"');
    expect(rendered).toContain('href="/portal/debug/cognition/knowledge/wiki_fixture?claim=detail"');
    expect(rendered).toContain('href="/portal/debug/cognition/knowledge/root_fixture"');
    expect(rendered).toContain('class="kn-link-icon kn-link-icon--loop"');
    expect(rendered).toContain('class="kn-link-icon kn-link-icon--wiki"');
    expect(rendered).toContain('href="https://example.org/loop_fixture"');
    expect(rendered).toContain('href="notes/loop_fixture"');
    expect(internalKnowledgeHref("loop_fixture/../../admin")).toBeNull();
    expect(internalKnowledgeHref("loop_fixture?redirect=https://example.org")).toBeNull();
  });
  it("renders fully covered sections and page navigation with separate inspectable claims", () => {
    const markdown = [
      '<claim id="supplies" refs="source:fixture">\n## Supplies\n\nThe [materials page](wiki:materials) lists paper and pencils.\n</claim>',
      '<claim id="collection" refs="source:fixture">\n## Next step\n\n[Collect supplies](loop:collection) tracks preparation.\n</claim>',
    ].join("\n\n");
    const parsed = parseClaimMarkup(markdown);
    expect(uncoveredKnowledgeSpans(parsed)).toEqual([]);
    const claims = parsed.claims.map((item) => ({
      id: item.id,
      parentId: item.parentId,
      start: item.contentSpan.start,
      end: item.contentSpan.end,
    }));
    const result = renderKnowledgeMarkdown(markdown, claims);
    expect(result.html).toContain("<h2>Supplies</h2>");
    expect(result.html).toContain("<h2>Next step</h2>");
    expect(result.html).toContain('href="/portal/debug/cognition/knowledge/materials"');
    expect(result.html).toContain('href="/portal/debug/cognition/knowledge/collection?kind=loop"');
    expect(result.html).toContain('class="kn-link-icon kn-link-icon--wiki"');
    expect(result.html).toContain('class="kn-link-icon kn-link-icon--loop"');
    expect([...result.targets.values()]).toEqual(["supplies", "collection"]);
  });
  it("resolves canonical portal links and excludes code examples from metadata hydration", () => {
    const markdown =
      "[Page](/portal/debug/cognition/knowledge/project) [Note](/portal/doc/letter%2Fone) ` [Example](source:private-example) `";
    expect(extractKnowledgeReferences(markdown)).toEqual(["node:project", "source:letter/one"]);
    const rendered = renderKnowledgeMarkdown(markdown, [], {
      "node:project": { kind: "root" },
      "source:letter/one": { kind: "source", sourceId: "fixture-notes" },
    }).html;
    expect(rendered).toContain('class="kn-link-icon kn-link-icon--wiki"');
    expect(rendered).toContain('src="data:image/png;base64,aGVsbG8="');
  });
  it("decorates typed links while keeping prose sanitization closed to images and SVG", () => {
    const result = renderKnowledgeMarkdown(
      "[Project](wiki:project) [Task](loop:task) [Note](source:note#evidence:paragraph) [Website](https://example.org)",
      [],
      {
        "source:note": { kind: "source", sourceId: "fixture-notes" },
      },
    );
    expect(result.html).toContain('class="kn-link-icon kn-link-icon--wiki"');
    expect(result.html).toContain('class="kn-link-icon kn-link-icon--loop"');
    expect(result.html).toContain('class="kn-link-icon kn-link-icon--source"');
    expect(result.html).toContain('src="data:image/png;base64,aGVsbG8="');
    expect(result.html).toContain('<a href="https://example.org">Website</a>');
    expect(result.html).toContain('aria-hidden="true"');
    const sanitizedInput = vi.mocked(DOMPurify.sanitize).mock.calls.at(-1)?.[0];
    expect(sanitizedInput).not.toContain("<svg");
    expect(sanitizedInput).not.toContain("<img");
  });
  it("preserves nested formatting and exact claim identities", () => {
    const markdown =
      '# Plan\n\n<claim id="outer" refs="source:fixture">Bring **paper** and <claim id="inner" refs="source:fixture">blue pencils</claim>.</claim>';
    const claims = [claim(markdown, "outer"), claim(markdown, "inner", "outer")];
    const result = renderKnowledgeMarkdown(markdown, claims);
    expect(result.html).toContain("<h1>Plan</h1>");
    expect(result.html).toContain("<strong>paper</strong>");
    expect(result.html).toMatch(/paper<\/strong> and <span/);
    expect(result.html).toContain('aria-label="Inspect claim 1"');
    expect(result.html).toContain('aria-label="Inspect claim 2"');
    expect([...result.targets.values()]).toEqual(["outer", "inner"]);
    expect(DOMPurify.sanitize).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        FORBID_TAGS: ["img"],
        ALLOW_DATA_ATTR: false,
        ALLOW_UNKNOWN_PROTOCOLS: false,
      }),
    );
  });
  it("preserves block Markdown within multiline claims", () => {
    const markdown =
      '<claim id="plan" refs="source:fixture">## Supplies\n\n- paper\n- pencils\n</claim>';
    const result = renderKnowledgeMarkdown(markdown, [claim(markdown, "plan")]);
    expect(result.html).toContain("<h2>Supplies</h2>");
    expect(result.html).toContain("<li>paper</li>");
    expect(result.targets.size).toBe(1);
  });
  it("rewrites typed internal links but never invents claims in code examples", () => {
    const markdown = '[Supplies](wiki:materials)\n\n`<claim id="example">example</claim>`';
    const result = renderKnowledgeMarkdown(markdown, []);
    expect(result.html).toContain('href="/portal/debug/cognition/knowledge/materials"');
    expect(result.html).toContain("<code>");
    expect(result.targets.size).toBe(0);
    expect(internalKnowledgeHref("javascript:alert(1)")).toBeNull();
    expect(internalKnowledgeHref("wiki:page/with space")).toBe(
      "/portal/debug/cognition/knowledge/page%2Fwith%20space",
    );
  });
  it("retains claim and canonical field targets in internal navigation", () => {
    expect(internalKnowledgeHref("wiki:project#claim:date")).toBe(
      "/portal/debug/cognition/knowledge/project?claim=date",
    );
    expect(internalKnowledgeHref("loop:task#field:state")).toBe(
      "/portal/debug/cognition/knowledge/task?kind=loop&field=state",
    );
    expect(renderKnowledgeMarkdown("[State](loop:task#field:state)").html).toContain(
      'href="/portal/debug/cognition/knowledge/task?kind=loop&field=state"',
    );
  });
  it("refuses invalid offsets rather than highlighting matching prose elsewhere", () => {
    expect(
      claimMarkupRanges("A repeated phrase. A repeated phrase.", [{ id: "x", start: 0, end: 18 }]),
    ).toEqual([]);
    expect(claimMarkupRanges("text", [{ id: "x", start: 100, end: 110 }])).toEqual([]);
  });
});

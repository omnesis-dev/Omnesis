// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { extractReadableText, MAX_EXTRACTED_CHARS } from "./extract.js";

/**
 * Client-side extraction tests. Fixtures are entirely INVENTED (fictional
 * `example.com` pages, fictional people/text) — never the user's corpus.
 *
 * We build the DOM with `linkedom` (already a workspace dependency, runs under
 * Node) instead of jsdom, so the extractor — which takes a `Document` — is
 * exercised exactly as the content script exercises it with the real browser
 * `document`. Output is Markdown (Defuddle extraction + Turndown), so the
 * captured page keeps its structure instead of flattening to one text blob.
 */

const URL = "https://example.com/article";

function doc(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

describe("extractReadableText", () => {
  it("extracts the article body and strips nav/header/footer boilerplate", () => {
    const html = `<!doctype html><html><head><title>Quarterly Planning Notes</title></head>
      <body>
        <nav>Home About Contact NAVIGATION_NOISE</nav>
        <header>Site banner HEADER_NOISE</header>
        <article>
          <h1>Quarterly Planning Notes</h1>
          <p>Maya Reeves opened the review by walking through the revenue summary for the
             quarter, noting that the northern region outperformed every projection the
             planning team had set at the start of the year.</p>
          <p>Jamie Lopez then presented the staffing model, arguing that two additional
             analysts would let the team close the backlog of open requests before the
             next planning cycle began in earnest.</p>
        </article>
        <footer>Copyright FOOTER_NOISE</footer>
      </body></html>`;
    const out = extractReadableText(doc(html), URL);
    expect(out.title).toBe("Quarterly Planning Notes");
    expect(out.text).toContain("Maya Reeves");
    expect(out.text).toContain("staffing model");
    expect(out.text).not.toContain("NAVIGATION_NOISE");
    expect(out.text).not.toContain("FOOTER_NOISE");
  });

  it("converts to Markdown (links + emphasis) and never emits raw HTML", () => {
    const html = `<!doctype html><html><head><title>Markup Test</title></head>
      <body><article><h1>Markup Test</h1>
        <p>This paragraph contains <strong>emphasis</strong> and a
           <a href="https://example.org/x">link to a fictional resource</a> that should
           survive as Markdown rather than raw HTML in the extracted article body.</p>
        <p>A second paragraph keeps the article long enough for the content scorer to
           accept it as the main content node of this invented document.</p>
      </article></body></html>`;
    const out = extractReadableText(doc(html), URL);
    // Structure survives as Markdown, not angle-bracket HTML.
    expect(out.text).not.toContain("<");
    expect(out.text).not.toContain(">");
    expect(out.text).not.toContain("href");
    expect(out.text).toContain("**emphasis**");
    expect(out.text).toContain("[link to a fictional resource](https://example.org/x)");
  });

  it("preserves heading and paragraph structure instead of a flat blob", () => {
    const html = `<!doctype html><html><head><title>Aurora 2.0 Release</title></head>
      <body><article>
        <h2>What changed in this release</h2>
        <p>The first paragraph introduces the release with enough surrounding prose that the
           content scorer accepts this node as the article's main content body.</p>
        <p>The second paragraph closes the notes with extra detail so the scorer keeps the
           document and the extractor returns the full article rather than the fallback.</p>
      </article></body></html>`;
    const out = extractReadableText(doc(html), URL);
    // Not a single contiguous blob: paragraphs are separated by a blank line,
    // and the section heading survives as an ATX heading.
    expect(out.text).toContain("\n\n");
    expect(out.text.split("\n").length).toBeGreaterThan(1);
    expect(out.text).toContain("## What changed in this release");
  });

  it("falls back to body Markdown (keeping lists) when no main content is found", () => {
    // A dashboard-like shell with no article — Defuddle finds no main content,
    // so the fallback converts the de-noised body to Markdown (script/style gone),
    // and a list survives as Markdown bullets.
    const html = `<!doctype html><html><head><title>Dashboard</title>
        <style>.x{color:red} STYLE_NOISE</style></head>
      <body>
        <div id="app">Active sessions: 14</div>
        <ul><li>Open tickets: 3</li><li>Latency: 42ms</li></ul>
        <script>var SCRIPT_NOISE = 1;</script>
      </body></html>`;
    const out = extractReadableText(doc(html), URL);
    expect(out.title).toBe("Dashboard");
    expect(out.text).toContain("Active sessions: 14");
    expect(out.text).toMatch(/^-\s+Open tickets: 3/m);
    expect(out.text).toMatch(/^-\s+Latency: 42ms/m);
    expect(out.text).not.toContain("SCRIPT_NOISE");
    expect(out.text).not.toContain("STYLE_NOISE");
  });

  it("does not mutate the source document", () => {
    const html = `<!doctype html><html><head><title>Immutability</title></head>
      <body><nav>NAV</nav><article><h1>Immutability</h1>
        <p>The extractor must operate on a clone so the live page the user is reading is
           never altered by the extractor boilerplate-stripping pass at capture time.</p>
        <p>This second paragraph exists purely so the content extractor accepts the
           article and actually performs its DOM-mutating cleanup on the clone.</p>
      </article></body></html>`;
    const d = doc(html);
    const before = d.body?.textContent ?? "";
    extractReadableText(d, URL);
    const after = d.body?.textContent ?? "";
    expect(after).toBe(before);
    expect(after).toContain("NAV");
  });

  it("never captures form controls or editable drafts", () => {
    const html = `<!doctype html><html><head><title>Account notes</title></head>
      <body><main>
        <h1>Account notes</h1>
        <p>This fictional page has enough ordinary published prose for the readable-content
           extractor to keep the page while excluding interactive controls and unpublished drafts.</p>
        <form><label>Private draft <textarea>UNSENT_PRIVATE_DRAFT</textarea></label>
          <input value="PRIVATE_INPUT_VALUE"><button>Submit private draft</button></form>
        <div contenteditable="true">EDITABLE_PRIVATE_DRAFT</div>
        <div contenteditable="false">Published non-editable explanation remains visible.</div>
      </main></body></html>`;
    const out = extractReadableText(doc(html), URL);
    expect(out.text).toContain("published prose");
    expect(out.text).toContain("Published non-editable explanation");
    expect(out.text).not.toContain("UNSENT_PRIVATE_DRAFT");
    expect(out.text).not.toContain("PRIVATE_INPUT_VALUE");
    expect(out.text).not.toContain("EDITABLE_PRIVATE_DRAFT");
    expect(out.text).not.toContain("Submit private draft");
  });

  it("keeps the published text of a page whose whole body is one form", () => {
    // Classic WebForms and many forum/search pages wrap everything in a single
    // <form>. Dropping the element would drop the page; only the controls go.
    const html = `<!doctype html><html><head><title>Regional archive</title></head>
      <body><form id="whole-page" method="post">
        <input type="hidden" name="__VIEWSTATE" value="OPAQUE_VIEWSTATE_BLOB">
        <main>
          <h1>Regional archive</h1>
          <p>This fictional archive page carries its entire published body inside a single
             form element, as server-rendered frameworks commonly do, with enough prose for
             the readable-content extractor to keep it as the article.</p>
          <p>A second paragraph of invented archive commentary keeps the body comfortably above
             the minimum length the extractor requires before it trusts a page.</p>
        </main>
        <input type="submit" value="Search the archive">
      </form></body></html>`;
    const out = extractReadableText(doc(html), URL);
    expect(out.text).toContain("entire published body");
    expect(out.text).toContain("invented archive commentary");
    expect(out.text).not.toContain("OPAQUE_VIEWSTATE_BLOB");
    expect(out.text).not.toContain("Search the archive");
  });

  it("fences code blocks (incl. syntax-highlighted <pre>) with a language hint", () => {
    const html = `<!doctype html><html><head><title>Code Sample</title></head>
      <body><article>
        <h2>Example</h2>
        <p>The following snippet doubles each number in an array, with enough surrounding
           prose that the content scorer keeps this node as the article's body content.</p>
        <pre class="brush: js"><span class="token">const</span> doubled = nums.map((n) => n * 2);</pre>
        <p>A closing paragraph keeps the article long enough for the scorer to accept it.</p>
      </article></body></html>`;
    const out = extractReadableText(doc(html), URL);
    expect(out.text).toContain("```js"); // fenced WITH a language hint
    expect(out.text).toContain("const doubled = nums.map((n) => n * 2);"); // code intact
    // Inside a fence Turndown does not escape Markdown punctuation; if the block
    // had been treated as inline prose the `*` would be backslash-escaped.
    expect(out.text).not.toContain("\\*");
  });

  it("caps an unbounded page at the size limit, on a line boundary", () => {
    // An infinite-scroll feed: thousands of short paragraphs whose combined
    // Markdown far exceeds the cap.
    const paras = Array.from(
      { length: 8000 },
      (_, i) => `<p>Feed item ${i} with a little body text to take up some room.</p>`,
    ).join("");
    const html = `<!doctype html><html><head><title>Endless Feed</title></head><body><main>${paras}</main></body></html>`;
    const out = extractReadableText(doc(html), URL);
    expect(out.text.length).toBeLessThanOrEqual(MAX_EXTRACTED_CHARS);
    expect(out.text.length).toBeGreaterThan(MAX_EXTRACTED_CHARS * 0.8); // actually truncated, not emptied
    expect(out.text.endsWith("\n")).toBe(false); // trimmed at the boundary
  });

  it("renders <table> as a GFM pipe table, not flattened lines", () => {
    const html = `<!doctype html><html><head><title>Integer Types</title></head>
      <body><article>
        <h2>Integer types</h2>
        <p>This table lists the signed and unsigned integer types, with enough prose around it
           that the content scorer treats this node as the article's main content body.</p>
        <table>
          <thead><tr><th>Length</th><th>Signed</th><th>Unsigned</th></tr></thead>
          <tbody><tr><td>8-bit</td><td>i8</td><td>u8</td></tr></tbody>
        </table>
        <p>A closing paragraph keeps the article long enough for the scorer to accept it.</p>
      </article></body></html>`;
    const out = extractReadableText(doc(html), URL);
    // Pipe-table syntax with the header and data rows intact (not one-cell-per-line).
    expect(out.text).toMatch(/\|\s*Length\s*\|\s*Signed\s*\|\s*Unsigned\s*\|/);
    expect(out.text).toMatch(/\|\s*8-bit\s*\|\s*i8\s*\|\s*u8\s*\|/);
  });
});

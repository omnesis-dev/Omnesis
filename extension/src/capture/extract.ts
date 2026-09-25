// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Defuddle from "defuddle";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";

/**
 * Client-side readable-content extraction from a rendered DOM, as **Markdown**.
 *
 * Runs against the page's *rendered, authenticated* DOM (post-JS, logged-in) —
 * the browser is the only component that can see this. We push **Markdown
 * text, never raw HTML**: Markdown keeps the page's structure — headings,
 * paragraphs, lists, links, tables, code — without shipping the live DOM, its
 * scripts, or its tracking markup.
 *
 * Strategy:
 *   1. **Defuddle** extracts the main content from a CLONE of the document (so
 *      the live page is never mutated). Defuddle scores the DOM, flattens open
 *      shadow roots, and resolves streamed/SSR content; and — keyed on the page
 *      URL — it dispatches a **site-specific extractor** for the long tail that
 *      generic scoring handles poorly (AI chats, threaded discussions, code
 *      hosts, video pages, paywalled articles, social feeds). It returns the
 *      article HTML, which Turndown converts to Markdown.
 *   2. If Defuddle returns nothing usable (an app shell, a dashboard, a very
 *      short page), fall back to the de-noised `<body>` converted to Markdown,
 *      so the page still yields structured readable content.
 *
 * Pure w.r.t. the live page: takes a `Document`, returns strings, mutates
 * nothing the caller holds (Defuddle runs on a clone). Environment-agnostic —
 * the content script passes the real `document`; unit tests pass a
 * `linkedom`-built `Document`. We keep **Turndown** for HTML→Markdown rather than
 * Defuddle's built-in Markdown: the latter relies on layout APIs that are absent
 * under `linkedom`, so it can't be exercised in the Node unit tests, whereas
 * Turndown runs identically in the browser and under `linkedom`.
 */

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});
turndown.remove(["script", "style", "head", "noscript"]);

// GFM pipe tables. Without this, Turndown drops <table> structure and the cells
// flatten to one-per-line, destroying every row/column relationship.
turndown.use(tables);

// Fenced code from ANY <pre>, reconstructed from its textContent. Syntax
// highlighters (MDN's `<pre class="brush: js">`, mdBook's
// `<pre><code class="language-rust">`, Wikipedia's `<pre>`) wrap tokens in
// nested <span>s; Turndown's built-in fenced-code rule needs a `<pre><code>`
// text child and otherwise drops the block or escapes it as inline prose (the
// `\#`, `\=` artifacts seen on Wikipedia / MDN). `addRule` prepends, so this
// wins over the built-in for every <pre>; emitting a real fence also suppresses
// Turndown's escaping of #/=/*/_/` inside the block. Language hint comes from
// the element class when present.
turndown.addRule("fencedCodeBlock", {
  filter: (node) => node.nodeName === "PRE",
  replacement: (_content, node) => {
    const el = node as unknown as HTMLElement;
    const code = (el.textContent ?? "").replace(/\n+$/, "");
    if (!code.trim()) return "";
    return `\n\n\`\`\`${codeLanguage(el)}\n${code}\n\`\`\`\n\n`;
  },
});

/** Best-effort language hint from a <pre>/<code> class (language-x, lang-x, brush: x). */
function codeLanguage(pre: HTMLElement): string {
  // getAttribute (not .className) — reliable across the browser DOM and
  // Turndown's Node-side HTML parser.
  const codeEl = pre.querySelector?.("code") ?? null;
  const classes = `${pre.getAttribute?.("class") ?? ""} ${codeEl?.getAttribute?.("class") ?? ""}`;
  const match =
    /(?:language|lang)-([a-z0-9+#]+)/i.exec(classes) ?? /brush:\s*([a-z0-9+#]+)/i.exec(classes);
  return match ? match[1].toLowerCase() : "";
}

export interface ExtractedContent {
  /** Best-effort page title (Defuddle's, else `document.title`). */
  title: string;
  /** Readable content as Markdown — boilerplate stripped, structure kept. */
  text: string;
}

/** Lower bound on extracted length before we trust it over the fallback. */
const MIN_EXTRACTED_CHARS = 25;

/**
 * Hard ceiling on extracted Markdown length. An infinite-scroll feed can render
 * an unbounded amount of content; without a cap a single page could push
 * hundreds of KB into the durable queue and starve every other pending item.
 * We truncate at a line boundary near the cap.
 */
export const MAX_EXTRACTED_CHARS = 200_000;

/**
 * Extract the page's readable content as Markdown. `url` is the page's address;
 * Defuddle keys its site-specific extractor registry on the host, so passing it
 * is what enables the AI-chat / Reddit / GitHub / … extractors.
 */
export function extractReadableText(doc: Document, url: string): ExtractedContent {
  const fallbackTitle = (doc.title ?? "").trim();

  // Defuddle may mutate its input — clone first so the live page is untouched.
  // `cloneNode(true)` of a document yields a document in both the browser and
  // linkedom.
  const clone = doc.cloneNode(true) as Document;
  stripSensitiveControls(clone);

  let parsedTitle = "";
  let parsedHtml = "";
  try {
    const result = new Defuddle(clone, {
      url,
      // We convert to Markdown via Turndown below — see the file header for why
      // Defuddle's built-in Markdown isn't used.
      markdown: false,
      // The gateway indexes images separately (OCR / attachment path); the text
      // plane is cleaner without inline image markup.
      removeImages: true,
      // Engage the site-specific extractors. They read the rendered DOM only
      // (no network), so `parse()` stays synchronous and deterministic.
      includeReplies: "extractors",
    }).parse();
    parsedTitle = (result.title ?? "").trim();
    parsedHtml = result.content ?? "";
  } catch {
    // Defuddle/Turndown can throw on malformed or empty documents — fall through
    // to the body fallback.
  }

  let text = toMarkdown(parsedHtml);
  if (text.length < MIN_EXTRACTED_CHARS) {
    text = toMarkdown(bodyHtml(doc));
  }
  return { title: parsedTitle || fallbackTitle, text: capLength(text) };
}

/** Truncate to {@link MAX_EXTRACTED_CHARS} at the nearest line boundary below the cap. */
function capLength(text: string): string {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  const slice = text.slice(0, MAX_EXTRACTED_CHARS);
  const lastBreak = slice.lastIndexOf("\n");
  // Prefer a clean line break, but only if it doesn't discard too much content.
  return (lastBreak > MAX_EXTRACTED_CHARS * 0.8 ? slice.slice(0, lastBreak) : slice).trimEnd();
}

/** De-noised `<body>` HTML (script/style/noscript/template removed), from a clone. */
function bodyHtml(doc: Document): string {
  if (!doc.body) return "";
  // Strip noise from a clone so the live page is never mutated.
  const clone = doc.cloneNode(true) as Document;
  stripSensitiveControls(clone);
  const noise = clone.querySelectorAll("script, style, noscript, template");
  for (let i = 0; i < noise.length; i++) noise[i].remove();
  return clone.body?.innerHTML ?? "";
}

/**
 * Remove controls whose live or drafted values are not page content, and
 * unwrap `<form>` elements so the published text inside them survives. Many
 * sites (classic WebForms apps, forum and search-result pages) wrap the whole
 * body in one form; deleting the element would leave nothing to extract.
 */
function stripSensitiveControls(doc: Document): void {
  const controls = doc.querySelectorAll(
    'input, textarea, select, option, button, [contenteditable]:not([contenteditable="false"])',
  );
  for (let i = 0; i < controls.length; i++) controls[i].remove();
  const forms = doc.querySelectorAll("form");
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    form.replaceWith(...Array.from(form.childNodes));
  }
}

/** HTML → Markdown, with excess blank lines and trailing spaces tidied. */
function toMarkdown(html: string): string {
  if (!html) return "";
  try {
    return turndown
      .turndown(html)
      .replace(/[ \t]+\n/g, "\n") // strip trailing whitespace per line
      .replace(/\n{3,}/g, "\n\n") // collapse 3+ newlines to a single blank line
      .trim();
  } catch {
    // Turndown can throw on malformed input — caller treats "" as "nothing
    // extracted" and falls back (or skips).
    return "";
  }
}

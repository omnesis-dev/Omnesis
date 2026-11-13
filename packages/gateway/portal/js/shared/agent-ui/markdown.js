// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import { highlightJsonToHtml } from "./json-highlight.js";

// `marked` emits raw HTML found inside the source unchanged. The
// portal renders document bodies pulled from external sources (Gmail
// HTML, Notion pages, WhatsApp messages, Obsidian notes) — any of
// which can carry `<script>` / `<img onerror=…>` payloads. We pass
// the markdown through marked first (handles the markdown-shaped
// constructs), then through DOMPurify with a strict default policy
// (no scripts, no event handlers, no `javascript:` URLs) before the
// caller hands the result to `dangerouslySetInnerHTML`.
function isJsonContainer(text) {
  if (!/^\s*[\[{]/.test(text)) return false;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object";
  } catch { return false; }
}

// A compiler may answer with the definition itself, without Markdown fences.
function markdownSource(content) {
  if (!isJsonContainer(content)) return content;
  const runs = content.match(/`+/g) ?? [];
  const fence = "`".repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
  return `${fence}json\n${content}\n${fence}`;
}

const jsonRenderer = new Renderer();
const renderCode = jsonRenderer.code;
jsonRenderer.code = function (token) {
  const language = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
  const isJson = language === "json" || (!language && isJsonContainer(token.text));
  return isJson
    ? `<pre><code class="language-json">${highlightJsonToHtml(token.text)}\n</code></pre>\n`
    : renderCode.call(this, token);
};
marked.use({ renderer: jsonRenderer });

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(content, { blockImages = false } = {}) {
  if (!content) return "";
  const rawHtml = marked.parse(markdownSource(content));
  return sanitizeMarkdown(rawHtml, blockImages);
}

function sanitizeMarkdown(rawHtml, blockImages = false) {
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ...(blockImages ? { FORBID_TAGS: ["img"] } : {}),
    // Keep it conservative — we intentionally drop any element /
    // attribute DOMPurify doesn't recognise as safe-by-default.
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

/** Copy targets originate only in parsed Markdown, never in raw HTML. */
export function renderCopyableMarkdown(
  content,
  { plainValueFences = false, blockImages = false } = {},
) {
  if (!content) return { html: "", targets: [] };
  const targets = [];
  const renderer = new Renderer();
  renderer.code = jsonRenderer.code;
  for (const kind of ["codespan", "code"]) {
    const render = renderer[kind];
    renderer[kind] = function (token) {
      const id = `agent-value-${crypto.randomUUID()}`;
      // marked removes the final LF from fenced content for rendering.
      // Restore it in the payload while retaining its indentation normalization.
      let text = token.text;
      const language = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
      const plain = kind === "code" && ["", "plain", "text", "txt", "plaintext"].includes(language)
        && !(!language && isJsonContainer(token.text));
      let closed = true;
      if (kind === "code") {
        if (!/^ {0,3}(?:`{3,}|~{3,})/.test(token.raw)) return render.call(this, token);
        const lines = token.raw.split("\n");
        const opening = lines
          .shift()
          .trimStart()
          .match(/^(`+|~+)/)[1];
        while (lines.at(-1) === "") lines.pop();
        const closing = lines.at(-1)?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
        closed = closing?.[0] === opening[0] && closing.length >= opening.length;
        if (!closed && !(plainValueFences && plain)) return render.call(this, token);
        if (closed) {
          lines.pop();
          if (lines.length > 0) text += "\n";
        }
      }
      targets.push({ id, text, block: kind === "code", plain, closed });
      return render.call(this, token).replace("<code", `<code id="${id}"`);
    };
  }
  return {
    html: sanitizeMarkdown(marked.parse(markdownSource(content ?? ""), { renderer }), blockImages),
    targets,
  };
}

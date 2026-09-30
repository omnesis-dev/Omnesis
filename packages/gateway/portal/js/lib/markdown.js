// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";

// `marked` emits raw HTML found inside the source unchanged. The
// portal renders document bodies pulled from external sources (Gmail
// HTML, Notion pages, WhatsApp messages, Obsidian notes) — any of
// which can carry `<script>` / `<img onerror=…>` payloads. We pass
// the markdown through marked first (handles the markdown-shaped
// constructs), then through DOMPurify with a strict default policy
// (no scripts, no event handlers, no `javascript:` URLs) before the
// caller hands the result to `dangerouslySetInnerHTML`.
marked.setOptions({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(content) {
  if (!content) return "";
  const rawHtml = marked.parse(content);
  return sanitizeMarkdown(rawHtml);
}

function sanitizeMarkdown(rawHtml) {
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    // Keep it conservative — we intentionally drop any element /
    // attribute DOMPurify doesn't recognise as safe-by-default.
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

/** Copy targets originate only in parsed Markdown, never in raw HTML. */
export function renderCopyableMarkdown(content) {
  const targets = [];
  const renderer = new Renderer();
  for (const kind of ["codespan", "code"]) {
    const render = renderer[kind];
    renderer[kind] = function (token) {
      const id = `agent-value-${crypto.randomUUID()}`;
      // marked removes the final LF from fenced content for rendering.
      // Restore it in the payload while retaining its indentation normalization.
      let text = token.text;
      if (kind === "code") {
        if (!/^ {0,3}(?:`{3,}|~{3,})/.test(token.raw)) return render.call(this, token);
        const lines = token.raw.split("\n");
        const opening = lines.shift().trimStart().match(/^(`+|~+)/)[1];
        while (lines.at(-1) === "") lines.pop();
        const closing = lines.at(-1)?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
        if (closing?.[0] !== opening[0] || closing.length < opening.length) return render.call(this, token);
        lines.pop();
        if (lines.length > 0) text += "\n";
      }
      targets.push({ id, text, block: kind === "code" });
      return render.call(this, token).replace("<code", `<code id="${id}"`);
    };
  }
  return {
    html: sanitizeMarkdown(marked.parse(content ?? "", { renderer })),
    targets,
  };
}

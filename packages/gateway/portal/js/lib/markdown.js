// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { marked } from "marked";
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
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    // Keep it conservative — we intentionally drop any element /
    // attribute DOMPurify doesn't recognise as safe-by-default.
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

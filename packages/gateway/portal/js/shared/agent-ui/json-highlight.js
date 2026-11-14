// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parser } from "@lezer/json";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";

const style = tagHighlighter([
  { tag: tags.propertyName, class: "cm-tok-property" },
  { tag: tags.string, class: "cm-tok-string" },
  { tag: tags.number, class: "cm-tok-number" },
  { tag: [tags.bool, tags.null], class: "cm-tok-atom" },
]);

/** Preserve every source character, including whitespace and incomplete JSON. */
export function jsonHighlightParts(text) {
  const parts = [];
  let position = 0;
  highlightTree(parser.parse(text), style, (from, to, className) => {
    if (from > position) parts.push({ text: text.slice(position, from), className: "" });
    parts.push({ text: text.slice(from, to), className });
    position = to;
  });
  if (position < text.length) parts.push({ text: text.slice(position), className: "" });
  return parts;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

/** Only parser-owned class names become markup; all input text is escaped. */
export function highlightJsonToHtml(text) {
  return jsonHighlightParts(text).map(({ text, className }) => className
    ? `<span class="${className}">${escapeHtml(text)}</span>`
    : escapeHtml(text)).join("");
}

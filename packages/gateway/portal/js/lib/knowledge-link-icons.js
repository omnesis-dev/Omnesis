// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { sourceIconUrl } from "./format.js";
import { knowledgeIconGlyphs } from "./knowledge-icon-glyphs.js";

const escapeAttribute = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

/** Trusted decorative markup only; source artwork comes from the validated source registry. */
export function knowledgeIconHtml({ kind, sourceId, reference } = {}) {
  const declaredType = kind ?? reference?.split(":", 1)[0];
  const type = declaredType === "root" ? "wiki" : declaredType;
  if (type === "source") {
    const icon = sourceIconUrl(sourceId);
    return icon
      ? `<img class="kn-link-icon kn-link-icon--source" src="${escapeAttribute(icon)}" width="16" height="16" alt="" aria-hidden="true">`
      : '<span class="kn-link-icon kn-link-icon--source" aria-hidden="true">📄</span>';
  }
  const glyph = type === "wiki" || type === "loop" ? knowledgeIconGlyphs[type] : null;
  return glyph
    ? `<svg class="kn-link-icon kn-link-icon--${type}" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`
    : "";
}

export function KnowledgeIcon(props) {
  const markup = knowledgeIconHtml(props);
  return markup
    ? html`<span
        class="kn-link-icon-wrap"
        aria-hidden="true"
        dangerouslySetInnerHTML=${{ __html: markup }}
      />`
    : null;
}

export function knowledgeReferenceMetadata(reference, references = {}) {
  const base = reference?.split("#", 1)[0];
  const node =
    base && !base.startsWith("source:") ? `node:${base.slice(base.indexOf(":") + 1)}` : null;
  return references[reference] ?? references[base] ?? references[node] ?? {};
}

/** Resolve typed and canonical portal links without treating remote URLs as private references. */
export function knowledgeLinkReference(value) {
  if (
    /^(source|wiki|loop|annotation|brief):[^#]+(?:#(?:claim|field|evidence):.+)?$/.test(value ?? "")
  )
    return value;
  const match = /^\/portal\/(doc|debug\/cognition\/knowledge)\/([^/?#]+)(?:\?[^#]*)?(?:#.*)?$/.exec(
    value ?? "",
  );
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2]);
    return `${match[1] === "doc" ? "source" : "node"}:${id}`;
  } catch {
    return null;
  }
}

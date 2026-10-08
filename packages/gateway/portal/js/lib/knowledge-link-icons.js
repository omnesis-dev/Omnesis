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
  const annotation = type === "doc_annotation" || type === "person_annotation";
  let glyph =
    annotation ? knowledgeIconGlyphs.annotation :
    ["wiki", "loop", "brief", "annotation"].includes(type) ? knowledgeIconGlyphs[type] : null;
  if (annotation) {
    const badge = type === "person_annotation" ? "user" : "file";
    glyph += `<circle cx="19" cy="19" r="7" fill="var(--bg-primary, white)" stroke="none"/><svg x="13" y="13" width="12" height="12" viewBox="0 0 24 24" class="kn-link-icon-badge kn-link-icon-badge--${badge}">${knowledgeIconGlyphs[badge]}</svg>`;
  }
  return glyph
    ? `<svg class="kn-link-icon kn-link-icon--${type}" aria-hidden="true" focusable="false" viewBox="0 0 ${annotation ? "27 27" : "24 24"}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`
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
  // A bare canonical page ID is local navigation, not a relative filesystem URL.
  const bare = /^(wiki|loop|root|brief|anno|panno)_[A-Za-z0-9_-]+(?:#(?:claim|field):[A-Za-z0-9_-]+)?$/.exec(
    value ?? "",
  );
  if (bare) return `${bare[1] === "root" ? "wiki" : ["anno", "panno"].includes(bare[1]) ? "annotation" : bare[1]}:${value}`;
  if (
    /^(source|wiki|loop|annotation|brief):[^#]+(?:#(?:claim|field|evidence):.+)?$/.test(value ?? "")
  )
    return value;
  const match = /^\/portal\/(doc|debug\/cognition\/(?:knowledge|briefs|loops))\/([^/?#]+)(?:\?[^#]*)?(?:#.*)?$/.exec(
    value ?? "",
  );
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2]);
    const type = match[1] === "doc" ? "source" : match[1].endsWith("/briefs") ? "brief" : match[1].endsWith("/loops") ? "loop" : "node";
    return `${type}:${id}`;
  } catch {
    return null;
  }
}

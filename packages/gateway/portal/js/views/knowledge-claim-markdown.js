// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { Marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import { knowledgeIconGlyphs } from "../lib/knowledge-icon-glyphs.js";
import {
  knowledgeIconHtml,
  knowledgeReferenceMetadata,
  knowledgeLinkReference,
} from "../lib/knowledge-link-icons.js";

/** Link hydration is bounded by the caller; code examples are not navigable references. */
export function extractKnowledgeReferences(markdown) {
  const parser = new Marked();
  const refs = new Set();
  const tokens = parser.lexer(String(markdown ?? "").replace(/<\/?claim\b[^>]*>/g, ""));
  parser.walkTokens(tokens, (token) => {
    if (token.type !== "link") return;
    const reference = knowledgeLinkReference(token.href);
    if (reference) refs.add(reference);
  });
  return [...refs];
}

/** Only recognized internal references become portal navigation URLs. */
export function internalKnowledgeHref(value) {
  // Canonical URLs already navigate correctly; metadata normalization drops selectors.
  if (/^\/portal\//.test(value ?? "")) return null;
  const match =
    /^(source|wiki|loop|annotation|brief):([^#]+)(?:#(claim|field|evidence):(.+))?$/.exec(
      knowledgeLinkReference(value) ?? "",
    );
  if (!match) return null;
  const path =
    match[1] === "source"
      ? `/portal/doc/${encodeURIComponent(match[2])}`
      : `/portal/debug/cognition/knowledge/${encodeURIComponent(match[2])}`;
  const query = new URLSearchParams();
  if (["loop", "brief"].includes(match[1])) query.set("kind", match[1]);
  if (match[3]) query.set(match[3], match[4]);
  return path + (query.size ? `?${query}` : "");
}

/** Database spans identify exact markup; never infer claims from a prose substring. */
export function claimMarkupRanges(markdown, claims) {
  return claims.flatMap((claim, index) => {
    if (
      !Number.isInteger(claim.start) ||
      !Number.isInteger(claim.end) ||
      claim.start < 0 ||
      claim.end < claim.start ||
      claim.end > markdown.length
    )
      return [];
    const begin = markdown.lastIndexOf("<claim", claim.start);
    if (
      begin < 0 ||
      markdown[claim.start - 1] !== ">" ||
      markdown.slice(claim.end, claim.end + 8) !== "</claim>"
    )
      return [];
    const opening = markdown.slice(begin, claim.start);
    if (!/^<claim\s[^<>]*>$/.test(opening)) return [];
    return [
      {
        index,
        claim,
        raw: markdown.slice(begin, claim.end + 8),
        content: markdown.slice(claim.start, claim.end),
      },
    ];
  });
}

export function renderKnowledgeMarkdown(markdown, claims = [], references = {}) {
  const ranges = claimMarkupRanges(markdown ?? "", claims);
  const prefix = `knowledge-claim-${crypto.randomUUID()}-`;
  const targets = new Map();
  const icons = new Map();
  const extension = (level) => ({
    name: level === "block" ? "knowledgeClaimBlock" : "knowledgeClaimInline",
    level,
    start(src) {
      const positions = ranges
        .filter((entry) => level !== "block" || entry.content.includes("\n"))
        .map((entry) => src.indexOf(entry.raw))
        .filter((index) => index >= 0);
      return positions.length ? Math.min(...positions) : undefined;
    },
    tokenizer(src) {
      const range = ranges.find((entry) => src.startsWith(entry.raw));
      if (!range || (level === "block" && !range.content.includes("\n"))) return;
      const id = `${prefix}${range.index}`;
      targets.set(id, range.claim.id);
      return {
        type: level === "block" ? "knowledgeClaimBlock" : "knowledgeClaimInline",
        raw: range.raw,
        id,
        label: range.index + 1,
        tokens:
          level === "block"
            ? this.lexer.blockTokens(range.content)
            : this.lexer.inlineTokens(range.content),
      };
    },
    renderer(token) {
      const tag = level === "block" ? "div" : "span";
      const body =
        level === "block" ? this.parser.parse(token.tokens) : this.parser.parseInline(token.tokens);
      const marker = `<span id="${prefix}icon-${icons.size}"></span>`;
      icons.set(marker, `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${knowledgeIconGlyphs.quote}</svg>`);
      const indicator = `<button type="button" class="kn-claim-indicator" id="${token.id}" aria-label="Inspect claim ${token.label}" aria-haspopup="dialog">${marker}</button>`;
      // Keep the indicator on the final text line, inside the last paragraph,
      // heading, list item or table cell rather than after its block container.
      const ending = /(<\/(?:p|h[1-6]|li|td|th)>)(\s*(?:<\/[^>]+>\s*)*)$/;
      const content = level === "block" && ending.test(body)
        ? body.replace(ending, (_, close, rest) => indicator + close + rest)
        : body + indicator;
      return `<${tag} class="kn-claim-span" id="${token.id}-span">${content}</${tag}>`;
    },
  });
  const parser = new Marked({
    breaks: true,
    gfm: true,
    extensions: [extension("block"), extension("inline")],
    renderer: {
      link(token) {
        const href = internalKnowledgeHref(token.href);
        const link = Renderer.prototype.link.call(this, {
          ...token,
          href: href ?? token.href,
        });
        const reference = knowledgeLinkReference(token.href);
        if (!reference) return link;
        const icon = knowledgeIconHtml({
          reference,
          ...knowledgeReferenceMetadata(reference, references),
        });
        if (!icon) return link;
        const marker = `<span id="${prefix}icon-${icons.size}"></span>`;
        icons.set(marker, icon);
        return link.replace(/^(<a\b[^>]*>)/, `$1${marker}`);
      },
    },
  });
  let sanitized = DOMPurify.sanitize(parser.parse(markdown ?? ""), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img"],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  // Untrusted prose never gains SVG/image permission. Only unguessable markers
  // emitted by our link renderer receive static icons after sanitization.
  for (const [marker, icon] of icons) sanitized = sanitized.replaceAll(marker, icon);
  return {
    html: sanitized,
    targets,
  };
}

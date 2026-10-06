// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { Marked, Renderer } from "marked";
import DOMPurify from "dompurify";

/** Only the typed internal reference grammar becomes a portal navigation URL. */
export function internalKnowledgeHref(value) {
  const match =
    /^(source|wiki|loop|annotation|brief):([^#]+)(?:#(claim|field|evidence):(.+))?$/.exec(
      value ?? "",
    );
  if (!match) return null;
  const path =
    match[1] === "source"
      ? `/portal/doc/${encodeURIComponent(match[2])}`
      : `/portal/debug/cognition/knowledge/${encodeURIComponent(match[2])}`;
  return path + (match[3] ? `?${match[3]}=${encodeURIComponent(match[4])}` : "");
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

export function renderKnowledgeMarkdown(markdown, claims = []) {
  const ranges = claimMarkupRanges(markdown ?? "", claims);
  const prefix = `knowledge-claim-${crypto.randomUUID()}-`;
  const targets = new Map();
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
      return `<${tag} class="kn-claim-span" id="${token.id}" tabindex="0" role="button" aria-label="Inspect claim ${token.label}">${body}</${tag}>`;
    },
  });
  const parser = new Marked({
    breaks: true,
    gfm: true,
    extensions: [extension("block"), extension("inline")],
    renderer: {
      link(token) {
        return Renderer.prototype.link.call(this, {
          ...token,
          href: internalKnowledgeHref(token.href) ?? token.href,
        });
      },
    },
  });
  return {
    html: DOMPurify.sanitize(parser.parse(markdown ?? ""), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["img"],
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    }),
    targets,
  };
}

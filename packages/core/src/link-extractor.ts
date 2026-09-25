// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { extractUrls, normalizeUrl, type UrlCanonicalizerSpec } from "./url-utils.js";
import { countryNameToISO2, extractPhonesFromText } from "./people-utils.js";

/**
 * The closed set of `document_links.link_type` values — the source-declared
 * structural taxonomy (#430) plus the derived / special edge kinds.
 *
 * Structural source-declared edges (the source knows the relationship and
 * asserts it, either via the `metadata.extra` conventions `extractLinks`
 * reads or via the first-class `EdgeDeclaration` contract):
 *  - `contains`        — parent contains child; child is structurally part of
 *                        the parent. Email→attachment, Notion page→subpage,
 *                        Things project→task. The attachment flavour carries
 *                        `metadata_json {"role":"attachment"}`. Replaces the
 *                        former over-specific `attachment` link type.
 *  - `part-of-thread`  — both documents are members of the same logical thread
 *                        (no directional reply implied). Email/Slack/iMessage
 *                        thread. Derived from `metadata.extra.threadId`.
 *                        Replaces the former `email-thread` link type.
 *  - `replies-to`      — this document is a direct response to that one. Email
 *                        reply via `In-Reply-To`→`Message-Id`. Directed.
 *                        Declared explicitly via the `EdgeDeclaration` contract.
 *  - `references`      — this document explicitly points at that one via the
 *                        source's own linking primitive (Notion/Obsidian
 *                        wikilink, intra-source reference). Derived from
 *                        `metadata.extra.links`. Replaces `intra-source`.
 *  - `succeeds`        — this document comes after that one in an ordered
 *                        sequence (recurring event instances, revisions).
 *                        Declared via the `EdgeDeclaration` contract.
 *  - `accompanies`     — sibling relationship: created/sent together but neither
 *                        contains the other (multiple attachments on one email,
 *                        burst photos). Declared via the contract.
 *  - `bookmarks`       — this document is a bookmark of that web page. A
 *                        `chrome-bookmarks` `bookmark` document declares it
 *                        toward the canonical `webpage` entity (source `web`),
 *                        so the bookmark and the page it bookmarks are joined in
 *                        the graph. Directed bookmark→page. Declared via the
 *                        `EdgeDeclaration` contract (#895).
 *  - `visited`         — this document records a visit to that web page. A
 *                        `browser-history` day document declares one edge per
 *                        distinct URL visited that day toward the canonical
 *                        `webpage` entity (source `web`). Directed day→page.
 *                        Declared via the `EdgeDeclaration` contract (#895).
 */
export type LinkType =
  | "url"
  | "references"
  | "contains"
  | "part-of-thread"
  | "replies-to"
  | "succeeds"
  | "accompanies"
  | "bookmarks"
  | "visited"
  // Identity link between two attachment documents that share the same
  // extracted-content SHA-256. Emitted at upsert time (not by extractLinks)
  // since detection requires querying the DB. See
  // `domain/LinkGraphService.ts#linkDuplicateContentDocs` and #264.
  | "duplicate-content"
  // Two retained representations of the same URL-addressed resource, such
  // as a rendered browser capture and the structured record from the source
  // that owns the URL. Unlike `duplicate-content`, their bytes may differ.
  | "same-resource"
  // RFC 5545 UID match: an ICS attachment carrying a UID links to any
  // calendar-source event (Google Calendar and Apple Calendar today,
  // Outlook Calendar when it ships) with the same `iCalUID`. Cross-source by design — same
  // UID, different sources, same logical event. Extracted from
  // `metadata.extra.iCalUIDs` (one link per UID) — see #266.
  | "calendar-event"
  // Shared phone number: this document's content mentions a phone number
  // (E.164-normalized) that another document also mentions — e.g. a
  // call-log day-document and a webpage/email that both reference the same
  // number. Symmetric shared-value match (like `duplicate-content`), not a
  // declared endpoint — extracted generically from every document's
  // `content` via `extractPhonesFromText`, the same way `url` links are.
  // See `domain/LinkGraphService.ts`'s `resolveLink` for how these resolve.
  | "shares-phone"
  // Agent-authored citation: an `/answer` conversation document points
  // at a document the agent cited. Written directly with the target
  // already resolved (not by `extractLinks`) — see the
  // `CONVERSATION_CITATION_LINK_TYPE` constant in the omnesis-chat
  // source's citation writer. Listed here so `LinkType` is the complete
  // closed set of `document_links.link_type` values.
  | "cited";

/**
 * The subset of `LinkType` a source DECLARES as a structural relationship —
 * the closed vocabulary of the `EdgeDeclaration` contract (#430). These are
 * the edges a source knows from its own structure (containment, threading,
 * reply chains, sequences, sibling groups, references, web-page bookmarks and
 * visits), as opposed to edges Omnesis derives (`url`, `duplicate-content`,
 * `same-resource`) or an agent authors (`cited`). `calendar-event` is a source-declared
 * cross-reference but resolves by shared iCal UID rather than a declared
 * endpoint, so it stays outside this vocabulary.
 */
export type SourceEdgeType =
  | "contains"
  | "part-of-thread"
  | "replies-to"
  | "references"
  | "succeeds"
  | "accompanies"
  | "bookmarks"
  | "visited";

export const SOURCE_EDGE_TYPES: readonly SourceEdgeType[] = [
  "contains",
  "part-of-thread",
  "replies-to",
  "references",
  "succeeds",
  "accompanies",
  "bookmarks",
  "visited",
];

export function isSourceEdgeType(type: string): type is SourceEdgeType {
  return (SOURCE_EDGE_TYPES as readonly string[]).includes(type);
}

export interface ExtractedLink {
  type: LinkType;
  rawTarget: string;
  normalizedTarget: string;
  /**
   * Per-edge details persisted to `document_links.metadata_json`. Set by the
   * `contains` flavour to `{ role: "attachment" }` so a containment edge is
   * self-describing without loading the child document. Absent for edges that
   * need no metadata.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Extract all links from document content and metadata.
 *
 * Extraction sources:
 * 1. URLs found in content text (http, https, and deep URI schemes)
 * 2. Source `references` links in metadata.extra.links (intra-source pointers)
 * 3. Thread membership (`part-of-thread`) from metadata.extra.threadId
 * 4. Containment (`contains`) from metadata.extra.parentExternalId
 * 5. Calendar cross-reference (`calendar-event`) from metadata.extra.iCalUIDs
 *
 * These are the implicit source-declared structural edges (#430): the source
 * asserts the relationship via a metadata field it controls, and Omnesis
 * records it with `source-declared` provenance. Richer / explicit edges
 * (`replies-to`, `succeeds`, cross-source `accompanies`) ride the first-class
 * `EdgeDeclaration` contract instead.
 *
 * Results are deduplicated by (type, normalizedTarget). When `ownExternalId`
 * is supplied, links that would target the doc itself are dropped — this
 * matters for the first-message-in-thread case (`threadId == messageId`)
 * which would otherwise produce a self-referential `part-of-thread` link, and
 * defensively for any source that put its own externalId in `parentExternalId`.
 *
 * `canonicalizers`, when supplied, runs each extracted URL through the
 * host-keyed per-source canonicalization registry (see `normalizeUrl`)
 * so variants like `/file/d/ABC/edit` and `/file/d/ABC` collapse to the
 * same normalized form a source document's own `source_url` lands in.
 * Without it, URL variants that differ only in host-specific suffixes
 * remain distinct in `normalizedTarget`.
 */
export function extractLinks(
  content: string,
  metadata?: {
    extra?: Record<string, unknown>;
    ingestionContext?: { phoneRegion?: string };
  },
  ownExternalId?: string,
  canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>,
): ExtractedLink[] {
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  function add(link: ExtractedLink): void {
    const key = `${link.type}:${link.normalizedTarget}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  }

  // 1. URLs from content
  const urls = extractUrls(content);
  for (const url of urls) {
    add({
      type: "url",
      rawTarget: url,
      normalizedTarget: normalizeUrl(url, canonicalizers),
    });
  }

  // 2. `references` links from metadata.extra.links (the source's own linking
  //    primitive — Notion/Obsidian wikilinks, intra-source pointers). A target
  //    in the same source answers to its external id, its title, or any name
  //    it lists in metadata.extra.linkKeys — the last for a name that is
  //    neither, such as the folder path an Obsidian note is linked by.
  const extraLinks = metadata?.extra?.links;
  if (Array.isArray(extraLinks)) {
    for (const link of extraLinks) {
      if (typeof link === "string" && link.length > 0) {
        add({
          type: "references",
          rawTarget: link,
          normalizedTarget: link.toLowerCase(),
        });
      }
    }
  }

  // 3. `part-of-thread` from metadata.extra.threadId (or conversationId fallback)
  const threadId = metadata?.extra?.threadId;
  const conversationId = metadata?.extra?.conversationId;
  const emailThreadId =
    typeof threadId === "string" && threadId.length > 0
      ? threadId
      : typeof conversationId === "string" && conversationId.length > 0
        ? conversationId
        : null;
  if (emailThreadId && emailThreadId !== ownExternalId) {
    add({
      type: "part-of-thread",
      rawTarget: emailThreadId,
      normalizedTarget: emailThreadId,
    });
  }

  // 4. `contains` (attachment flavour) from metadata.extra.parentExternalId.
  //    The child carries `{ role: "attachment" }` so the containment edge is
  //    self-describing without loading the child document.
  const parentExternalId = metadata?.extra?.parentExternalId;
  if (
    typeof parentExternalId === "string" &&
    parentExternalId.length > 0 &&
    parentExternalId !== ownExternalId
  ) {
    add({
      type: "contains",
      rawTarget: parentExternalId,
      normalizedTarget: parentExternalId,
      metadata: { role: "attachment" },
    });
  }

  // 5. Calendar-event links from metadata.extra.iCalUIDs (#266). Set on
  // ICS attachment docs by the calendar text extractor; resolves to any
  // calendar-source event whose metadata.extra.iCalUID matches.
  const iCalUIDs = metadata?.extra?.iCalUIDs;
  if (Array.isArray(iCalUIDs)) {
    for (const uid of iCalUIDs) {
      if (typeof uid === "string" && uid.length > 0) {
        add({
          type: "calendar-event",
          rawTarget: uid,
          normalizedTarget: uid,
        });
      }
    }
  }

  // 6. Shared phone numbers from content — generic, like URL extraction
  // (step 1): every document's content is scanned, regardless of source, so
  // a call-log day-document and any other document mentioning the same
  // phone number (a webpage footer, an email signature) resolve to each
  // other without either source needing to opt in.
  //
  // URL spans are stripped first — confirmed empirically against a real
  // browsing-history document: query-string values (photo-gallery item ids,
  // ad-click tracking ids like `gacid`/`aud`) are long enough digit runs to
  // parse as structurally-valid NANP numbers, producing false `shares-phone`
  // matches that have nothing to do with a phone number. A URL is already
  // captured separately as a `url` link (step 1), so removing URL spans
  // before the phone scan loses no real phone mentions.
  const phoneRegion = countryNameToISO2(metadata?.ingestionContext?.phoneRegion);
  for (const phone of extractPhonesFromText(stripUrls(content), phoneRegion)) {
    add({
      type: "shares-phone",
      rawTarget: phone,
      normalizedTarget: phone,
    });
  }

  return links;
}

/**
 * Remove URLs from text so a caller scanning the remainder for other
 * entities (phone numbers) never sees a digit run that only exists inside a
 * URL's path or query string (confirmed empirically: photo-gallery item ids
 * and ad-tracking ids parse as structurally-valid phone numbers).
 *
 * Markdown links `[text](url)` keep their visible text and drop only the
 * URL — a "click to call" link's label is often the phone number itself
 * (verified against a real customer-service email whose tel:-linked text
 * was the number itself), so unwrapping instead of stripping the whole
 * match preserves that mention rather than silently losing it. Bare URLs
 * (no separate text) are stripped entirely. `tel:` URIs are untouched
 * either way — they have no `//`, so neither pattern matches them, and
 * their digits are exactly what should reach the phone scanner.
 */
function stripUrls(content: string): string {
  const withMarkdownLinksUnwrapped = content.replace(
    /\[([^\]]*)\]\([a-z][a-z0-9+.-]*:\/\/[^)]+\)/gi,
    "$1",
  );
  return withMarkdownLinksUnwrapped.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+/gi, " ");
}

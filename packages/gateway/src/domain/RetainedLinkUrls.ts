// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeUrl, type ExtractedLink, type UrlCanonicalizerSpec } from "@omnesis/core";

/** Explicitly attached URLs survive until their target arrives, unlike incidental body URLs. */
export function retainAttachedUrls(
  links: ExtractedLink[],
  metadata: { extra?: Record<string, unknown> } | undefined,
  canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>,
): ExtractedLink[] {
  const raw = metadata?.extra?.retainedLinkUrls;
  if (!Array.isArray(raw)) return links;
  const retained = new Map<string, string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      retained.set(normalizeUrl(value, canonicalizers), value);
    } catch {
      // Document metadata is an external boundary; malformed declarations confer no retention.
    }
  }
  const attached = links.map((link) => {
    if (link.type !== "url" || !retained.has(link.normalizedTarget)) return link;
    retained.delete(link.normalizedTarget);
    return { ...link, metadata: { ...link.metadata, retainTarget: true } };
  });
  // Attachment context is independent of editable prose. A text edit must not detach its page.
  for (const [normalizedTarget, rawTarget] of retained) {
    attached.push({ type: "url", rawTarget, normalizedTarget, metadata: { retainTarget: true } });
  }
  return attached;
}

export function isRetainedUrl(link: Pick<ExtractedLink, "type" | "metadata">): boolean {
  return link.type === "url" && link.metadata?.retainTarget === true;
}

/** Read only the small per-edge marker during the bounded reconciliation scan. */
export function hasRetainedUrlMetadata(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const value: unknown = JSON.parse(raw);
    return (
      typeof value === "object" &&
      value !== null &&
      "retainTarget" in value &&
      value.retainTarget === true
    );
  } catch {
    return false;
  }
}

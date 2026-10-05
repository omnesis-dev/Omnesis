// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { browserUrlIdentity, type UrlCanonicalizerSpec } from "@omnesis/core/url-normalize";

export interface FindResult {
  id: string;
  documentId?: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  attribution?: string;
  evidence?: { documentId: string; title: string; url?: string }[];
}
export function browserUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
/** Shared with local tab matching: unknown account and routing components stay distinct. */
export function browserIdentity(value: string, canonicalizers: UrlCanonicalizerSpec[]): string {
  const url = new URL(value);
  // Capture treats trailing path slashes as the same page; keep query and
  // fragment routing intact when applying that equivalence to local cards/tabs.
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return browserUrlIdentity(
    url.href,
    canonicalizers.find((spec) => spec.hosts.includes(url.hostname)),
  );
}

/** One card per destination; the first ranked hit keeps its identity and evidence. */
export function dedupeFindResults(
  results: FindResult[],
  canonicalizers: UrlCanonicalizerSpec[],
): FindResult[] {
  const destinations = new Set<string>();
  const ids = new Set<string>();
  return results
    .filter((result) => {
      const destination = browserIdentity(result.url, canonicalizers);
      if (destinations.has(destination) || ids.has(result.id)) return false;
      destinations.add(destination);
      ids.add(result.id);
      return true;
    })
    .slice(0, 200);
}

export function readSourceLabels(value: unknown, maxLength = 128): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 2000)
      .filter(
        ([key, label]) =>
          key.length <= 512 && typeof label === "string" && label.length <= maxLength,
      ),
  );
}
export function readCanonicalizers(value: unknown): UrlCanonicalizerSpec[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const spec = raw as { hosts?: unknown; browserIdentity?: unknown };
    if (
      !Array.isArray(spec.hosts) ||
      !spec.browserIdentity ||
      typeof spec.browserIdentity !== "object"
    )
      return [];
    const hosts = spec.hosts
      .slice(0, 100)
      .filter(
        (host): host is string => typeof host === "string" && /^[a-z0-9.-]{1,253}$/.test(host),
      );
    const identity = spec.browserIdentity as {
      canonicalHost?: unknown;
      pathPrefix?: unknown;
      part?: unknown;
      format?: unknown;
      requiredQuery?: unknown;
    };
    if (
      !hosts.length ||
      !["path", "fragment"].includes(String(identity.part)) ||
      !["uuid-suffix", "hex-segment"].includes(String(identity.format))
    )
      return [];
    if (
      identity.canonicalHost !== undefined &&
      (typeof identity.canonicalHost !== "string" || !hosts.includes(identity.canonicalHost))
    )
      return [];
    if (
      identity.pathPrefix !== undefined &&
      (typeof identity.pathPrefix !== "string" ||
        !identity.pathPrefix.startsWith("/") ||
        identity.pathPrefix.length > 256)
    )
      return [];
    if (
      identity.requiredQuery !== undefined &&
      (!Array.isArray(identity.requiredQuery) ||
        identity.requiredQuery.length > 8 ||
        !identity.requiredQuery.every(
          (key: unknown) => typeof key === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(key),
        ))
    )
      return [];
    return [
      {
        hosts,
        rules: [],
        browserIdentity: {
          part: identity.part as "path" | "fragment",
          format: identity.format as "uuid-suffix" | "hex-segment",
          ...(typeof identity.canonicalHost === "string"
            ? { canonicalHost: identity.canonicalHost }
            : {}),
          ...(typeof identity.pathPrefix === "string" ? { pathPrefix: identity.pathPrefix } : {}),
          ...(Array.isArray(identity.requiredQuery)
            ? { requiredQuery: identity.requiredQuery as string[] }
            : {}),
        },
      },
    ];
  });
}
/** Prefer meaningful query terms, retaining acronyms and literal all-function-word searches. */
export function findQueryTerms(query: string): string[] {
  const words = [
    ...new Set(
      query
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 1),
    ),
  ];
  const common = new Set([
    "the",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "on",
    "for",
    "from",
    "with",
    "is",
    "are",
    "was",
    "were",
    "be",
    "by",
    "me",
    "my",
    "it",
    "this",
    "that",
    "please",
    "find",
    "show",
    "where",
    "what",
    "which",
    "who",
    "when",
    "how",
    "at",
    "as",
    "do",
    "does",
    "did",
    "you",
    "your",
    "has",
    "have",
    "had",
    "about",
  ]);
  const meaningful = words.filter((word) => !common.has(word));
  return (meaningful.length ? meaningful : words).slice(0, 12);
}
export function findSnippet(text: string, query: string): string {
  const words = findQueryTerms(query);
  const lower = text.toLocaleLowerCase();
  const matches = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0);
  const first = matches.length ? Math.min(...matches) : 0;
  const start = Math.max(0, first - 45);
  const end = Math.min(text.length, start + 480);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
export function parseFindResults(
  values: unknown[],
  labels: Record<string, string>,
  query: string,
  attributions: Record<string, string>,
): FindResult[] {
  const cards: FindResult[] = [];
  for (const value of values.slice(0, 200)) {
    if (!value || typeof value !== "object") continue;
    const hit = value as {
      id?: unknown;
      documentId?: unknown;
      title?: unknown;
      sourceUrl?: unknown;
      sourceId?: unknown;
      chunkText?: unknown;
      evidence?: unknown;
    };
    const url = browserUrl(hit.sourceUrl);
    if (!url || typeof hit.id !== "string" || !hit.id || hit.id.length > 1024) continue;
    const evidence: NonNullable<FindResult["evidence"]> = [];
    if (Array.isArray(hit.evidence))
      for (const item of hit.evidence.slice(0, 8)) {
        if (!item || typeof item !== "object") continue;
        const ref = item as { documentId?: unknown; title?: unknown; sourceUrl?: unknown };
        if (typeof ref.documentId === "string" && typeof ref.title === "string")
          evidence.push({
            documentId: ref.documentId.slice(0, 1024),
            title: ref.title.slice(0, 512),
            ...(browserUrl(ref.sourceUrl) ? { url: browserUrl(ref.sourceUrl)! } : {}),
          });
      }
    const sourceKeys =
      typeof hit.sourceId === "string" ? [hit.sourceId, hit.sourceId.split(":")[0]!] : [];
    const labelKey = sourceKeys.find((key) => Object.hasOwn(labels, key));
    const attributionKey = sourceKeys.find((key) => Object.hasOwn(attributions, key));
    cards.push({
      id: hit.id,
      ...(typeof hit.documentId === "string" ? { documentId: hit.documentId.slice(0, 1024) } : {}),
      title: typeof hit.title === "string" ? hit.title.slice(0, 512) : url,
      url,
      source: labelKey ? labels[labelKey]! : "Source",
      ...(attributionKey ? { attribution: attributions[attributionKey]! } : {}),
      snippet: typeof hit.chunkText === "string" ? findSnippet(hit.chunkText, query) : "",
      ...(evidence.length ? { evidence } : {}),
    });
  }
  return cards;
}

/** Only normalized raster data travels into cards; metadata cannot cause third-party requests. */
export function readSourceIcons(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readSourceLabels(value, 100000)).filter(([, icon]) =>
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon),
    ),
  );
}

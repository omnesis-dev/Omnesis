// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, webPageEdgeTarget, type EdgeDeclaration } from "@omnesis/core";
import { extractDomain } from "./filters.js";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { RawVisit, BrowserId } from "./types.js";

/**
 * Format a date string like "April 16, 2026"
 */
function formatDisplayDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00.000Z`);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Format a duration in seconds to a human-readable string like "5m 23s"
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Format a timestamp as a time string like "09:15". UTC so the document
 * is stable across machines/timezones (same browser data → same doc,
 * regardless of where the collector runs or whether DST is in effect).
 * Matches `formatDisplayDate` which also renders in UTC.
 */
function formatTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

/**
 * Build a daily browsing document for a single browser and date.
 *
 * Format uses ## HH:MM headings so the indexer's splitMarkdown() chunker
 * splits at time boundaries, keeping unrelated visits in separate embeddings.
 */
export function buildDailyDocument(
  browser: BrowserId,
  browserName: string,
  date: string,
  visits: RawVisit[],
  sourceId: SourceId,
  providerId: ProviderId,
  hasMultipleProfiles: boolean,
): DocumentInput {
  const sorted = [...visits].sort((a, b) => a.timestamp - b.timestamp);

  // Group visits by time (minute granularity) to create ## headings
  const timeGroups = new Map<string, RawVisit[]>();
  for (const v of sorted) {
    const time = formatTime(v.timestamp);
    const group = timeGroups.get(time) ?? [];
    group.push(v);
    timeGroups.set(time, group);
  }

  const lines: string[] = [];
  for (const [time, group] of timeGroups) {
    lines.push(`## ${time}`);
    for (const v of group) {
      const title = v.title || extractDomain(v.url) || v.url;
      let line = `- [${title}](${v.url})`;
      if (hasMultipleProfiles && v.profile !== "default") {
        line += ` _(${v.profile})_`;
      }
      if (v.visitDuration && v.visitDuration > 0) {
        line += ` — ${formatDuration(v.visitDuration)}`;
      }
      lines.push(line);
    }
    lines.push(""); // blank line after each time group
  }

  const content = lines.join("\n").trim();
  const displayDate = formatDisplayDate(date);

  return {
    providerId,
    sourceId,
    externalId: `${browser}:${date}`,
    title: `${browserName} browsing — ${displayDate}`,
    content,
    contentHash: computeContentHash(content),
    metadata: { documentType: "browsing-history", extra: { unitCount: visits.length } },
    sourceCreatedAt: `${date}T00:00:00.000Z`,
    sourceUpdatedAt: `${date}T23:59:59.999Z`,
  };
}

/**
 * The `browsing-history → webpage` declared edges for one day document (#895).
 * The day stays its own first-class `browsing-history` document; this emits one
 * `visited` edge per DISTINCT URL visited that day toward the canonical `webpage`
 * entity (source `web`), so the graph joins "I visited this page on this day" to
 * the page itself. Each edge resolves immediately if the page is already
 * captured, else defers in `pending_edges` until the extension captures it.
 *
 * `from` is internal — the day document, keyed on its `externalId`
 * (`${browser}:${date}`). `to` is the cross-source `web` entity, keyed on the
 * canonical id. `RawVisit.url` is already normalized at read time, so distinct
 * URLs map to distinct pages; we dedup by the canonical edge target so a page
 * visited many times in a day yields one edge. The day document carries no
 * per-host canonicalizer registry (the rewritten hosts are `ownedWebDomains` the
 * web dataset never captures), so the generic normalization is used.
 */
export function buildDailyEdges(
  browser: BrowserId,
  date: string,
  visits: RawVisit[],
): EdgeDeclaration[] {
  const from = { kind: "internal" as const, sourceDocumentId: `${browser}:${date}` };
  const seen = new Set<string>();
  const edges: EdgeDeclaration[] = [];
  for (const v of visits) {
    const to = webPageEdgeTarget(v.url);
    if (seen.has(to.sourceDocumentId)) continue;
    seen.add(to.sourceDocumentId);
    edges.push({ from, to, type: "visited" });
  }
  return edges;
}

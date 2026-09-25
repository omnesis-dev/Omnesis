// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Feed assembly for `GET /briefs/feed`: select the showable briefs, load
 * the ranking signals that live off-row (open related-loop deadlines)
 * and the citation display data, and return everything ranked. Read-only
 * and db-direct, like the gateway's other single-purpose read paths —
 * every brief WRITE stays on the write gate.
 */

import { listBriefFeedPage, type ShowableBriefCandidate } from "./storage/briefs.js";
import type { BriefFeedSortKey } from "./ranking.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * A citation resolved for display: the source icon derives from
 * `providerId`/`sourceId` via the client's source registry, and `docId`
 * opens the in-app document view.
 */
export interface FeedCitation {
  docId: string;
  title: string;
  providerId: string;
  sourceId: string;
}

/** One ranked feed entry: the brief plus its display-ready citations. */
export interface FeedBrief {
  brief: ShowableBriefCandidate;
  citations: FeedCitation[];
  /** Complete semantic order tuple, used only to issue the next-page cursor. */
  sortKey: BriefFeedSortKey;
}

/**
 * The ranked feed, first entry on top. `after` and `limit` apply after the
 * complete semantic rank; citation enrichment is then scoped to that bounded
 * page instead of every showable brief.
 */
export function buildBriefsFeed(
  db: Db,
  now: number,
  options: { readSnapshot: number; after?: BriefFeedSortKey; limit: number },
): FeedBrief[] {
  const page = listBriefFeedPage(db, now, options.readSnapshot, {
    limit: options.limit,
    ...(options.after ? { after: options.after } : {}),
  });
  const citations = resolveCitations(
    db,
    page.map((entry) => entry.brief.id),
  );
  return page.map((entry) => ({
    brief: entry.brief,
    citations: citations.get(entry.brief.id) ?? [],
    sortKey: entry.sortKey,
  }));
}

/**
 * Citation display data, in stored order. A citation whose document no
 * longer exists is dropped rather than rendered dead — the privacy
 * cascade already deletes briefs derived from a privacy-deleted
 * document; this covers ordinary removals (source deletion, retention).
 */
function resolveCitations(db: Db, briefIds: readonly string[]): Map<string, FeedCitation[]> {
  if (briefIds.length === 0) return new Map();
  const placeholders = briefIds.map(() => "?").join(", ");
  const rows = db
    .prepare<
      string[],
      { brief_id: string; doc_id: string; title: string; provider_id: string; source_id: string }
    >(
      `SELECT bc.brief_id, bc.doc_id, d.title, d.provider_id, d.source_id
       FROM brief_citations bc JOIN documents d ON d.id = bc.doc_id
       WHERE bc.brief_id IN (${placeholders})
       ORDER BY bc.brief_id, bc.position`,
    )
    .all(...briefIds);
  const map = new Map<string, FeedCitation[]>();
  for (const r of rows) {
    const list = map.get(r.brief_id) ?? [];
    list.push({
      docId: r.doc_id,
      title: r.title,
      providerId: r.provider_id,
      sourceId: r.source_id,
    });
    map.set(r.brief_id, list);
  }
  return map;
}

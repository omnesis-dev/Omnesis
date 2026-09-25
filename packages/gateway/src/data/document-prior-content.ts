// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pre-write capture of the content bodies an upsert batch is about to
 * overwrite, so `DocumentUpsertedEvent.beforeContent` can carry the
 * prior version to diff-interested subscribers (the Briefs waker's
 * document-diff engine).
 *
 * Deliberately narrow and lazy:
 *   - Nothing is fetched unless a consumer has declared interest via
 *     `registerPriorContentInterest()` (`events.ts`) — with the feature
 *     off, ingest pays zero extra reads.
 *   - Only documents whose incoming `contentHash` differs from the
 *     stored one are fetched — metadata-only updates and no-op re-syncs
 *     never load a body.
 *   - The bodies travel on the emitted event and are discarded with it;
 *     prior versions are never persisted (the diff consumer computes
 *     its delta at event time).
 */

import type Database from "better-sqlite3";
import type { DocumentProjection } from "./document-projection.js";
import type { DocumentInput } from "@omnesis/types";

type Db = Database.Database;

// ── Prior-content interest ─────────────────────────────────────────────
//
// A plain counter — never a cache: the bodies travel on the emitted
// event and are discarded with it. Lives here (data layer) so the fetch
// below can consult it without an upward import into the event surface;
// `events.ts` re-exports the register function for subscribers, mirroring
// the projection-helper re-export pattern.

let priorContentInterest = 0;

/** Declare interest in `beforeContent`. Returns the release function. */
export function registerPriorContentInterest(): () => void {
  priorContentInterest++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    priorContentInterest--;
  };
}

/** Whether any subscriber currently wants `beforeContent` populated. */
export function priorContentRequested(): boolean {
  return priorContentInterest > 0;
}

/**
 * For each incoming document that updates an existing row with different
 * content, fetch the current (pre-write) body. Keys of the returned map
 * are `providerId|sourceId|externalId` triples, matching the
 * `beforeProjections` maps the ingest paths already build. Returns an
 * empty map when no prior-content consumer is registered.
 */
export function collectPriorContents(
  db: Db,
  docs: readonly DocumentInput[],
  beforeProjections: ReadonlyMap<string, DocumentProjection>,
  /** The stream each source's documents belong to (`""` = the source's one stream). */
  streams?: Readonly<Record<string, string>>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!priorContentRequested() || docs.length === 0 || beforeProjections.size === 0) return out;

  // Group the content-changed updates per (provider, source) pair so
  // each pair is one chunked SELECT — same shape as the projection fetch.
  const byPair = new Map<string, string[]>();
  for (const d of docs) {
    const tripleKey = `${d.providerId}|${d.sourceId}|${d.externalId}`;
    const before = beforeProjections.get(tripleKey);
    if (!before || before.contentHash === d.contentHash) continue;
    const pairKey = `${d.providerId}|${d.sourceId}`;
    const arr = byPair.get(pairKey);
    if (arr) arr.push(d.externalId);
    else byPair.set(pairKey, [d.externalId]);
  }

  const CHUNK = 100;
  for (const [pairKey, externalIds] of byPair) {
    const [providerId, sourceId] = pairKey.split("|", 2);
    for (let i = 0; i < externalIds.length; i += CHUNK) {
      const chunk = externalIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db
        .prepare<unknown[], { external_id: string; content: string }>(
          `SELECT external_id, content FROM documents
            WHERE provider_id = ? AND source_id = ? AND stream_id = ? AND external_id IN (${placeholders})`,
        )
        .all(providerId, sourceId, streams?.[sourceId] ?? "", ...chunk);
      for (const r of rows) {
        out.set(`${providerId}|${sourceId}|${r.external_id}`, r.content);
      }
    }
  }
  return out;
}

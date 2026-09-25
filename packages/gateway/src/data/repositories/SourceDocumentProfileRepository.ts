// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable store of each source type's `documentEventProfile` — what that
 * source's documents can be asked about.
 *
 * The collector loads every provider package, so it alone knows the full set
 * of declarations; it publishes them to the gateway at boot. Subscription
 * compilation reads them here to build a bounded, opaque-handle projection of
 * the queryable document surface, the same way it projects the analytics
 * catalog's categorical vocabularies.
 *
 * Why this is persisted rather than held in memory like the other boot pushes:
 * the compiler re-validates a compiled plan's dependencies at approval, at
 * fire time, and again before a firing's answer is allowed out — and pauses
 * the watch when a dependency it compiled against is gone. An in-memory
 * registry is empty for the window between a gateway restart and the
 * collector's reconnect, and "the profile is absent" is exactly the signal
 * that means "this source was removed". Every document watch in the install
 * would pause on a routine restart. Persisting the published snapshot keeps
 * absence meaning what it says.
 *
 * The gateway treats a profile as opaque source-declared data: no source name
 * is branched on here, and the vocabulary each field carries belongs to the
 * provider package that declared it.
 */

import { createLogger } from "@omnesis/core";
import type { DocumentEventProfile } from "@omnesis/source-sdk";
import type { Db } from "../types.js";

const log = createLogger("gateway").child("source-document-profiles");

/** One source type's published document-event declaration. */
export interface SourceDocumentProfileEntry {
  /** Source type (the `<type>` half of a `<type>:<accountId>` source id). */
  sourceType: string;
  profile: DocumentEventProfile;
}

export function createSourceDocumentProfilesTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_document_profiles (
      source_type TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      published_at INTEGER NOT NULL
    )
  `);
}

/**
 * Record the profiles a collector published, leaving other source types alone.
 *
 * A publisher's list is complete for the sources IT loaded, which is not the
 * same as complete: `supportedPlatforms` means a Linux collector never loads
 * the macOS-only sources, so clearing the table on each publish would let one
 * host erase another's declarations. The sibling boot pushes replace wholesale
 * and can afford to — a lost owned-domain entry costs a double-ingested page
 * and heals on the next push. A lost profile is read as "this source is gone",
 * which fails a compiled plan's dependency check and pauses the watch. So this
 * merges.
 *
 * The cost of merging is a stale row for a provider that no longer exists in
 * the code at all, which nothing reads: lookups are keyed by the source types
 * the operator actually has. That is the right way round to be wrong.
 *
 * One transaction, so a reader never observes a partial publish.
 */
export function upsertSourceDocumentProfiles(
  db: Db,
  entries: readonly SourceDocumentProfileEntry[],
  publishedAt: number,
): { stored: number } {
  const insert = db.prepare<[string, string, number]>(
    `INSERT INTO source_document_profiles (source_type, profile_json, published_at)
     VALUES (?, ?, ?)
     ON CONFLICT(source_type) DO UPDATE SET
       profile_json = excluded.profile_json,
       published_at = excluded.published_at`,
  );

  db.transaction(() => {
    for (const entry of entries) {
      insert.run(entry.sourceType, JSON.stringify(entry.profile), publishedAt);
    }
  })();

  log.info(`stored document-event profiles for ${entries.length} source type(s)`);
  return { stored: entries.length };
}

/**
 * The profile published for one source type, or `null` when that source type
 * declared none (or is not installed at all). The caller passes the source
 * type, not a full source id — a profile describes the source contract and is
 * identical across accounts.
 */
export function getSourceDocumentProfile(db: Db, sourceType: string): DocumentEventProfile | null {
  const row = db
    .prepare<
      [string],
      { profile_json: string }
    >("SELECT profile_json FROM source_document_profiles WHERE source_type = ?")
    .get(sourceType);
  if (!row) return null;
  return parseProfile(sourceType, row.profile_json);
}

/** Every published profile, ordered by source type for a stable projection. */
export function listSourceDocumentProfiles(db: Db): SourceDocumentProfileEntry[] {
  const rows = db
    .prepare<
      [],
      { source_type: string; profile_json: string }
    >("SELECT source_type, profile_json FROM source_document_profiles ORDER BY source_type")
    .all();

  const entries: SourceDocumentProfileEntry[] = [];
  for (const row of rows) {
    const profile = parseProfile(row.source_type, row.profile_json);
    if (profile) entries.push({ sourceType: row.source_type, profile });
  }
  return entries;
}

/**
 * Decode a stored profile. A row written by a build whose JSON shape the
 * current one cannot read is dropped rather than thrown on: one unreadable
 * row must not deny every other source its profile, and the next collector
 * boot republishes the whole set anyway.
 */
function parseProfile(sourceType: string, json: string): DocumentEventProfile | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("profile must be a JSON object");
    }
    return parsed as DocumentEventProfile;
  } catch (err) {
    log.warn(
      `Skipping unreadable document-event profile for '${sourceType}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

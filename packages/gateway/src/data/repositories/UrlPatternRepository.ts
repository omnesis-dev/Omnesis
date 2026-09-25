// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, parseSourceKey } from "@omnesis/core";
import {
  compileSafeUrlPattern,
  disposeSafeUrlPatternMatcher,
  MAX_KNOWN_URL_PATTERN_LENGTH,
  MAX_KNOWN_URL_PATTERNS,
  MAX_KNOWN_URL_PATTERNS_SERIALIZED_LENGTH,
  type SafeUrlPatternMatcher,
} from "../../known-url-pattern-safety.js";
import type Database from "better-sqlite3";
type Db = Database.Database;

const log = createLogger("gateway:url-patterns");

/** Get all URL ID patterns from sync_state for link resolution. */
export function getUrlIdPatterns(
  db: Db,
): Array<{ regex: SafeUrlPatternMatcher; sourceTypePrefix: string }> {
  const rows = db
    .prepare<[number], { source_id: string; url_patterns: string | null }>(
      `SELECT source_id,
              CASE WHEN length(url_patterns) <= ? THEN url_patterns ELSE NULL END AS url_patterns
         FROM sync_state WHERE url_patterns IS NOT NULL`,
    )
    .all(MAX_KNOWN_URL_PATTERNS_SERIALIZED_LENGTH);
  const patterns: Array<{ regex: SafeUrlPatternMatcher; sourceTypePrefix: string }> = [];
  for (const row of rows) {
    if (row.url_patterns === null) {
      log.warn(`Skipping oversized url_patterns for ${row.source_id}`);
      continue;
    }
    let sourceType: string;
    try {
      sourceType = parseSourceKey(row.source_id).sourceType;
    } catch (err) {
      log.warn(
        `Skipping url_patterns with invalid source id ${row.source_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.url_patterns);
    } catch (err) {
      log.warn(
        `Skipping unparseable url_patterns for ${row.source_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_KNOWN_URL_PATTERNS) {
      log.warn(`Skipping invalid url_patterns shape for ${row.source_id}`);
      continue;
    }
    for (const p of parsed) {
      // The write boundary validates these regexes, but a row written by an
      // older build (or hand-edited) could still hold an invalid or oversized
      // entry. Bound legacy rows before compilation so an upgrade cannot turn
      // URL resolution into unbounded parse/compile work.
      if (
        typeof p !== "object" ||
        p === null ||
        !("regex" in p) ||
        typeof p.regex !== "string" ||
        p.regex.length === 0 ||
        p.regex.length > MAX_KNOWN_URL_PATTERN_LENGTH ||
        ("idGroup" in p &&
          p.idGroup !== undefined &&
          (typeof p.idGroup !== "number" || !Number.isInteger(p.idGroup) || p.idGroup < 0))
      ) {
        log.warn(`Skipping invalid URL pattern for ${row.source_id}`);
        continue;
      }
      try {
        patterns.push({ regex: compileSafeUrlPattern(p.regex), sourceTypePrefix: sourceType });
      } catch (err) {
        log.warn(
          `Skipping invalid URL pattern for ${row.source_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// Shared per-db URL pattern cache
// ---------------------------------------------------------------------------
//
// Patterns rarely change (only when a source registers via setSyncState
// with a urlPatterns argument). Link resolution paths need them hot, so this
// cache provides one in-memory copy and one invalidation hook.
//
// The cache is module state, so each isolate holds its own copy — and the
// isolate that needs these most is the IO worker, which resolves links on a
// permanent read-only handle and never sees the HTTP boundary's
// `invalidateUrlIdPatternCache()`. Its copy is therefore validated against
// the database itself: `PRAGMA data_version` changes only when ANOTHER
// connection commits, so on a handle that never writes it is an exact
// "has anything landed since I loaded?" signal costing a fraction of a
// microsecond, and the registered-row fingerprint below is read only on the
// ticks where it says something did. Without this, a source added while the
// gateway is up (`omnesis sources add notion`) stays invisible to
// url-pattern → external_id resolution until the process restarts.

let cachedUrlIdPatterns: ReadonlyArray<{
  regex: SafeUrlPatternMatcher;
  sourceTypePrefix: string;
}> | null = null;
let cachedUrlIdPatternsDb: Db | null = null;
/** `PRAGMA data_version` observed when the memo was loaded. */
let cachedDataVersion = 0;
/** Serialized `sync_state` url-pattern rows the memo was compiled from. */
let cachedRowFingerprint = "";
/** Both statements belong to `cachedUrlIdPatternsDb` and die with it. */
let dataVersionStmt: Database.Statement<[]> | null = null;
let rowFingerprintStmt: Database.Statement<
  [number],
  { source_id: string; url_patterns: string | null }
> | null = null;

function readDataVersion(db: Db): number {
  dataVersionStmt ??= db.prepare("PRAGMA data_version").pluck();
  return dataVersionStmt.get() as number;
}

/**
 * Length-prefixed serialization of exactly the input `getUrlIdPatterns`
 * compiles from: length prefixes so no value can forge a row boundary, and the
 * same oversize CASE, which both bounds the string and keeps an edit inside a
 * cell too large to compile from forcing a pointless recompile.
 */
function readRowFingerprint(db: Db): string {
  rowFingerprintStmt ??= db.prepare(
    `SELECT source_id,
            CASE WHEN length(url_patterns) <= ? THEN url_patterns ELSE NULL END AS url_patterns
       FROM sync_state WHERE url_patterns IS NOT NULL ORDER BY source_id`,
  );
  let fingerprint = "";
  for (const row of rowFingerprintStmt.all(MAX_KNOWN_URL_PATTERNS_SERIALIZED_LENGTH)) {
    const patterns = row.url_patterns ?? "";
    fingerprint += `${row.source_id.length}:${row.source_id}${patterns.length}:${patterns}`;
  }
  return fingerprint;
}

/**
 * Memoized variant of `getUrlIdPatterns`. Returns the same array across calls
 * until either `invalidateUrlIdPatternCache()` is called (which fires from
 * the HTTP boundary whenever `setSyncState` lands a `urlPatterns` payload) or
 * another connection commits a change to the rows it was compiled from.
 */
export function getCachedUrlIdPatterns(
  db: Db,
): ReadonlyArray<{ regex: SafeUrlPatternMatcher; sourceTypePrefix: string }> {
  if (cachedUrlIdPatterns && cachedUrlIdPatternsDb === db) {
    const version = readDataVersion(db);
    if (version === cachedDataVersion) return cachedUrlIdPatterns;
    cachedDataVersion = version;
    const fingerprint = readRowFingerprint(db);
    if (fingerprint === cachedRowFingerprint) return cachedUrlIdPatterns;
  }
  disposeCachedUrlIdPatterns();
  cachedUrlIdPatternsDb = db;
  // Read the validators BEFORE the patterns: a commit landing in between then
  // leaves a fingerprint that is older than what was compiled, costing one
  // redundant reload rather than pinning a stale memo.
  cachedDataVersion = readDataVersion(db);
  cachedRowFingerprint = readRowFingerprint(db);
  cachedUrlIdPatterns = getUrlIdPatterns(db);
  return cachedUrlIdPatterns;
}

/** Clear the shared URL pattern cache. */
export function invalidateUrlIdPatternCache(): void {
  disposeCachedUrlIdPatterns();
}

function disposeCachedUrlIdPatterns(): void {
  if (cachedUrlIdPatterns) {
    for (const pattern of cachedUrlIdPatterns) disposeSafeUrlPatternMatcher(pattern.regex);
  }
  cachedUrlIdPatterns = null;
  cachedUrlIdPatternsDb = null;
  cachedDataVersion = 0;
  cachedRowFingerprint = "";
  dataVersionStmt = null;
  rowFingerprintStmt = null;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SyncCursor } from "@omnesis/source-sdk";

/** Supported browser identifiers */
export type BrowserId = "chrome" | "safari" | "arc" | "brave" | "edge" | "vivaldi";

/** Browser engine type — determines which reader to use */
export type BrowserEngine = "chromium" | "safari";
// TODO: Add "firefox" engine when Firefox support is implemented (#17)

/** Metadata about an installed browser */
export interface BrowserInfo {
  id: BrowserId;
  name: string;
  baseDir: string;
  engine: BrowserEngine;
}

/** A Chromium profile discovered from Local State */
export interface ChromiumProfile {
  /** Directory name: "Default", "Profile 1", etc. */
  dir: string;
  /** Display name from profile info */
  name: string;
  /** Google account email, if signed in */
  email?: string;
}

/** A normalized visit record from any browser */
export interface RawVisit {
  /**
   * URL after `core.normalizeUrl` (tracking-param strip, fragment strip,
   * sorted query, lowercased host, no trailing slash). Two visits to the
   * same logical page now share the same `url` regardless of `?utm_*`
   * differences — fixes the unique_urls / top_domain skew called out in
   * the URL normalisation rules.
   */
  url: string;
  /**
   * Lowercased canonical hostname (`www.` stripped). Set by the reader
   * alongside `url` so downstream code never reaches for `new URL(...)`.
   */
  domain: string;
  title: string;
  /** Milliseconds since Unix epoch (already converted from native format) */
  timestamp: number;
  /** Seconds spent on page (Chromium only, undefined for Safari) */
  visitDuration?: number;
  /** Normalized transition type */
  transitionType?: string;
  /** Raw Chromium transition bitmask (for filtering redirect chains) */
  transitionRaw?: number;
  /** Whether this visit was synced from another device */
  isSynced: boolean;
  /** Profile display name (Chromium only) */
  profile: string;
  /** Browser identifier */
  browser: BrowserId;
  /** Whether the URL is hidden from browser UI (Chromium) */
  hidden?: boolean;
}

/** A search term record from Chromium's keyword_search_terms table */
export interface RawSearchTerm {
  browser: BrowserId;
  profile: string;
  /** Milliseconds since Unix epoch */
  timestamp: number;
  term: string;
  normalizedTerm: string;
  searchEngineDomain: string;
}

/** Cursor for multi-phase browser history sync */
export interface BrowserHistoryCursor extends SyncCursor {
  phase: "visits" | "daily" | "search_terms" | "documents" | "done";
  /** Last visit timestamp processed per profile dir, in native format (not ms) */
  lastVisitTime: Record<string, number>;
  /** Number of visit records processed so far */
  visitsProcessed: number;
  /** YYYY-MM-DD dates that had new visits this sync cycle */
  affectedDates: string[];
}

/** User-configurable options in collector.json */
export interface BrowserHistoryConfig {
  /** Domains to exclude from indexing */
  excludeDomains?: string[];
  /** URL patterns to exclude (glob-style) */
  excludeUrlPatterns?: string[];
  /** Whether to exclude localhost/127.0.0.1 visits */
  excludeLocalhost?: boolean;
  /** Profile names to exclude (Chromium only) */
  excludeProfiles?: string[];
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/** Individual page visits — one row per visit event */
export const browserVisitsSchema: AnalyticsTableSchema = {
  tableName: "browser_visits",
  displayName: "Browser Visits",
  description: "Individual page visits from browser history",
  columns: [
    {
      name: "id",
      type: "VARCHAR",
      description: "Unique visit ID (browser:profile:timestamp:url_hash)",
    },
    {
      name: "browser",
      type: "VARCHAR",
      description: "Browser name (chrome, safari, arc, brave, edge, vivaldi)",
    },
    { name: "profile", type: "VARCHAR", description: "Profile display name" },
    { name: "timestamp", type: "TIMESTAMPTZ", description: "Visit time" },
    { name: "url", type: "VARCHAR", description: "Full URL", references: "url" },
    { name: "domain", type: "VARCHAR", description: "Extracted hostname" },
    { name: "title", type: "VARCHAR", description: "Page title" },
    {
      name: "visit_duration_seconds",
      type: "INTEGER",
      description: "Time spent on page (Chromium only)",
      nullable: true,
    },
    {
      name: "transition_type",
      type: "VARCHAR",
      description: "How the page was reached (link, typed, bookmark, reload, etc.)",
      nullable: true,
    },
    {
      name: "is_synced",
      type: "BOOLEAN",
      description: "Whether this visit was synced from another device",
    },
  ],
  primaryKey: ["id"],
  // The visit instant is the row's semantic time.
  semanticTimeColumn: "timestamp",
  record: { titleColumns: ["title", "domain"], keyColumns: ["url", "browser", "timestamp"] },
  // Shared across browser-history:chrome / :safari / :arc / :brave /
  // :edge / :vivaldi — every row carries the source's `browser` slug,
  // which matches the source's accountId. On source removal the gateway
  // runs `DELETE FROM <table> WHERE browser = '<accountId>'` rather
  // than dropping the whole table.
  sharedDiscriminatorColumn: "browser",
  exampleQueries: [
    "SELECT domain, COUNT(*) AS visits FROM browser_visits WHERE timestamp > CURRENT_DATE - INTERVAL '7 days' GROUP BY domain ORDER BY visits DESC LIMIT 20",
    "SELECT EXTRACT(hour FROM timestamp) AS hour, COUNT(*) FROM browser_visits GROUP BY hour ORDER BY hour",
    "SELECT browser, profile, COUNT(*) FROM browser_visits GROUP BY browser, profile",
  ],
};

/** Pre-aggregated daily summaries for fast dashboard queries */
export const browserDailySchema: AnalyticsTableSchema = {
  tableName: "browser_daily",
  displayName: "Browser Daily Summary",
  description: "Daily browsing aggregates per browser and profile",
  columns: [
    { name: "id", type: "VARCHAR", description: "Unique row ID (browser:profile:date)" },
    { name: "browser", type: "VARCHAR", description: "Browser name" },
    { name: "profile", type: "VARCHAR", description: "Profile display name" },
    { name: "date", type: "DATE", description: "Visit date" },
    { name: "total_visits", type: "INTEGER", description: "Number of page visits" },
    { name: "unique_domains", type: "INTEGER", description: "Distinct domains visited" },
    { name: "unique_urls", type: "INTEGER", description: "Distinct URLs visited" },
    {
      name: "total_duration_seconds",
      type: "INTEGER",
      description: "Total browsing time in seconds (Chromium only)",
      nullable: true,
    },
    { name: "top_domain", type: "VARCHAR", description: "Most visited domain that day" },
  ],
  primaryKey: ["id"],
  // Daily aggregate keyed by calendar day.
  semanticTimeColumn: "date",
  record: {
    titleColumns: ["date", "browser"],
    titleTemplate: "{browser} · {date}",
    keyColumns: ["date", "total_visits", "top_domain"],
  },
  // Shared across browser-history:chrome / :safari / :arc / :brave /
  // :edge / :vivaldi — every row carries the source's `browser` slug,
  // which matches the source's accountId. On source removal the gateway
  // runs `DELETE FROM <table> WHERE browser = '<accountId>'` rather
  // than dropping the whole table.
  sharedDiscriminatorColumn: "browser",
  exampleQueries: [
    "SELECT date, SUM(total_visits) AS visits FROM browser_daily GROUP BY date ORDER BY date DESC LIMIT 14",
    "SELECT date, top_domain, total_visits FROM browser_daily ORDER BY date DESC LIMIT 30",
    "SELECT browser, SUM(total_visits) FROM browser_daily WHERE date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY browser",
  ],
};

/** Search queries from the browser omnibox (Chromium only) */
export const browserSearchTermsSchema: AnalyticsTableSchema = {
  tableName: "browser_search_terms",
  displayName: "Browser Search Terms",
  description: "Search queries entered in the browser address bar (Chromium browsers only)",
  columns: [
    { name: "id", type: "VARCHAR", description: "Unique ID (browser:profile:url_id)" },
    { name: "browser", type: "VARCHAR", description: "Browser name" },
    { name: "profile", type: "VARCHAR", description: "Profile display name" },
    { name: "timestamp", type: "TIMESTAMPTZ", description: "Time of the search" },
    { name: "term", type: "VARCHAR", description: "Search query as entered" },
    { name: "normalized_term", type: "VARCHAR", description: "Lowercased/normalized search query" },
    {
      name: "search_engine_domain",
      type: "VARCHAR",
      description: "Domain where search was performed",
    },
  ],
  primaryKey: ["id"],
  // The moment the search was entered.
  semanticTimeColumn: "timestamp",
  record: {
    titleColumns: ["term"],
    keyColumns: ["term", "search_engine_domain", "timestamp"],
  },
  // Shared across browser-history:chrome / :safari / :arc / :brave /
  // :edge / :vivaldi — every row carries the source's `browser` slug,
  // which matches the source's accountId. On source removal the gateway
  // runs `DELETE FROM <table> WHERE browser = '<accountId>'` rather
  // than dropping the whole table.
  sharedDiscriminatorColumn: "browser",
  exampleQueries: [
    "SELECT normalized_term, COUNT(*) AS times FROM browser_search_terms GROUP BY normalized_term ORDER BY times DESC LIMIT 20",
    "SELECT DATE_TRUNC('week', timestamp) AS week, COUNT(*) FROM browser_search_terms GROUP BY week ORDER BY week",
    "SELECT search_engine_domain, COUNT(*) FROM browser_search_terms GROUP BY search_engine_domain",
  ],
};

export const allSchemas = [browserVisitsSchema, browserDailySchema, browserSearchTermsSchema];

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * Page visits — the analytics plane of the Web Pages source.
 *
 * One row per dwell-confirmed visit (the browser extension confirms a visit
 * after a ≥5s focused dwell). Decoupled from the content plane: the content
 * document is one-per-canonical-URL and upserted, whereas a visit is a
 * point-in-time event keyed by `(url, visited_at)` — so the same page visited
 * twice yields two visit rows but a single, latest-snapshot content document.
 *
 * `visited_at` is the semantic time (record-citations, #757): a visit is
 * placed at the instant the dwell was confirmed.
 */
export const pageVisitsSchema: AnalyticsTableSchema = {
  tableName: "page_visits",
  displayName: "Page Visits",
  description: "Web pages viewed in the browser, captured on focused dwell",
  columns: [
    {
      name: "url",
      type: "VARCHAR",
      description: "Normalized page URL (fragment dropped, tracking params stripped)",
      references: "url",
    },
    { name: "domain", type: "VARCHAR", description: "Host of the page (e.g. example.com)" },
    { name: "title", type: "VARCHAR", description: "Page title at capture time", nullable: true },
    { name: "visited_at", type: "TIMESTAMPTZ", description: "When the dwell was confirmed" },
    {
      name: "dwell_ms",
      type: "INTEGER",
      description: "Focused dwell time on the page, in milliseconds",
    },
    {
      name: "browser_device_id",
      type: "VARCHAR",
      description: "Paired-device ID reported by the extension for Chrome profile attribution",
      nullable: true,
    },
    {
      name: "browser_profile_label",
      type: "VARCHAR",
      description: "User-entered Chrome profile name at capture time",
      nullable: true,
    },
  ],
  // A visit is uniquely identified by where (url) and when (visited_at).
  primaryKey: ["url", "visited_at"],
  // A visit is placed at the instant it was confirmed.
  semanticTimeColumn: "visited_at",
  record: {
    titleColumns: ["title", "url"],
    keyColumns: ["url", "visited_at"],
  },
  exampleQueries: [
    "SELECT domain, COUNT(*) AS visits FROM page_visits WHERE visited_at >= CURRENT_DATE - INTERVAL '7 days' GROUP BY domain ORDER BY visits DESC LIMIT 10",
    "SELECT domain, SUM(dwell_ms)/60000.0 AS minutes FROM page_visits GROUP BY domain ORDER BY minutes DESC LIMIT 10",
    "SELECT url, title, browser_profile_label, visited_at, dwell_ms FROM page_visits ORDER BY visited_at DESC LIMIT 25",
  ],
};

export const allSchemas: AnalyticsTableSchema[] = [pageVisitsSchema];

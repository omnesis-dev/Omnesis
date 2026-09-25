// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * Raw app usage sessions — one row per foreground session.
 */
export const screenTimeSessionsSchema: AnalyticsTableSchema = {
  tableName: "screen_time_sessions",
  displayName: "Screen Time Sessions",
  description: "Individual app foreground sessions from macOS Screen Time",
  columns: [
    { name: "id", type: "VARCHAR", description: "Unique session ID (bundleId:startTime)" },
    {
      name: "bundle_id",
      type: "VARCHAR",
      description: "App bundle identifier (e.g. com.google.Chrome)",
    },
    { name: "app_name", type: "VARCHAR", description: "Human-readable app name" },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Session start time" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "Session end time" },
    { name: "duration_seconds", type: "INTEGER", description: "Session duration in seconds" },
    { name: "date", type: "DATE", description: "Date (YYYY-MM-DD)" },
    { name: "day_of_week", type: "INTEGER", description: "Day of week (0=Sunday, 6=Saturday)" },
  ],
  primaryKey: ["id"],
  // A session is placed at its start instant.
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["app_name"],
    keyColumns: ["app_name", "start_time", "duration_seconds"],
  },
  exampleQueries: [
    "SELECT app_name, SUM(duration_seconds)/3600.0 AS hours FROM screen_time_sessions WHERE date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY app_name ORDER BY hours DESC LIMIT 10",
    "SELECT date, SUM(duration_seconds)/3600.0 AS hours FROM screen_time_sessions GROUP BY date ORDER BY date DESC LIMIT 14",
    "SELECT app_name, COUNT(*) AS sessions, SUM(duration_seconds)/60.0 AS minutes FROM screen_time_sessions WHERE date = CURRENT_DATE GROUP BY app_name ORDER BY minutes DESC",
  ],
};

/**
 * Daily per-app aggregates — one row per app per day.
 */
export const screenTimeDailySchema: AnalyticsTableSchema = {
  tableName: "screen_time_daily",
  displayName: "Screen Time Daily",
  description: "Daily per-app screen time aggregates",
  columns: [
    { name: "id", type: "VARCHAR", description: "Unique row ID (bundleId:date)" },
    { name: "bundle_id", type: "VARCHAR", description: "App bundle identifier" },
    { name: "app_name", type: "VARCHAR", description: "Human-readable app name" },
    { name: "date", type: "DATE", description: "Date (YYYY-MM-DD)" },
    { name: "total_seconds", type: "INTEGER", description: "Total foreground time in seconds" },
    { name: "session_count", type: "INTEGER", description: "Number of sessions" },
    {
      name: "longest_session_seconds",
      type: "INTEGER",
      description: "Longest single session in seconds",
    },
  ],
  primaryKey: ["id"],
  // Daily aggregate keyed by calendar day.
  semanticTimeColumn: "date",
  record: {
    titleColumns: ["app_name", "date"],
    titleTemplate: "{app_name} · {date}",
    keyColumns: ["app_name", "date", "total_seconds", "session_count"],
  },
  exampleQueries: [
    "SELECT date, SUM(total_seconds)/3600.0 AS total_hours FROM screen_time_daily GROUP BY date ORDER BY date DESC LIMIT 14",
    "SELECT app_name, SUM(total_seconds)/3600.0 AS hours FROM screen_time_daily WHERE date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY app_name ORDER BY hours DESC LIMIT 10",
    "SELECT date, app_name, total_seconds/60.0 AS minutes FROM screen_time_daily WHERE app_name = 'Chrome' ORDER BY date DESC LIMIT 30",
  ],
};

export const allSchemas = [screenTimeSessionsSchema, screenTimeDailySchema];

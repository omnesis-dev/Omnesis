// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import dev.omnesis.android.transport.dto.AnalyticsColumn
import dev.omnesis.android.transport.dto.AnalyticsTableSchema
import dev.omnesis.android.transport.dto.RecordDisplaySpec

/**
 * DuckDB tables for Android's `UsageStatsManager`-derived app-usage data.
 * Column shapes mirror the macOS `screen-time` provider's
 * `screen_time_sessions` / `screen_time_daily` pair
 * (`packages/providers/screen-time/src/schemas.ts`), translated to
 * `AnalyticsTableSchema` — same two-table split (raw sessions + daily
 * per-app aggregates), different underlying OS API. Neither table declares a
 * document binding: the "Attention Timeline" document
 * ([AppUsageNormalizer.buildDayDocument]) aggregates many rows from BOTH
 * tables into one per-day document, so there is no natural 1:1 row-to-document
 * edge the way a single call maps to `call-log`'s day document.
 */
const val ANDROID_APP_USAGE_SESSIONS_TABLE = "android_app_usage_sessions"
const val ANDROID_APP_USAGE_DAILY_TABLE = "android_app_usage_daily"

val androidAppUsageSessionsSchema = AnalyticsTableSchema(
    tableName = ANDROID_APP_USAGE_SESSIONS_TABLE,
    displayName = "Android App Usage Sessions",
    description = "Individual per-app foreground sessions from Android's UsageStatsManager.",
    columns = listOf(
        AnalyticsColumn(name = "id", type = "VARCHAR", description = "Unique session id (packageName:startTimeMillis)"),
        AnalyticsColumn(name = "package_name", type = "VARCHAR", description = "App package identifier (e.g. com.example.chat)"),
        AnalyticsColumn(name = "app_name", type = "VARCHAR", description = "Human-readable app label"),
        AnalyticsColumn(name = "start_time", type = "TIMESTAMPTZ", description = "Session start time (UTC)"),
        AnalyticsColumn(name = "end_time", type = "TIMESTAMPTZ", description = "Session end time (UTC)"),
        AnalyticsColumn(name = "duration_seconds", type = "DOUBLE", description = "Session duration in seconds"),
        AnalyticsColumn(name = "date", type = "DATE", description = "Calendar date (UTC) the session started — joins the Attention Timeline day-document"),
    ),
    primaryKey = listOf("id"),
    semanticTimeColumn = "start_time",
    record = RecordDisplaySpec(
        titleColumns = listOf("app_name"),
        keyColumns = listOf("app_name", "start_time", "duration_seconds"),
    ),
    exampleQueries = listOf(
        "SELECT app_name, SUM(duration_seconds)/3600.0 AS hours FROM android_app_usage_sessions WHERE date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY app_name ORDER BY hours DESC LIMIT 10",
        "SELECT date, SUM(duration_seconds)/3600.0 AS hours FROM android_app_usage_sessions GROUP BY date ORDER BY date DESC LIMIT 14",
    ),
)

val androidAppUsageDailySchema = AnalyticsTableSchema(
    tableName = ANDROID_APP_USAGE_DAILY_TABLE,
    displayName = "Android App Usage Daily",
    description = "Daily per-app screen-time aggregates from Android's UsageStatsManager.",
    columns = listOf(
        AnalyticsColumn(name = "id", type = "VARCHAR", description = "Unique row id (packageName:date)"),
        AnalyticsColumn(name = "package_name", type = "VARCHAR", description = "App package identifier"),
        AnalyticsColumn(name = "app_name", type = "VARCHAR", description = "Human-readable app label"),
        AnalyticsColumn(name = "date", type = "DATE", description = "Calendar date (UTC)"),
        AnalyticsColumn(name = "total_seconds", type = "DOUBLE", description = "Total foreground time in seconds"),
        AnalyticsColumn(name = "session_count", type = "INTEGER", description = "Number of sessions"),
    ),
    primaryKey = listOf("id"),
    semanticTimeColumn = "date",
    record = RecordDisplaySpec(
        titleColumns = listOf("app_name", "date"),
        titleTemplate = "{app_name} · {date}",
        keyColumns = listOf("app_name", "date", "total_seconds", "session_count"),
    ),
    exampleQueries = listOf(
        "SELECT date, SUM(total_seconds)/3600.0 AS total_hours FROM android_app_usage_daily GROUP BY date ORDER BY date DESC LIMIT 14",
        "SELECT app_name, SUM(total_seconds)/3600.0 AS hours FROM android_app_usage_daily WHERE date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY app_name ORDER BY hours DESC LIMIT 10",
    ),
)

val ANDROID_APP_USAGE_SCHEMAS = listOf(androidAppUsageSessionsSchema, androidAppUsageDailySchema)

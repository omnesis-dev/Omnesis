// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import dev.omnesis.android.transport.dto.AnalyticsColumn
import dev.omnesis.android.transport.dto.AnalyticsTableSchema
import dev.omnesis.android.transport.dto.RecordDisplaySpec

/** DuckDB table for Android native phone calls. Per-source (not shared with
 * `apple_call_log`) so it stays source-encapsulated. */
const val ANDROID_CALL_LOG_TABLE = "android_call_log"

/**
 * Structured twin of the call-log documents — but NOT a 1:1 `boundDocument`
 * like a per-event table: a `call-log` document aggregates a whole day's
 * calls, while this table has one row per raw call (keyed on the device's
 * `CallLog.Calls._ID`). The `date` column is the natural cross-reference back
 * to the day-document's `externalId` (`call-log:${date}`).
 */
val androidCallLogSchema = AnalyticsTableSchema(
    tableName = ANDROID_CALL_LOG_TABLE,
    displayName = "Android Call Log",
    description = "Native phone calls (Android CallLog.Calls) — durations, peers, and missed-call reasons.",
    columns = listOf(
        AnalyticsColumn(name = "id", type = "VARCHAR", description = "Call log row id (CallLog.Calls._ID)"),
        AnalyticsColumn(
            name = "date",
            type = "DATE",
            description = "Calendar date (UTC) the call happened — joins the call-log day-document",
        ),
        AnalyticsColumn(name = "time", type = "TIMESTAMPTZ", description = "Call start instant (UTC)"),
        AnalyticsColumn(name = "direction", type = "VARCHAR", description = "incoming | outgoing"),
        AnalyticsColumn(
            name = "call_type",
            type = "VARCHAR",
            description = "Raw CallLog.Calls.TYPE: incoming | outgoing | missed | voicemail | rejected | blocked | answered_externally",
        ),
        AnalyticsColumn(
            name = "medium",
            type = "VARCHAR",
            description = "voice | video, from CallLog.Calls.FEATURES' FEATURES_VIDEO bit",
        ),
        AnalyticsColumn(
            name = "duration_seconds",
            type = "DOUBLE",
            description = "Call duration in seconds (0 for missed/rejected/blocked)",
        ),
        AnalyticsColumn(
            name = "connected",
            type = "BOOLEAN",
            description = "Whether the call actually connected (TYPE is incoming or outgoing, not missed/rejected/blocked)",
        ),
        AnalyticsColumn(
            name = "missed_reason",
            type = "INTEGER",
            description =
                "Raw CallLog.Calls.MISSED_REASON bitmask when call_type is missed (API 31+; see " +
                    "developer.android.com/reference/android/provider/CallLog.Calls#MISSED_REASON)",
            nullable = true,
        ),
        AnalyticsColumn(
            name = "counterparty",
            type = "VARCHAR",
            description = "Peer phone number, E.164-formatted when the device's country ISO allows it",
            references = "person",
        ),
        AnalyticsColumn(
            name = "counterparty_name",
            type = "VARCHAR",
            description = "Cached counterparty display name, if known",
            nullable = true,
        ),
    ),
    primaryKey = listOf("id"),
    semanticTimeColumn = "time",
    record = RecordDisplaySpec(
        titleColumns = listOf("counterparty_name", "counterparty"),
        keyColumns = listOf("time", "counterparty", "direction"),
    ),
    exampleQueries = listOf(
        "SELECT counterparty_name, counterparty, COUNT(*) AS calls, ROUND(SUM(duration_seconds) / 60, 1) AS minutes FROM android_call_log WHERE connected GROUP BY 1, 2 ORDER BY calls DESC LIMIT 20",
        "SELECT date_trunc('week', time) AS week, COUNT(*) FILTER (WHERE call_type = 'missed') AS missed_calls FROM android_call_log GROUP BY week ORDER BY week DESC",
    ),
)

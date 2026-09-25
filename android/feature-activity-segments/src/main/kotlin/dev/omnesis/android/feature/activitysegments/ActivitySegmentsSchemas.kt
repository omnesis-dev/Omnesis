// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import dev.omnesis.android.transport.dto.AnalyticsColumn
import dev.omnesis.android.transport.dto.AnalyticsTableSchema
import dev.omnesis.android.transport.dto.RecordDisplaySpec

/** DuckDB table for Android's GMS Activity Transition-derived movement segments. */
const val ANDROID_ACTIVITY_SEGMENTS_TABLE = "android_activity_segments"

val androidActivitySegmentsSchema = AnalyticsTableSchema(
    tableName = ANDROID_ACTIVITY_SEGMENTS_TABLE,
    displayName = "Android Activity Segments",
    description = "Movement segments (still, walking, running, cycling, driving) from Google " +
        "Play services' Activity Recognition transition updates.",
    columns = listOf(
        AnalyticsColumn(name = "id", type = "VARCHAR", description = "Unique segment id (activityType:startEpochMillis)"),
        AnalyticsColumn(
            name = "activity_type",
            type = "VARCHAR",
            description = "still | walking | running | on_bicycle | in_vehicle",
        ),
        AnalyticsColumn(name = "start_time", type = "TIMESTAMPTZ", description = "Segment start time (UTC)"),
        AnalyticsColumn(name = "end_time", type = "TIMESTAMPTZ", description = "Segment end time (UTC)"),
        AnalyticsColumn(name = "duration_seconds", type = "DOUBLE", description = "Segment duration in seconds"),
        AnalyticsColumn(
            name = "confidence",
            type = "VARCHAR",
            description = "high | medium | low — SYNTHESIZED from segment shape (duration + whether it closed " +
                "normally or was force-closed), not a value the Activity Transition Updates API itself reports",
        ),
        AnalyticsColumn(
            name = "truncated",
            type = "BOOLEAN",
            description = "True if this segment was force-closed after being open longer than the staleness " +
                "threshold, rather than closed by a real EXIT transition",
        ),
        AnalyticsColumn(name = "date", type = "DATE", description = "Calendar date (UTC) the segment started"),
    ),
    primaryKey = listOf("id"),
    semanticTimeColumn = "start_time",
    record = RecordDisplaySpec(
        titleColumns = listOf("activity_type"),
        keyColumns = listOf("activity_type", "start_time", "duration_seconds", "confidence"),
    ),
    exampleQueries = listOf(
        "SELECT activity_type, SUM(duration_seconds)/60.0 AS minutes FROM android_activity_segments WHERE date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY activity_type ORDER BY minutes DESC",
        "SELECT date, activity_type, COUNT(*) AS segments FROM android_activity_segments WHERE activity_type IN ('walking','running') GROUP BY date, activity_type ORDER BY date DESC LIMIT 30",
    ),
)

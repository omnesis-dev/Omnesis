// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import dev.omnesis.android.transport.dto.AnalyticsColumn
import dev.omnesis.android.transport.dto.AnalyticsTableSchema
import dev.omnesis.android.transport.dto.RecordDisplaySpec

/**
 * Health Connect analytics schemas — the DuckDB table shapes the `health-connect`
 * source ingests into via `POST /analytics/ingest`.
 *
 * This is the canonical definition for the real source. The TypeScript twin in
 * `packages/providers-synth/health-connect/src/schemas.ts` is the synthetic-corpus
 * transcription and the two are kept in lockstep column-for-column — a divergence
 * in table or column shape fails the structured E2E round-trip.
 *
 * Seven tables: four "tall" sample tables (one row per reading) plus three
 * session tables. Every schema's primary key is `["id"]`, so re-ingest is an
 * idempotent upsert and Changes-API deletions are applied by id (or by
 * `record_id`/`session_id` for fanned-out rows, see
 * [HealthTypeCatalog.deleteKeyColumnFor]).
 */
object HealthSchemas {
    private val recordingMethods = listOf(
        "actively_recorded",
        "automatically_recorded",
        "manually_entered",
        "unknown",
    )
    private val deviceTypes = listOf(
        "watch",
        "phone",
        "scale",
        "ring",
        "chest_strap",
        "fitness_band",
        "head_mounted",
        "smart_display",
        "unknown",
    )
    private val sleepStages = listOf(
        "awake",
        "sleeping",
        "out_of_bed",
        "light",
        "deep",
        "rem",
        "awake_in_bed",
        "unknown",
    )
    private val cycleTextValues = (
        listOf(
            "light", "medium", "heavy", "period", "bleeding", "positive", "high",
            "negative", "inconclusive", "protected", "unprotected", "unknown",
        ) + listOf("dry", "sticky", "creamy", "watery", "egg_white", "unusual", "unknown")
            .flatMap { appearance ->
                listOf("light", "medium", "heavy", "unknown")
                    .map { sensation -> "$appearance / $sensation" }
            }
        ).distinct().sorted()
    private val canonicalMindfulnessTypes = listOf(
        "meditation",
        "breathing",
        "music",
        "movement",
        "unguided",
        "unknown",
    )
    private val canonicalExerciseTypes =
        HealthNormalizer.exerciseTypeNames.values.distinct().sorted()
    private val metricAliasOverrides = mapOf(
        "resting_heart_rate" to listOf("resting heart rate"),
        "hrv" to listOf("heart rate variability", "hrv"),
        "blood_pressure_systolic" to listOf("systolic blood pressure"),
        "blood_pressure_diastolic" to listOf("diastolic blood pressure"),
        "oxygen_saturation" to listOf("blood oxygen", "oxygen saturation", "spo2"),
        "vo2_max" to listOf("vo2 max"),
    )
    private val sleepStageAliases = mapOf(
        "awake" to listOf("awake"),
        "sleeping" to listOf("sleeping"),
        "out_of_bed" to listOf("out of bed"),
        "light" to listOf("light sleep"),
        "deep" to listOf("deep sleep"),
        "rem" to listOf("rem sleep"),
        "awake_in_bed" to listOf("awake in bed"),
        "unknown" to listOf("unknown"),
    )
    private val mindfulnessAliases = canonicalMindfulnessTypes.associateWith(::humanizeSlug)
        .mapValues { (_, alias) -> listOf(alias) }
    private val exerciseAliases = canonicalExerciseTypes.associateWith { slug ->
        val overrides = when (slug) {
            "biking" -> listOf("bike ride", "biking", "cycling")
            "hiking" -> listOf("hike", "hiking")
            "hiit" -> listOf("high intensity interval training", "hiit")
            "rowing" -> listOf("row", "rowing")
            "running" -> listOf("run", "running")
            "running_treadmill" -> listOf("treadmill run", "treadmill running")
            "swimming_open_water" -> listOf("open water swimming")
            "swimming_pool" -> listOf("pool swimming")
            "walking" -> listOf("walk", "walking")
            else -> emptyList()
        }
        (listOf(humanizeSlug(slug)) + overrides).distinct().sorted()
    }

    private val fanOutMetricSlugs = mapOf(
        "hc_vitals" to listOf(
            "blood_pressure_systolic",
            "blood_pressure_diastolic",
            "skin_temperature_baseline",
            "skin_temperature_delta",
        ),
        "hc_nutrition" to listOf(
            "energy",
            "protein",
            "total_carbohydrate",
            "total_fat",
            "sugar",
            "dietary_fiber",
            "saturated_fat",
            "sodium",
            "cholesterol",
            "potassium",
            "caffeine",
        ),
    )

    private fun metricSlugsFor(tableName: String): List<String> =
        (
            HealthTypeCatalog.entries
                .filter { it.tableName == tableName }
                .mapNotNull { it.metricSlug } +
                (fanOutMetricSlugs[tableName] ?: emptyList())
            )
            .distinct()
            .sorted()

    private fun metricAliasesFor(tableName: String): Map<String, List<String>> {
        val catalogAliases = HealthTypeCatalog.entries
            .filter { it.tableName == tableName && it.metricSlug != null }
            .associate { it.metricSlug!! to humanizeCatalogName(it.name) }
        return metricSlugsFor(tableName).associateWith { slug ->
            (
                listOfNotNull(catalogAliases[slug], humanizeSlug(slug)) +
                    (metricAliasOverrides[slug] ?: emptyList())
                )
                .distinct()
                .sorted()
        }
    }

    private fun humanizeCatalogName(value: String): String =
        value.replace(Regex("([a-z0-9])([A-Z])"), "\$1 \$2").lowercase()

    private fun humanizeSlug(value: String): String = value.replace('_', ' ')

    /** Shared column core for the "tall" sample tables (activity/vitals/body/nutrition). */
    private fun hcSampleColumns(tableName: String): List<AnalyticsColumn> = listOf(
        AnalyticsColumn(
            name = "id",
            type = "VARCHAR",
            description = "Row id — the Health Connect record id, suffixed for rows fanned out " +
                "from one record (heart-rate samples, blood-pressure components, per-nutrient rows)",
        ),
        AnalyticsColumn(
            name = "record_id",
            type = "VARCHAR",
            description = "Parent Health Connect record id (metadata.id). Shared by all rows " +
                "fanned out from one record; the Changes-API deletion key",
        ),
        AnalyticsColumn(
            name = "client_record_id",
            type = "VARCHAR",
            description = "Writing app's own record id (metadata.clientRecordId)",
            nullable = true,
        ),
        AnalyticsColumn(
            name = "account_id",
            type = "VARCHAR",
            description = "Per-device identifier (android-<uuid>)",
        ),
        AnalyticsColumn(
            name = "metric",
            type = "VARCHAR",
            description = "Health Connect record type (e.g. HeartRate, Steps, Weight)",
        ),
        AnalyticsColumn(
            name = "metric_slug",
            type = "VARCHAR",
            description = "Machine-readable short name (e.g. heart_rate, steps)",
            allowedValues = metricSlugsFor(tableName),
            valueAliases = metricAliasesFor(tableName),
            categoricalRole = "series",
        ),
        AnalyticsColumn(
            name = "value",
            type = "DOUBLE",
            description = "Numeric reading in canonical unit",
            nullable = true,
        ),
        AnalyticsColumn(
            name = "unit",
            type = "VARCHAR",
            description = "Canonical unit (kg, bpm, m, ...)",
            nullable = true,
        ),
        AnalyticsColumn(
            name = "start_time",
            type = "TIMESTAMPTZ",
            description = "Record start time (UTC)",
        ),
        AnalyticsColumn(
            name = "end_time",
            type = "TIMESTAMPTZ",
            description = "Record end time (UTC); equals start_time for instantaneous records",
        ),
        AnalyticsColumn(
            name = "data_origin",
            type = "VARCHAR",
            description = "Package name of the writing app (metadata.dataOrigin.packageName)",
            nullable = true,
        ),
        AnalyticsColumn(
            name = "recording_method",
            type = "VARCHAR",
            description = "actively_recorded / automatically_recorded / manually_entered / unknown",
            nullable = true,
            allowedValues = recordingMethods,
        ),
        AnalyticsColumn(
            name = "device_type",
            type = "VARCHAR",
            description = "Originating device type (watch, phone, scale, ring, ...)",
            nullable = true,
            allowedValues = deviceTypes,
        ),
        AnalyticsColumn(
            name = "last_modified_time",
            type = "TIMESTAMPTZ",
            description = "metadata.lastModifiedTime (UTC)",
            nullable = true,
        ),
        AnalyticsColumn(
            name = "metadata",
            type = "JSON",
            description = "Extra Health Connect fields not otherwise mapped (reserved, currently null)",
            nullable = true,
        ),
    )

    /**
     * Record-citation display spec shared by the four "tall" sample tables:
     *one reading per row, titled by its metric and surfacing the
     * value/unit/time as key fields. The semantic time is always `start_time`.
     */
    private val hcSampleRecord = RecordDisplaySpec(
        titleColumns = listOf("metric_slug"),
        keyColumns = listOf("metric_slug", "value", "unit", "start_time"),
    )

    val HC_ACTIVITY = AnalyticsTableSchema(
        tableName = "hc_activity",
        displayName = "Activity & Movement",
        description = "Steps, distance, active/total calories, floors & elevation climbed, " +
            "VO2 max, wheelchair pushes, activity intensity.",
        columns = hcSampleColumns("hc_activity"),
        primaryKey = listOf("id"),
        deleteKey = HealthTypeCatalog.deleteKeyColumnFor("hc_activity")?.let(::listOf),
        exampleQueries = listOf(
            "SELECT date_trunc('day', start_time) AS day, SUM(value) AS steps FROM hc_activity " +
                "WHERE metric_slug = 'steps' GROUP BY day ORDER BY day DESC LIMIT 14",
            "SELECT date_trunc('day', start_time) AS day, SUM(value) AS active_kcal FROM hc_activity " +
                "WHERE metric_slug = 'active_calories' GROUP BY day ORDER BY day DESC LIMIT 14",
        ),
        semanticTimeColumn = "start_time",
        record = hcSampleRecord,
    )

    val HC_VITALS = AnalyticsTableSchema(
        tableName = "hc_vitals",
        displayName = "Vitals",
        description = "Heart rate, resting heart rate, HRV, blood pressure, SpO2, blood glucose, " +
            "body temperature, respiratory rate.",
        columns = hcSampleColumns("hc_vitals"),
        primaryKey = listOf("id"),
        deleteKey = HealthTypeCatalog.deleteKeyColumnFor("hc_vitals")?.let(::listOf),
        exampleQueries = listOf(
            "SELECT date_trunc('day', start_time) AS day, ROUND(AVG(value),0) AS avg_hr FROM hc_vitals " +
                "WHERE metric_slug = 'heart_rate' GROUP BY day ORDER BY day DESC LIMIT 30",
        ),
        semanticTimeColumn = "start_time",
        record = hcSampleRecord,
    )

    val HC_BODY = AnalyticsTableSchema(
        tableName = "hc_body",
        displayName = "Body Measurements",
        description = "Weight, height, body fat, lean mass, bone mass, body water mass, " +
            "basal metabolic rate.",
        columns = hcSampleColumns("hc_body"),
        primaryKey = listOf("id"),
        deleteKey = HealthTypeCatalog.deleteKeyColumnFor("hc_body")?.let(::listOf),
        exampleQueries = listOf(
            "SELECT start_time, value FROM hc_body WHERE metric_slug = 'weight' " +
                "ORDER BY start_time DESC LIMIT 30",
        ),
        semanticTimeColumn = "start_time",
        record = hcSampleRecord,
    )

    val HC_NUTRITION = AnalyticsTableSchema(
        tableName = "hc_nutrition",
        displayName = "Nutrition",
        description = "Per-nutrient intake (energy, macros, micros) and hydration, " +
            "one row per nutrient reading.",
        columns = hcSampleColumns("hc_nutrition"),
        primaryKey = listOf("id"),
        deleteKey = HealthTypeCatalog.deleteKeyColumnFor("hc_nutrition")?.let(::listOf),
        exampleQueries = listOf(
            "SELECT date_trunc('day', start_time) AS day, SUM(value) AS kcal FROM hc_nutrition " +
                "WHERE metric_slug = 'energy' GROUP BY day ORDER BY day DESC LIMIT 14",
        ),
        semanticTimeColumn = "start_time",
        record = hcSampleRecord,
    )

    val HC_SLEEP = AnalyticsTableSchema(
        tableName = "hc_sleep",
        displayName = "Sleep",
        description = "Sleep sessions broken into stages (one row per stage).",
        columns = listOf(
            AnalyticsColumn(
                name = "id",
                type = "VARCHAR",
                description = "Stage id (derived from session id + stage index)",
            ),
            AnalyticsColumn(
                name = "account_id",
                type = "VARCHAR",
                description = "Per-device identifier",
            ),
            AnalyticsColumn(
                name = "session_id",
                type = "VARCHAR",
                description = "Health Connect SleepSessionRecord id this stage belongs to",
            ),
            AnalyticsColumn(
                name = "stage",
                type = "VARCHAR",
                description = "awake / sleeping / out_of_bed / light / deep / rem / awake_in_bed / unknown",
                allowedValues = sleepStages,
                valueAliases = sleepStageAliases,
                categoricalRole = "selector",
            ),
            AnalyticsColumn(name = "start_time", type = "TIMESTAMPTZ", description = "Stage start (UTC)"),
            AnalyticsColumn(name = "end_time", type = "TIMESTAMPTZ", description = "Stage end (UTC)"),
            AnalyticsColumn(
                name = "data_origin",
                type = "VARCHAR",
                description = "Package name of the writing app",
                nullable = true,
            ),
            AnalyticsColumn(
                name = "recording_method",
                type = "VARCHAR",
                description = "actively_recorded / automatically_recorded / manually_entered / unknown",
                nullable = true,
                allowedValues = recordingMethods,
            ),
            AnalyticsColumn(
                name = "device_type",
                type = "VARCHAR",
                description = "Originating device type",
                nullable = true,
                allowedValues = deviceTypes,
            ),
            AnalyticsColumn(name = "metadata", type = "JSON", description = "Extra fields", nullable = true),
        ),
        primaryKey = listOf("id"),
        deleteKey = HealthTypeCatalog.deleteKeyColumnFor("hc_sleep")?.let(::listOf),
        exampleQueries = listOf(
            "SELECT date_trunc('day', start_time) AS night, " +
                "SUM(date_diff('minute', start_time, end_time))/60.0 AS hours FROM hc_sleep " +
                "WHERE stage IN ('light','deep','rem','sleeping') GROUP BY night ORDER BY night DESC LIMIT 14",
        ),
        semanticTimeColumn = "start_time",
        record = RecordDisplaySpec(
            titleColumns = listOf("stage"),
            keyColumns = listOf("stage", "start_time", "end_time"),
        ),
    )

    val HC_MINDFULNESS = AnalyticsTableSchema(
        tableName = "hc_mindfulness",
        displayName = "Mindfulness",
        description = "Mindfulness / meditation sessions.",
        columns = listOf(
            AnalyticsColumn(name = "id", type = "VARCHAR", description = "Health Connect record id"),
            AnalyticsColumn(
                name = "account_id",
                type = "VARCHAR",
                description = "Per-device identifier",
            ),
            AnalyticsColumn(
                name = "session_type",
                type = "VARCHAR",
                description = "meditation / breathing / music / movement / unguided / unknown",
                canonicalValues = canonicalMindfulnessTypes,
                valueAliases = mindfulnessAliases,
                categoricalRole = "selector",
            ),
            AnalyticsColumn(name = "title", type = "VARCHAR", description = "Session title", nullable = true),
            AnalyticsColumn(name = "start_time", type = "TIMESTAMPTZ", description = "Session start (UTC)"),
            AnalyticsColumn(name = "end_time", type = "TIMESTAMPTZ", description = "Session end (UTC)"),
            AnalyticsColumn(name = "duration_seconds", type = "INTEGER", description = "Session duration"),
            AnalyticsColumn(
                name = "data_origin",
                type = "VARCHAR",
                description = "Package name of the writing app",
                nullable = true,
            ),
            AnalyticsColumn(
                name = "recording_method",
                type = "VARCHAR",
                description = "actively_recorded / automatically_recorded / manually_entered / unknown",
                nullable = true,
                allowedValues = recordingMethods,
            ),
            AnalyticsColumn(
                name = "device_type",
                type = "VARCHAR",
                description = "Originating device type",
                nullable = true,
                allowedValues = deviceTypes,
            ),
            AnalyticsColumn(name = "metadata", type = "JSON", description = "Extra fields", nullable = true),
        ),
        primaryKey = listOf("id"),
        deleteKey = HealthTypeCatalog.deleteKeyColumnFor("hc_mindfulness")?.let(::listOf),
        semanticTimeColumn = "start_time",
        record = RecordDisplaySpec(
            titleColumns = listOf("title", "session_type"),
            titleTemplate = "{title}",
            keyColumns = listOf("session_type", "start_time", "end_time", "duration_seconds"),
        ),
    )

    val HC_EXERCISE = AnalyticsTableSchema(
        tableName = "hc_exercise",
        displayName = "Workouts",
        description = "Exercise sessions (runs, rides, swims, strength, ...). Distance and " +
            "calories for a session are recorded separately in hc_activity, Health Connect's " +
            "native model.",
        columns = listOf(
            AnalyticsColumn(
                name = "id",
                type = "VARCHAR",
                description = "Health Connect ExerciseSessionRecord id",
            ),
            AnalyticsColumn(
                name = "account_id",
                type = "VARCHAR",
                description = "Per-device identifier",
            ),
            AnalyticsColumn(
                name = "exercise_type",
                type = "VARCHAR",
                description = "running / biking / swimming_pool / strength_training / etc.",
                canonicalValues = canonicalExerciseTypes,
                valueAliases = exerciseAliases,
                categoricalRole = "selector",
            ),
            AnalyticsColumn(name = "title", type = "VARCHAR", description = "Session title", nullable = true),
            AnalyticsColumn(name = "notes", type = "VARCHAR", description = "Session notes", nullable = true),
            AnalyticsColumn(name = "start_time", type = "TIMESTAMPTZ", description = "Session start (UTC)"),
            AnalyticsColumn(name = "end_time", type = "TIMESTAMPTZ", description = "Session end (UTC)"),
            AnalyticsColumn(name = "duration_seconds", type = "INTEGER", description = "Duration"),
            AnalyticsColumn(
                name = "data_origin",
                type = "VARCHAR",
                description = "Package name of the writing app",
                nullable = true,
            ),
            AnalyticsColumn(
                name = "recording_method",
                type = "VARCHAR",
                description = "actively_recorded / automatically_recorded / manually_entered / unknown",
                nullable = true,
                allowedValues = recordingMethods,
            ),
            AnalyticsColumn(
                name = "device_type",
                type = "VARCHAR",
                description = "Originating device type",
                nullable = true,
                allowedValues = deviceTypes,
            ),
            AnalyticsColumn(name = "metadata", type = "JSON", description = "Extra fields", nullable = true),
        ),
        primaryKey = listOf("id"),
        deleteKey = HealthTypeCatalog.deleteKeyColumnFor("hc_exercise")?.let(::listOf),
        semanticTimeColumn = "start_time",
        record = RecordDisplaySpec(
            titleColumns = listOf("title", "exercise_type"),
            titleTemplate = "{title}",
            keyColumns = listOf("exercise_type", "start_time", "end_time", "duration_seconds"),
        ),
    )

    val HC_CYCLE = AnalyticsTableSchema(
        tableName = "hc_cycle",
        displayName = "Cycle Tracking",
        description = "Reproductive-health records: menstruation flow & periods, intermenstrual " +
            "bleeding, cervical mucus, ovulation tests, sexual activity. Categorical (no numeric " +
            "reading) — the category is in text_value.",
        columns = listOf(
            AnalyticsColumn(name = "id", type = "VARCHAR", description = "Health Connect record id"),
            AnalyticsColumn(
                name = "record_id",
                type = "VARCHAR",
                description = "Parent Health Connect record id (metadata.id); the Changes-API deletion key",
            ),
            AnalyticsColumn(name = "account_id", type = "VARCHAR", description = "Per-device identifier (android-<uuid>)"),
            AnalyticsColumn(
                name = "metric",
                type = "VARCHAR",
                description = "Health Connect record type (e.g. MenstruationFlow, OvulationTest)",
            ),
            AnalyticsColumn(
                name = "metric_slug",
                type = "VARCHAR",
                description = "Machine-readable short name (e.g. menstruation_flow, ovulation_test)",
                allowedValues = metricSlugsFor("hc_cycle"),
                valueAliases = metricAliasesFor("hc_cycle"),
                categoricalRole = "series",
            ),
            AnalyticsColumn(
                name = "text_value",
                type = "VARCHAR",
                description = "Categorical reading — flow level, mucus appearance/sensation, test " +
                    "result, protection used, or a period/bleeding marker",
                nullable = true,
                allowedValues = cycleTextValues,
                categoricalRole = "selector",
            ),
            AnalyticsColumn(
                name = "value",
                type = "DOUBLE",
                description = "Reserved for any numeric reading; null for these categorical records",
                nullable = true,
            ),
            AnalyticsColumn(name = "start_time", type = "TIMESTAMPTZ", description = "Record start time (UTC)"),
            AnalyticsColumn(
                name = "end_time",
                type = "TIMESTAMPTZ",
                description = "Record end time (UTC); equals start_time for instantaneous records",
            ),
            AnalyticsColumn(
                name = "data_origin",
                type = "VARCHAR",
                description = "Package name of the writing app (metadata.dataOrigin.packageName)",
                nullable = true,
            ),
            AnalyticsColumn(
                name = "recording_method",
                type = "VARCHAR",
                description = "actively_recorded / automatically_recorded / manually_entered / unknown",
                nullable = true,
                allowedValues = recordingMethods,
            ),
            AnalyticsColumn(
                name = "device_type",
                type = "VARCHAR",
                description = "Originating device type",
                nullable = true,
                allowedValues = deviceTypes,
            ),
            AnalyticsColumn(name = "metadata", type = "JSON", description = "Extra fields", nullable = true),
        ),
        primaryKey = listOf("id"),
        deleteKey = HealthTypeCatalog.deleteKeyColumnFor("hc_cycle")?.let(::listOf),
        exampleQueries = listOf(
            "SELECT date_trunc('day', start_time) AS day, text_value AS flow FROM hc_cycle " +
                "WHERE metric_slug = 'menstruation_flow' ORDER BY day DESC LIMIT 30",
        ),
        semanticTimeColumn = "start_time",
        record = RecordDisplaySpec(
            titleColumns = listOf("metric_slug"),
            keyColumns = listOf("metric_slug", "text_value", "start_time"),
        ),
    )

    /** All eight schemas in the order the synthetic twin declares them. */
    val ALL_SCHEMAS: List<AnalyticsTableSchema> = listOf(
        HC_BODY,
        HC_ACTIVITY,
        HC_VITALS,
        HC_SLEEP,
        HC_NUTRITION,
        HC_MINDFULNESS,
        HC_EXERCISE,
        HC_CYCLE,
    )

    fun forTable(tableName: String): AnalyticsTableSchema =
        ALL_SCHEMAS.first { it.tableName == tableName }
}

/**
 * Logical grouping that determines which DuckDB table a record lands in, and the
 * granularity of the user-facing category toggles in [HealthSettings]. 1:1 with
 * the `hc_*` tables.
 */
enum class HealthCategory(val tableName: String) {
    BODY("hc_body"),
    ACTIVITY("hc_activity"),
    VITALS("hc_vitals"),
    SLEEP("hc_sleep"),
    NUTRITION("hc_nutrition"),
    MINDFULNESS("hc_mindfulness"),
    EXERCISE("hc_exercise"),
    CYCLE("hc_cycle");

    companion object {
        fun fromTableName(tableName: String): HealthCategory? =
            entries.firstOrNull { it.tableName == tableName }
    }
}

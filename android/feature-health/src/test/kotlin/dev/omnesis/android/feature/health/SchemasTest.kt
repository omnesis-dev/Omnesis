// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import dev.omnesis.android.transport.dto.AnalyticsTableSchema
import dev.omnesis.android.transport.dto.OmnesisJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Locks the eight `hc_*` table shapes to the canonical contract mirrored in
 * `packages/providers-synth/health-connect/src/schemas.ts` — same table names,
 * same column names in the same order, same primary key. A drift here breaks
 * the synthetic-twin round-trip E2E.
 */
class SchemasTest {

    private val tallColumns = listOf(
        "id", "record_id", "client_record_id", "account_id", "metric", "metric_slug",
        "value", "unit", "start_time", "end_time", "data_origin", "recording_method",
        "device_type", "last_modified_time", "metadata",
    )

    @Test
    fun allSchemasAreTheEightTablesInCanonicalOrder() {
        assertEquals(
            listOf(
                "hc_body", "hc_activity", "hc_vitals", "hc_sleep",
                "hc_nutrition", "hc_mindfulness", "hc_exercise", "hc_cycle",
            ),
            HealthSchemas.ALL_SCHEMAS.map { it.tableName },
        )
    }

    @Test
    fun everyCatalogEntryTableHasASchema() {
        // Every record type the catalog reads must land in a declared table —
        // otherwise its rows have nowhere to ingest. Guards a new CatalogEntry
        // added without its hc_* schema.
        val tables = HealthSchemas.ALL_SCHEMAS.map { it.tableName }.toSet()
        for (entry in HealthTypeCatalog.entries) {
            assert(entry.tableName in tables) {
                "${entry.name} targets ${entry.tableName} which has no HealthSchemas entry"
            }
        }
    }

    @Test
    fun tallTablesShareTheSampleColumnCore() {
        for (schema in listOf(HealthSchemas.HC_BODY, HealthSchemas.HC_ACTIVITY, HealthSchemas.HC_VITALS, HealthSchemas.HC_NUTRITION)) {
            assertEquals(schema.tableName, tallColumns, schema.columns.map { it.name })
        }
    }

    @Test
    fun tallMetricDomainsComeFromTheTypeCatalogAndFanOutContract() {
        val metric = HealthSchemas.HC_VITALS.columns.single { it.name == "metric_slug" }
        val values = requireNotNull(metric.allowedValues)
        assert("heart_rate" in values)
        assert("respiratory_rate" in values)
        assert("blood_pressure_systolic" in values)
        assert("skin_temperature_delta" in values)
        assertEquals(values.sorted(), values)
        assertEquals(values.size, values.toSet().size)
        assertEquals("series", metric.categoricalRole)
        assert("heart rate variability" in requireNotNull(metric.valueAliases)["hrv"].orEmpty())
        assertEquals(values.toSet(), requireNotNull(metric.valueAliases).keys)
    }

    @Test
    fun sleepColumnsMatchCanonicalOrder() {
        assertEquals(
            listOf(
                "id", "account_id", "session_id", "stage", "start_time", "end_time",
                "data_origin", "recording_method", "device_type", "metadata",
            ),
            HealthSchemas.HC_SLEEP.columns.map { it.name },
        )
        val stage = HealthSchemas.HC_SLEEP.columns.single { it.name == "stage" }
        assertEquals(
            listOf("awake", "sleeping", "out_of_bed", "light", "deep", "rem", "awake_in_bed", "unknown"),
            stage.allowedValues,
        )
        assertEquals("selector", stage.categoricalRole)
        assert("deep sleep" in requireNotNull(stage.valueAliases)["deep"].orEmpty())
        val exercise = HealthSchemas.HC_EXERCISE.columns.single { it.name == "exercise_type" }
        assert("running" in requireNotNull(exercise.canonicalValues))
        assert("badminton" in requireNotNull(exercise.canonicalValues))
        assertEquals("selector", exercise.categoricalRole)
        assert("run" in requireNotNull(exercise.valueAliases)["running"].orEmpty())
    }

    @Test
    fun mindfulnessColumnsMatchCanonicalOrder() {
        assertEquals(
            listOf(
                "id", "account_id", "session_type", "title", "start_time", "end_time",
                "duration_seconds", "data_origin", "recording_method", "device_type", "metadata",
            ),
            HealthSchemas.HC_MINDFULNESS.columns.map { it.name },
        )
    }

    @Test
    fun exerciseColumnsMatchCanonicalOrder() {
        assertEquals(
            listOf(
                "id", "account_id", "exercise_type", "title", "notes", "start_time", "end_time",
                "duration_seconds", "data_origin", "recording_method", "device_type", "metadata",
            ),
            HealthSchemas.HC_EXERCISE.columns.map { it.name },
        )
    }

    @Test
    fun cycleMetricDomainComesFromTheTypeCatalog() {
        val metric = HealthSchemas.HC_CYCLE.columns.single { it.name == "metric_slug" }
        val expected = HealthTypeCatalog.entries
            .filter { it.tableName == "hc_cycle" }
            .mapNotNull { it.metricSlug }
            .distinct()
            .sorted()
        assertEquals(expected, metric.allowedValues)
        assertEquals("series", metric.categoricalRole)
        assert("ovulation test" in requireNotNull(metric.valueAliases)["ovulation_test"].orEmpty())
        val text = HealthSchemas.HC_CYCLE.columns.single { it.name == "text_value" }
        assertEquals("selector", text.categoricalRole)
        val textValues = requireNotNull(text.allowedValues)
        assert("negative" in textValues)
        assert("egg_white / heavy" in textValues)
    }

    @Test
    fun everyPrimaryKeyIsId() {
        for (schema in HealthSchemas.ALL_SCHEMAS) {
            assertEquals(schema.tableName, listOf("id"), schema.primaryKey)
        }
    }

    @Test
    fun nullabilityMatchesCanonicalContract() {
        val tall = HealthSchemas.HC_BODY.columns.associate { it.name to it.nullable }
        for (required in listOf("id", "record_id", "account_id", "metric", "metric_slug", "start_time", "end_time")) {
            assertNull(required, tall[required])
        }
        for (nullable in listOf(
            "client_record_id", "value", "unit", "data_origin", "recording_method",
            "device_type", "last_modified_time", "metadata",
        )) {
            assertEquals(nullable, true, tall[nullable])
        }
    }

    @Test
    fun vocabularyDescriptionsMatchTheCanonicalContract() {
        for (schema in listOf(HealthSchemas.HC_BODY, HealthSchemas.HC_ACTIVITY, HealthSchemas.HC_VITALS, HealthSchemas.HC_NUTRITION)) {
            assertEquals(
                schema.tableName,
                "Extra Health Connect fields not otherwise mapped (reserved, currently null)",
                schema.columns.single { it.name == "metadata" }.description,
            )
        }
        assertEquals(
            "awake / sleeping / out_of_bed / light / deep / rem / awake_in_bed / unknown",
            HealthSchemas.HC_SLEEP.columns.single { it.name == "stage" }.description,
        )
        assertEquals(
            "meditation / breathing / music / movement / unguided / unknown",
            HealthSchemas.HC_MINDFULNESS.columns.single { it.name == "session_type" }.description,
        )
        assertEquals(
            "Heart rate, resting heart rate, HRV, blood pressure, SpO2, blood glucose, " +
                "body temperature, respiratory rate.",
            HealthSchemas.HC_VITALS.description,
        )
    }

    @Test
    fun schemasSurviveJsonRoundTrip() {
        for (schema in HealthSchemas.ALL_SCHEMAS) {
            val json = OmnesisJson.encodeToString(AnalyticsTableSchema.serializer(), schema)
            val decoded = OmnesisJson.decodeFromString(AnalyticsTableSchema.serializer(), json)
            assertEquals(schema, decoded)
            if (schema.tableName == "hc_vitals") {
                assert(json.contains("\"valueAliases\""))
                assert(json.contains("\"categoricalRole\":\"series\""))
            }
        }
    }

    @Test
    fun categoricalMetadataStaysWithinGatewayProtocolBounds() {
        for (schema in HealthSchemas.ALL_SCHEMAS) {
            for (column in schema.columns) {
                for (values in listOfNotNull(column.allowedValues, column.canonicalValues)) {
                    assert(values.size in 1..128) { "${schema.tableName}.${column.name} vocabulary size" }
                    assertEquals(values.size, values.toSet().size)
                    assert(values.all { it.length in 1..120 })
                }
                val aliases = column.valueAliases ?: continue
                assert(aliases.size in 1..128) { "${schema.tableName}.${column.name} alias keys" }
                val vocabulary = (column.allowedValues.orEmpty() + column.canonicalValues.orEmpty()).toSet()
                assert(aliases.keys.all { it in vocabulary })
                for ((value, phrases) in aliases) {
                    assert(phrases.size in 1..8) { "${schema.tableName}.${column.name} aliases for $value" }
                    assertEquals(phrases.size, phrases.toSet().size)
                    assert(phrases.all { it.length in 1..120 })
                }
            }
        }
    }

    @Test
    fun everySchemaDeclaresStartTimeAsSemanticTime() {
        // The gateway places a record citation at this column on the timeline.
        //Every hc_* table is event-stamped by start_time. Omitting it
        // makes the table non-citation-eligible.
        for (schema in HealthSchemas.ALL_SCHEMAS) {
            assertEquals(schema.tableName, "start_time", schema.semanticTimeColumn)
        }
    }

    @Test
    fun everyRecordSpecIsNonEmptyAndReferencesRealColumns() {
        // Mirrors the gateway's validateRecordCitationContract: the record
        // display spec must be present, both column lists non-empty, and every
        // referenced column (incl. titleTemplate placeholders) must exist.
        for (schema in HealthSchemas.ALL_SCHEMAS) {
            val record = requireNotNull(schema.record) { "${schema.tableName} must declare a record spec" }
            val columns = schema.columns.map { it.name }.toSet()
            assert(record.titleColumns.isNotEmpty()) { "${schema.tableName} titleColumns empty" }
            assert(record.keyColumns.isNotEmpty()) { "${schema.tableName} keyColumns empty" }
            for (col in record.titleColumns + record.keyColumns) {
                assert(col in columns) { "${schema.tableName} record references missing column '$col'" }
            }
            val placeholders = Regex("\\{([^}]+)}").findAll(record.titleTemplate ?: "").map { it.groupValues[1] }
            for (p in placeholders) {
                assert(p in record.titleColumns) { "${schema.tableName} titleTemplate '{$p}' not in titleColumns" }
            }
        }
    }
}

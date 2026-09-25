// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@file:OptIn(ExperimentalMindfulnessSessionApi::class)

package dev.omnesis.android.feature.health

import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.CervicalMucusRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.MenstruationFlowRecord
import androidx.health.connect.client.records.MenstruationPeriodRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OvulationTestRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.SexualActivityRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.testing.populatedWithTestValues
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Pressure
import androidx.health.connect.client.units.Temperature
import androidx.health.connect.client.units.TemperatureDelta
import java.time.Instant
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * All fixture values are invented (generic readings, fictional package names) —
 * never sourced from a real corpus.
 */
class HealthNormalizerTest {

    private val accountId = "android-0f1e2d3c"
    private val origin = "com.example.fittracker"
    private val t0 = Instant.parse("2026-06-10T08:00:00Z")
    private val modified = Instant.parse("2026-06-10T08:15:00Z")

    private fun meta(id: String, device: Device? = null): Metadata {
        val base = if (device == null) Metadata.manualEntry() else Metadata.autoRecorded(device)
        return base.populatedWithTestValues(
            id = id,
            dataOrigin = DataOrigin(origin),
            lastModifiedTime = modified,
        )
    }

    @Test
    fun weightRecordProducesTheExactRow() {
        val record = WeightRecord(
            time = t0,
            zoneOffset = null,
            weight = Mass.kilograms(72.5),
            metadata = meta("rec-weight-1"),
        )

        val rows = HealthNormalizer.normalize(record, accountId)

        assertEquals(1, rows.size)
        assertEquals(
            mapOf(
                "id" to JsonPrimitive("rec-weight-1"),
                "record_id" to JsonPrimitive("rec-weight-1"),
                "client_record_id" to JsonNull,
                "account_id" to JsonPrimitive(accountId),
                "metric" to JsonPrimitive("Weight"),
                "metric_slug" to JsonPrimitive("weight"),
                "value" to JsonPrimitive(72.5),
                "unit" to JsonPrimitive("kg"),
                "start_time" to JsonPrimitive("2026-06-10T08:00:00.000Z"),
                "end_time" to JsonPrimitive("2026-06-10T08:00:00.000Z"),
                "data_origin" to JsonPrimitive(origin),
                "recording_method" to JsonPrimitive("manually_entered"),
                "device_type" to JsonNull,
                "last_modified_time" to JsonPrimitive("2026-06-10T08:15:00.000Z"),
                "metadata" to JsonNull,
            ),
            rows.single(),
        )
    }

    @Test
    fun stepsRecordUsesTheIntervalAndCountAsDouble() {
        val record = StepsRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(3600),
            endZoneOffset = null,
            count = 1200,
            metadata = meta("rec-steps-1"),
        )
        val row = HealthNormalizer.normalize(record, accountId).single()
        assertEquals(JsonPrimitive("steps"), row["metric_slug"])
        assertEquals(JsonPrimitive(1200.0), row["value"])
        assertEquals(JsonPrimitive("count"), row["unit"])
        assertEquals(JsonPrimitive("2026-06-10T08:00:00.000Z"), row["start_time"])
        assertEquals(JsonPrimitive("2026-06-10T09:00:00.000Z"), row["end_time"])
    }

    @Test
    fun heartRateFansOutOneRowPerSample() {
        val record = HeartRateRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(600),
            endZoneOffset = null,
            samples = listOf(
                HeartRateRecord.Sample(t0, 62),
                HeartRateRecord.Sample(t0.plusSeconds(120), 71),
                HeartRateRecord.Sample(t0.plusSeconds(300), 68),
            ),
            metadata = meta("rec-hr-1", device = Device(type = Device.TYPE_WATCH)),
        )

        val rows = HealthNormalizer.normalize(record, accountId)

        assertEquals(3, rows.size)
        assertEquals(
            listOf("rec-hr-1:0", "rec-hr-1:1", "rec-hr-1:2"),
            rows.map { (it["id"] as JsonPrimitive).content },
        )
        assertTrue(rows.all { it["record_id"] == JsonPrimitive("rec-hr-1") })
        assertEquals(
            listOf(62.0, 71.0, 68.0),
            rows.map { (it["value"] as JsonPrimitive).content.toDouble() },
        )
        assertTrue(rows.all { it["unit"] == JsonPrimitive("bpm") })
        assertTrue(rows.all { it["device_type"] == JsonPrimitive("watch") })
        assertTrue(rows.all { it["recording_method"] == JsonPrimitive("automatically_recorded") })
        // Each sample's instant becomes both start and end.
        assertEquals(JsonPrimitive("2026-06-10T08:02:00.000Z"), rows[1]["start_time"])
        assertEquals(JsonPrimitive("2026-06-10T08:02:00.000Z"), rows[1]["end_time"])
    }

    @Test
    fun bloodPressureFansOutSystolicAndDiastolic() {
        val record = BloodPressureRecord(
            time = t0,
            zoneOffset = null,
            metadata = meta("rec-bp-1"),
            systolic = Pressure.millimetersOfMercury(121.0),
            diastolic = Pressure.millimetersOfMercury(78.0),
        )

        val rows = HealthNormalizer.normalize(record, accountId)

        assertEquals(2, rows.size)
        val systolic = rows.first { it["id"] == JsonPrimitive("rec-bp-1:systolic") }
        val diastolic = rows.first { it["id"] == JsonPrimitive("rec-bp-1:diastolic") }
        assertEquals(JsonPrimitive("blood_pressure_systolic"), systolic["metric_slug"])
        assertEquals(JsonPrimitive(121.0), systolic["value"])
        assertEquals(JsonPrimitive("blood_pressure_diastolic"), diastolic["metric_slug"])
        assertEquals(JsonPrimitive(78.0), diastolic["value"])
        assertTrue(rows.all { it["metric"] == JsonPrimitive("BloodPressure") })
        assertTrue(rows.all { it["unit"] == JsonPrimitive("mmHg") })
        assertTrue(rows.all { it["record_id"] == JsonPrimitive("rec-bp-1") })
    }

    @Test
    fun nutritionEmitsOnlyNonNullNutrients() {
        val record = NutritionRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(1800),
            endZoneOffset = null,
            metadata = meta("rec-meal-1"),
            energy = Energy.kilocalories(650.0),
            protein = Mass.grams(32.0),
        )

        val rows = HealthNormalizer.normalize(record, accountId)

        assertEquals(2, rows.size)
        val energy = rows.first { it["id"] == JsonPrimitive("rec-meal-1:energy") }
        val protein = rows.first { it["id"] == JsonPrimitive("rec-meal-1:protein") }
        assertEquals(JsonPrimitive("Nutrition.energy"), energy["metric"])
        assertEquals(JsonPrimitive("energy"), energy["metric_slug"])
        assertEquals(JsonPrimitive(650.0), energy["value"])
        assertEquals(JsonPrimitive("kcal"), energy["unit"])
        assertEquals(JsonPrimitive("Nutrition.protein"), protein["metric"])
        assertEquals(JsonPrimitive(32.0), protein["value"])
        assertEquals(JsonPrimitive("g"), protein["unit"])
    }

    @Test
    fun sleepSessionEmitsOneRowPerStageWithSessionId() {
        val start = Instant.parse("2026-06-09T22:30:00Z")
        val record = SleepSessionRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(4 * 3600),
            endZoneOffset = null,
            metadata = meta("rec-sleep-1"),
            stages = listOf(
                SleepSessionRecord.Stage(start, start.plusSeconds(1800), SleepSessionRecord.STAGE_TYPE_LIGHT),
                SleepSessionRecord.Stage(start.plusSeconds(1800), start.plusSeconds(5400), SleepSessionRecord.STAGE_TYPE_DEEP),
                SleepSessionRecord.Stage(start.plusSeconds(5400), start.plusSeconds(7200), SleepSessionRecord.STAGE_TYPE_REM),
                SleepSessionRecord.Stage(start.plusSeconds(7200), start.plusSeconds(4 * 3600), SleepSessionRecord.STAGE_TYPE_AWAKE),
            ),
        )

        val rows = HealthNormalizer.normalize(record, accountId)

        assertEquals(4, rows.size)
        assertEquals(
            listOf("rec-sleep-1:0", "rec-sleep-1:1", "rec-sleep-1:2", "rec-sleep-1:3"),
            rows.map { (it["id"] as JsonPrimitive).content },
        )
        assertTrue(rows.all { it["session_id"] == JsonPrimitive("rec-sleep-1") })
        assertEquals(
            listOf("light", "deep", "rem", "awake"),
            rows.map { (it["stage"] as JsonPrimitive).content },
        )
        assertEquals(JsonPrimitive("2026-06-09T23:00:00.000Z"), rows[1]["start_time"])
    }

    @Test
    fun stagelessSleepSessionStillEmitsOneUnknownRow() {
        val start = Instant.parse("2026-06-09T23:00:00Z")
        val record = SleepSessionRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(7 * 3600),
            endZoneOffset = null,
            metadata = meta("rec-sleep-2"),
        )
        val rows = HealthNormalizer.normalize(record, accountId)
        assertEquals(1, rows.size)
        assertEquals(JsonPrimitive("rec-sleep-2:0"), rows[0]["id"])
        assertEquals(JsonPrimitive("unknown"), rows[0]["stage"])
        assertEquals(JsonPrimitive("2026-06-09T23:00:00.000Z"), rows[0]["start_time"])
        assertEquals(JsonPrimitive("2026-06-10T06:00:00.000Z"), rows[0]["end_time"])
    }

    @Test
    fun mindfulnessSessionMapsTypeAndDuration() {
        val record = MindfulnessSessionRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(900),
            endZoneOffset = null,
            metadata = meta("rec-mind-1"),
            mindfulnessSessionType = MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_MEDITATION,
            title = "Morning meditation",
        )

        val row = HealthNormalizer.normalize(record, accountId).single()

        assertEquals(JsonPrimitive("rec-mind-1"), row["id"])
        assertEquals(JsonPrimitive("meditation"), row["session_type"])
        assertEquals(JsonPrimitive("Morning meditation"), row["title"])
        assertEquals(JsonPrimitive(900), row["duration_seconds"])
        assertEquals(JsonNull, row["metadata"])
    }

    @Test
    fun exerciseSessionMapsTypeTitleNotesAndDuration() {
        val record = ExerciseSessionRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(2700),
            endZoneOffset = null,
            metadata = meta("rec-run-1"),
            exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
            title = "Riverside loop",
            notes = "Easy pace",
        )

        val row = HealthNormalizer.normalize(record, accountId).single()

        assertEquals(JsonPrimitive("rec-run-1"), row["id"])
        assertEquals(JsonPrimitive("running"), row["exercise_type"])
        assertEquals(JsonPrimitive("Riverside loop"), row["title"])
        assertEquals(JsonPrimitive("Easy pace"), row["notes"])
        assertEquals(JsonPrimitive(2700), row["duration_seconds"])
        assertEquals(JsonPrimitive("2026-06-10T08:45:00.000Z"), row["end_time"])
    }

    @Test
    fun commonExerciseTypesMapToStableNames() {
        val expectations = mapOf(
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING to "biking",
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL to "swimming_pool",
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER to "swimming_open_water",
            ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING to "strength_training",
            ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING to "hiit",
            ExerciseSessionRecord.EXERCISE_TYPE_YOGA to "yoga",
            ExerciseSessionRecord.EXERCISE_TYPE_WALKING to "walking",
            ExerciseSessionRecord.EXERCISE_TYPE_HIKING to "hiking",
            ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL to "elliptical",
            ExerciseSessionRecord.EXERCISE_TYPE_ROWING to "rowing",
        )
        for ((type, expected) in expectations) {
            val record = ExerciseSessionRecord(
                startTime = t0,
                startZoneOffset = null,
                endTime = t0.plusSeconds(600),
                endZoneOffset = null,
                metadata = meta("rec-ex-$type"),
                exerciseType = type,
            )
            val row = HealthNormalizer.normalize(record, accountId).single()
            assertEquals(JsonPrimitive(expected), row["exercise_type"])
        }
    }

    @Test
    fun unknownExerciseTypeFallsBackToNumberedName() {
        val record = ExerciseSessionRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(600),
            endZoneOffset = null,
            metadata = meta("rec-ex-future"),
            exerciseType = 9999,
        )
        val row = HealthNormalizer.normalize(record, accountId).single()
        assertEquals(JsonPrimitive("exercise_9999"), row["exercise_type"])
    }

    @Test
    fun nullableColumnsSerializeAsExplicitJsonNull() {
        val record = ExerciseSessionRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(600),
            endZoneOffset = null,
            metadata = meta("rec-ex-bare"),
            exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_WALKING,
        )
        val row = HealthNormalizer.normalize(record, accountId).single()
        assertEquals(JsonNull, row["title"])
        assertEquals(JsonNull, row["notes"])
        assertEquals(JsonNull, row["device_type"])
        assertEquals(JsonNull, row["metadata"])
    }

    // ── Full-coverage record types ────────────────────────────────────

    @Test
    fun basalBodyTemperatureProducesACelsiusRow() {
        val record = BasalBodyTemperatureRecord(
            time = t0,
            zoneOffset = null,
            metadata = meta("rec-bbt"),
            temperature = Temperature.celsius(36.6),
        )
        val row = HealthNormalizer.normalize(record, accountId).single()
        assertEquals(JsonPrimitive("basal_body_temperature"), row["metric_slug"])
        assertEquals(JsonPrimitive(36.6), row["value"])
        assertEquals(JsonPrimitive("°C"), row["unit"])
    }

    @Test
    fun powerSeriesFansOutOneRowPerSample() {
        val record = PowerRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(120),
            endZoneOffset = null,
            samples = listOf(
                PowerRecord.Sample(t0, Power.watts(180.0)),
                PowerRecord.Sample(t0.plusSeconds(60), Power.watts(210.0)),
            ),
            metadata = meta("rec-power"),
        )
        val rows = HealthNormalizer.normalize(record, accountId)
        assertEquals(2, rows.size)
        assertEquals(JsonPrimitive("power"), rows[0]["metric_slug"])
        assertEquals(JsonPrimitive(180.0), rows[0]["value"])
        assertEquals(JsonPrimitive("rec-power:0"), rows[0]["id"])
        assertEquals(JsonPrimitive("rec-power"), rows[0]["record_id"])
        assertEquals(JsonPrimitive(210.0), rows[1]["value"])
    }

    @Test
    fun skinTemperatureEmitsBaselinePlusDeltaRows() {
        val record = SkinTemperatureRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(120),
            endZoneOffset = null,
            metadata = meta("rec-skin"),
            deltas = listOf(
                SkinTemperatureRecord.Delta(t0, TemperatureDelta.celsius(0.2)),
                SkinTemperatureRecord.Delta(t0.plusSeconds(60), TemperatureDelta.celsius(-0.1)),
            ),
            baseline = Temperature.celsius(33.0),
        )
        val rows = HealthNormalizer.normalize(record, accountId)
        assertEquals(3, rows.size)
        assertEquals(JsonPrimitive("skin_temperature_baseline"), rows[0]["metric_slug"])
        assertEquals(JsonPrimitive(33.0), rows[0]["value"])
        assertEquals(JsonPrimitive("skin_temperature_delta"), rows[1]["metric_slug"])
        assertEquals(JsonPrimitive(0.2), rows[1]["value"])
    }

    @Test
    fun menstruationFlowProducesACycleRowWithTextValue() {
        val record = MenstruationFlowRecord(
            time = t0,
            zoneOffset = null,
            flow = MenstruationFlowRecord.FLOW_MEDIUM,
            metadata = meta("rec-flow"),
        )
        val row = HealthNormalizer.normalize(record, accountId).single()
        assertEquals(JsonPrimitive("menstruation_flow"), row["metric_slug"])
        assertEquals(JsonPrimitive("medium"), row["text_value"])
        assertEquals(JsonNull, row["value"])
        assertEquals(JsonPrimitive("rec-flow"), row["id"])
    }

    @Test
    fun menstruationPeriodIsAnInterval() {
        val record = MenstruationPeriodRecord(
            startTime = t0,
            startZoneOffset = null,
            endTime = t0.plusSeconds(4 * 24 * 3600),
            endZoneOffset = null,
            metadata = meta("rec-period"),
        )
        val row = HealthNormalizer.normalize(record, accountId).single()
        assertEquals(JsonPrimitive("menstruation_period"), row["metric_slug"])
        assertEquals(JsonPrimitive("period"), row["text_value"])
    }

    @Test
    fun cervicalMucusCombinesAppearanceAndSensation() {
        val record = CervicalMucusRecord(
            time = t0,
            zoneOffset = null,
            appearance = CervicalMucusRecord.APPEARANCE_EGG_WHITE,
            sensation = CervicalMucusRecord.SENSATION_HEAVY,
            metadata = meta("rec-cm"),
        )
        val row = HealthNormalizer.normalize(record, accountId).single()
        assertEquals(JsonPrimitive("egg_white / heavy"), row["text_value"])
    }

    @Test
    fun ovulationAndSexualActivityMapTheirEnums() {
        val ovulation = OvulationTestRecord(
            time = t0,
            zoneOffset = null,
            result = OvulationTestRecord.RESULT_POSITIVE,
            metadata = meta("rec-ov"),
        )
        assertEquals(
            JsonPrimitive("positive"),
            HealthNormalizer.normalize(ovulation, accountId).single()["text_value"],
        )

        val sexual = SexualActivityRecord(
            time = t0,
            zoneOffset = null,
            protectionUsed = SexualActivityRecord.PROTECTION_USED_PROTECTED,
            metadata = meta("rec-sa"),
        )
        assertEquals(
            JsonPrimitive("protected"),
            HealthNormalizer.normalize(sexual, accountId).single()["text_value"],
        )
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@file:OptIn(ExperimentalMindfulnessSessionApi::class)

package dev.omnesis.android.feature.health

import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.BoneMassRecord
import androidx.health.connect.client.records.CervicalMucusRecord
import androidx.health.connect.client.records.CyclingPedalingCadenceRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.IntermenstrualBleedingRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.MenstruationFlowRecord
import androidx.health.connect.client.records.MenstruationPeriodRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OvulationTestRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.PlannedExerciseSessionRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SexualActivityRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.StepsCadenceRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.WheelchairPushesRecord
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/**
 * Pure record → row mapper: turns one Health Connect [Record] into the
 * `[Map<String, JsonElement>]` rows the gateway's `/analytics/ingest` expects,
 * matching the table shapes in [HealthSchemas].
 *
 * Row-id derivation is the deletion-correctness contract: every row id is the
 * Health Connect record id (`metadata.id`), suffixed when one record fans out
 * into several rows (`:<sampleIdx>` for heart-rate samples and sleep stages,
 * `:systolic`/`:diastolic` for blood pressure, `:<nutrient_slug>` for nutrition).
 * Fanned-out rows carry the bare record id in `record_id` (`session_id` for
 * sleep), which is what Changes-API tombstones are matched against.
 *
 * Times are emitted as ISO-8601 UTC with milliseconds (TIMESTAMPTZ on the wire);
 * zone offsets are ignored — Health Connect instants are already UTC.
 */
object HealthNormalizer {

    fun normalize(record: Record, accountId: String): List<Map<String, JsonElement>> = when (record) {
        is WeightRecord -> single(record, accountId, record.weight.inKilograms, record.time, record.time)
        is HeightRecord -> single(record, accountId, record.height.inMeters, record.time, record.time)
        is BodyFatRecord -> single(record, accountId, record.percentage.value, record.time, record.time)
        is LeanBodyMassRecord -> single(record, accountId, record.mass.inKilograms, record.time, record.time)
        is BoneMassRecord -> single(record, accountId, record.mass.inKilograms, record.time, record.time)
        is BodyWaterMassRecord -> single(record, accountId, record.mass.inKilograms, record.time, record.time)
        is BasalMetabolicRateRecord -> single(record, accountId, record.basalMetabolicRate.inKilocaloriesPerDay, record.time, record.time)
        is StepsRecord -> single(record, accountId, record.count.toDouble(), record.startTime, record.endTime)
        is DistanceRecord -> single(record, accountId, record.distance.inMeters, record.startTime, record.endTime)
        is ActiveCaloriesBurnedRecord -> single(record, accountId, record.energy.inKilocalories, record.startTime, record.endTime)
        is TotalCaloriesBurnedRecord -> single(record, accountId, record.energy.inKilocalories, record.startTime, record.endTime)
        is FloorsClimbedRecord -> single(record, accountId, record.floors, record.startTime, record.endTime)
        is ElevationGainedRecord -> single(record, accountId, record.elevation.inMeters, record.startTime, record.endTime)
        is Vo2MaxRecord -> single(record, accountId, record.vo2MillilitersPerMinuteKilogram, record.time, record.time)
        is WheelchairPushesRecord -> single(record, accountId, record.count.toDouble(), record.startTime, record.endTime)
        is RestingHeartRateRecord -> single(record, accountId, record.beatsPerMinute.toDouble(), record.time, record.time)
        is HeartRateVariabilityRmssdRecord -> single(record, accountId, record.heartRateVariabilityMillis, record.time, record.time)
        is OxygenSaturationRecord -> single(record, accountId, record.percentage.value, record.time, record.time)
        is BloodGlucoseRecord -> single(record, accountId, record.level.inMillimolesPerLiter, record.time, record.time)
        is BodyTemperatureRecord -> single(record, accountId, record.temperature.inCelsius, record.time, record.time)
        is RespiratoryRateRecord -> single(record, accountId, record.rate, record.time, record.time)
        is HydrationRecord -> single(record, accountId, record.volume.inMilliliters, record.startTime, record.endTime)
        is BasalBodyTemperatureRecord -> single(record, accountId, record.temperature.inCelsius, record.time, record.time)
        is HeartRateRecord -> heartRate(record, accountId)
        is PowerRecord -> series(record, accountId, "Power", "power", "W", record.samples.map { it.time to it.power.inWatts })
        is SpeedRecord -> series(record, accountId, "Speed", "speed", "m/s", record.samples.map { it.time to it.speed.inMetersPerSecond })
        is StepsCadenceRecord -> series(record, accountId, "StepsCadence", "steps_cadence", "rpm", record.samples.map { it.time to it.rate })
        is CyclingPedalingCadenceRecord ->
            series(record, accountId, "CyclingPedalingCadence", "cycling_pedaling_cadence", "rpm", record.samples.map { it.time to it.revolutionsPerMinute })
        is SkinTemperatureRecord -> skinTemperature(record, accountId)
        is BloodPressureRecord -> bloodPressure(record, accountId)
        is NutritionRecord -> nutrition(record, accountId)
        is SleepSessionRecord -> sleep(record, accountId)
        is MindfulnessSessionRecord -> mindfulness(record, accountId)
        is ExerciseSessionRecord -> exercise(record, accountId)
        is PlannedExerciseSessionRecord -> plannedExercise(record, accountId)
        is MenstruationFlowRecord -> cycle(record, accountId, menstruationFlowName(record.flow), record.time, record.time)
        is MenstruationPeriodRecord -> cycle(record, accountId, "period", record.startTime, record.endTime)
        is IntermenstrualBleedingRecord -> cycle(record, accountId, "bleeding", record.time, record.time)
        is CervicalMucusRecord ->
            cycle(record, accountId, cervicalMucusName(record.appearance, record.sensation), record.time, record.time)
        is OvulationTestRecord -> cycle(record, accountId, ovulationResultName(record.result), record.time, record.time)
        is SexualActivityRecord -> cycle(record, accountId, sexualProtectionName(record.protectionUsed), record.time, record.time)
        else -> emptyList()
    }

    // ── Tall-table shapes ─────────────────────────────────────────────

    /**
     * One row whose id IS the record id — the entry's metric/slug/unit apply
     * directly. Instantaneous records pass their single timestamp as both start
     * and end.
     */
    private fun single(
        record: Record,
        accountId: String,
        value: Double,
        start: Instant,
        end: Instant,
    ): List<Map<String, JsonElement>> {
        val entry = HealthTypeCatalog.byRecordType.getValue(record::class)
        return listOf(
            sampleRow(
                id = record.metadata.id,
                metadata = record.metadata,
                accountId = accountId,
                metric = entry.metric ?: entry.name,
                metricSlug = entry.metricSlug ?: entry.name,
                value = value,
                unit = entry.unit,
                start = start,
                end = end,
            ),
        )
    }

    /** One row per sample, id `<recordId>:<idx>`, sample time as both start and end. */
    private fun heartRate(record: HeartRateRecord, accountId: String): List<Map<String, JsonElement>> =
        record.samples.mapIndexed { idx, sample ->
            sampleRow(
                id = "${record.metadata.id}:$idx",
                metadata = record.metadata,
                accountId = accountId,
                metric = "HeartRate",
                metricSlug = "heart_rate",
                value = sample.beatsPerMinute.toDouble(),
                unit = "bpm",
                start = sample.time,
                end = sample.time,
            )
        }

    /**
     * Generic [SeriesRecord] fan-out (power, speed, cadence): one row per sample,
     * id `<recordId>:<idx>`, the sample value under the entry's metric/slug/unit.
     */
    private fun series(
        record: Record,
        accountId: String,
        metric: String,
        metricSlug: String,
        unit: String,
        samples: List<Pair<Instant, Double>>,
    ): List<Map<String, JsonElement>> =
        samples.mapIndexed { idx, (time, value) ->
            sampleRow(
                id = "${record.metadata.id}:$idx",
                metadata = record.metadata,
                accountId = accountId,
                metric = metric,
                metricSlug = metricSlug,
                value = value,
                unit = unit,
                start = time,
                end = time,
            )
        }

    /**
     * Skin temperature is a baseline absolute temperature plus per-time deltas.
     * Emits an optional `skin_temperature_baseline` row (the absolute °C, if the
     * record carries one) plus one `skin_temperature_delta` row per delta sample
     * (the °C offset from baseline). All rows share `record_id` for tombstoning.
     */
    private fun skinTemperature(record: SkinTemperatureRecord, accountId: String): List<Map<String, JsonElement>> {
        val rows = mutableListOf<Map<String, JsonElement>>()
        record.baseline?.let { baseline ->
            rows += sampleRow(
                id = "${record.metadata.id}:baseline",
                metadata = record.metadata,
                accountId = accountId,
                metric = "SkinTemperature",
                metricSlug = "skin_temperature_baseline",
                value = baseline.inCelsius,
                unit = "°C",
                start = record.startTime,
                end = record.startTime,
            )
        }
        record.deltas.forEachIndexed { idx, delta ->
            rows += sampleRow(
                id = "${record.metadata.id}:$idx",
                metadata = record.metadata,
                accountId = accountId,
                metric = "SkinTemperature",
                metricSlug = "skin_temperature_delta",
                value = delta.delta.inCelsius,
                unit = "°C",
                start = delta.time,
                end = delta.time,
            )
        }
        return rows
    }

    /** Two rows, `:systolic` and `:diastolic`, both in mmHg. */
    private fun bloodPressure(record: BloodPressureRecord, accountId: String): List<Map<String, JsonElement>> {
        val start = record.time
        val end = record.time
        fun component(suffix: String, slug: String, value: Double) = sampleRow(
            id = "${record.metadata.id}:$suffix",
            metadata = record.metadata,
            accountId = accountId,
            metric = "BloodPressure",
            metricSlug = slug,
            value = value,
            unit = "mmHg",
            start = start,
            end = end,
        )
        return listOf(
            component("systolic", "blood_pressure_systolic", record.systolic.inMillimetersOfMercury),
            component("diastolic", "blood_pressure_diastolic", record.diastolic.inMillimetersOfMercury),
        )
    }

    /** One row per non-null nutrient, id `<recordId>:<slug>`, metric `Nutrition.<field>`. */
    private fun nutrition(record: NutritionRecord, accountId: String): List<Map<String, JsonElement>> {
        val start = record.startTime
        val end = record.endTime
        val nutrients: List<Triple<String, String, Pair<Double, String>?>> = listOf(
            Triple("energy", "energy", record.energy?.let { it.inKilocalories to "kcal" }),
            Triple("protein", "protein", record.protein?.let { it.inGrams to "g" }),
            Triple("totalCarbohydrate", "total_carbohydrate", record.totalCarbohydrate?.let { it.inGrams to "g" }),
            Triple("totalFat", "total_fat", record.totalFat?.let { it.inGrams to "g" }),
            Triple("sugar", "sugar", record.sugar?.let { it.inGrams to "g" }),
            Triple("dietaryFiber", "dietary_fiber", record.dietaryFiber?.let { it.inGrams to "g" }),
            Triple("saturatedFat", "saturated_fat", record.saturatedFat?.let { it.inGrams to "g" }),
            Triple("sodium", "sodium", record.sodium?.let { it.inMilligrams to "mg" }),
            Triple("cholesterol", "cholesterol", record.cholesterol?.let { it.inMilligrams to "mg" }),
            Triple("potassium", "potassium", record.potassium?.let { it.inMilligrams to "mg" }),
            Triple("caffeine", "caffeine", record.caffeine?.let { it.inMilligrams to "mg" }),
        )
        return nutrients.mapNotNull { (field, slug, valueAndUnit) ->
            valueAndUnit?.let { (value, unit) ->
                sampleRow(
                    id = "${record.metadata.id}:$slug",
                    metadata = record.metadata,
                    accountId = accountId,
                    metric = "Nutrition.$field",
                    metricSlug = slug,
                    value = value,
                    unit = unit,
                    start = start,
                    end = end,
                )
            }
        }
    }

    private fun sampleRow(
        id: String,
        metadata: Metadata,
        accountId: String,
        metric: String,
        metricSlug: String,
        value: Double,
        unit: String?,
        start: Instant,
        end: Instant,
    ): Map<String, JsonElement> = linkedMapOf(
        "id" to JsonPrimitive(id),
        "record_id" to JsonPrimitive(metadata.id),
        "client_record_id" to nullableString(metadata.clientRecordId),
        "account_id" to JsonPrimitive(accountId),
        "metric" to JsonPrimitive(metric),
        "metric_slug" to JsonPrimitive(metricSlug),
        "value" to JsonPrimitive(value),
        "unit" to nullableString(unit),
        "start_time" to JsonPrimitive(iso(start)),
        "end_time" to JsonPrimitive(iso(end)),
        "data_origin" to dataOrigin(metadata),
        "recording_method" to JsonPrimitive(recordingMethod(metadata)),
        "device_type" to deviceType(metadata),
        "last_modified_time" to JsonPrimitive(iso(metadata.lastModifiedTime)),
        "metadata" to JsonNull,
    )

    // ── Session shapes ────────────────────────────────────────────────

    /**
     * One row per stage, id `<sessionId>:<stageIdx>`, sharing `session_id`.
     * A session without stage data still yields one `unknown` row spanning the
     * whole session so it doesn't vanish from the table.
     */
    private fun sleep(record: SleepSessionRecord, accountId: String): List<Map<String, JsonElement>> {
        val stages = record.stages.ifEmpty {
            listOf(SleepSessionRecord.Stage(record.startTime, record.endTime, SleepSessionRecord.STAGE_TYPE_UNKNOWN))
        }
        return stages.mapIndexed { idx, stage ->
            linkedMapOf(
                "id" to JsonPrimitive("${record.metadata.id}:$idx"),
                "account_id" to JsonPrimitive(accountId),
                "session_id" to JsonPrimitive(record.metadata.id),
                "stage" to JsonPrimitive(sleepStageName(stage.stage)),
                "start_time" to JsonPrimitive(iso(stage.startTime)),
                "end_time" to JsonPrimitive(iso(stage.endTime)),
                "data_origin" to dataOrigin(record.metadata),
                "recording_method" to JsonPrimitive(recordingMethod(record.metadata)),
                "device_type" to deviceType(record.metadata),
                "metadata" to JsonNull,
            )
        }
    }

    private fun mindfulness(record: MindfulnessSessionRecord, accountId: String): List<Map<String, JsonElement>> =
        listOf(
            linkedMapOf(
                "id" to JsonPrimitive(record.metadata.id),
                "account_id" to JsonPrimitive(accountId),
                "session_type" to JsonPrimitive(mindfulnessTypeName(record.mindfulnessSessionType)),
                "title" to nullableString(record.title),
                "start_time" to JsonPrimitive(iso(record.startTime)),
                "end_time" to JsonPrimitive(iso(record.endTime)),
                "duration_seconds" to JsonPrimitive(Duration.between(record.startTime, record.endTime).seconds),
                "data_origin" to dataOrigin(record.metadata),
                "recording_method" to JsonPrimitive(recordingMethod(record.metadata)),
                "device_type" to deviceType(record.metadata),
                "metadata" to JsonNull,
            ),
        )

    private fun exercise(record: ExerciseSessionRecord, accountId: String): List<Map<String, JsonElement>> =
        listOf(exerciseRow(record.metadata, accountId, exerciseTypeName(record.exerciseType), record.title, record.notes, record.startTime, record.endTime))

    /**
     * A planned workout (a future/template session) lands in the same hc_exercise
     * table as a completed one; its `exercise_type` is prefixed `planned:` so the
     * two are distinguishable without a separate table.
     */
    private fun plannedExercise(record: PlannedExerciseSessionRecord, accountId: String): List<Map<String, JsonElement>> =
        listOf(
            exerciseRow(
                record.metadata,
                accountId,
                "planned:${exerciseTypeName(record.exerciseType)}",
                record.title,
                record.notes,
                record.startTime,
                record.endTime,
            ),
        )

    private fun exerciseRow(
        metadata: Metadata,
        accountId: String,
        exerciseType: String,
        title: String?,
        notes: String?,
        start: Instant,
        end: Instant,
    ): Map<String, JsonElement> = linkedMapOf(
        "id" to JsonPrimitive(metadata.id),
        "account_id" to JsonPrimitive(accountId),
        "exercise_type" to JsonPrimitive(exerciseType),
        "title" to nullableString(title),
        "notes" to nullableString(notes),
        "start_time" to JsonPrimitive(iso(start)),
        "end_time" to JsonPrimitive(iso(end)),
        "duration_seconds" to JsonPrimitive(Duration.between(start, end).seconds),
        "data_origin" to dataOrigin(metadata),
        "recording_method" to JsonPrimitive(recordingMethod(metadata)),
        "device_type" to deviceType(metadata),
        "metadata" to JsonNull,
    )

    /**
     * One hc_cycle row for a categorical reproductive-health record. The category
     * (flow level, mucus appearance, test result, …) goes in `text_value`; these
     * records carry no numeric reading, so `value` is null. The row id IS the
     * record id (one row per record, tombstoned by primary key).
     */
    private fun cycle(
        record: Record,
        accountId: String,
        textValue: String,
        start: Instant,
        end: Instant,
    ): List<Map<String, JsonElement>> {
        val entry = HealthTypeCatalog.byRecordType.getValue(record::class)
        return listOf(
            linkedMapOf(
                "id" to JsonPrimitive(record.metadata.id),
                "record_id" to JsonPrimitive(record.metadata.id),
                "account_id" to JsonPrimitive(accountId),
                "metric" to JsonPrimitive(entry.metric ?: entry.name),
                "metric_slug" to JsonPrimitive(entry.metricSlug ?: entry.name),
                "text_value" to JsonPrimitive(textValue),
                "value" to JsonNull,
                "start_time" to JsonPrimitive(iso(start)),
                "end_time" to JsonPrimitive(iso(end)),
                "data_origin" to dataOrigin(record.metadata),
                "recording_method" to JsonPrimitive(recordingMethod(record.metadata)),
                "device_type" to deviceType(record.metadata),
                "metadata" to JsonNull,
            ),
        )
    }

    // ── Vocabulary mappings ───────────────────────────────────────────

    private fun sleepStageName(stage: Int): String = when (stage) {
        SleepSessionRecord.STAGE_TYPE_AWAKE -> "awake"
        SleepSessionRecord.STAGE_TYPE_SLEEPING -> "sleeping"
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "out_of_bed"
        SleepSessionRecord.STAGE_TYPE_LIGHT -> "light"
        SleepSessionRecord.STAGE_TYPE_DEEP -> "deep"
        SleepSessionRecord.STAGE_TYPE_REM -> "rem"
        SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> "awake_in_bed"
        else -> "unknown"
    }

    private fun menstruationFlowName(flow: Int): String = when (flow) {
        MenstruationFlowRecord.FLOW_LIGHT -> "light"
        MenstruationFlowRecord.FLOW_MEDIUM -> "medium"
        MenstruationFlowRecord.FLOW_HEAVY -> "heavy"
        else -> "unknown"
    }

    /** Combined "appearance / sensation" so the single text_value keeps both facets. */
    private fun cervicalMucusName(appearance: Int, sensation: Int): String {
        val a = when (appearance) {
            CervicalMucusRecord.APPEARANCE_DRY -> "dry"
            CervicalMucusRecord.APPEARANCE_STICKY -> "sticky"
            CervicalMucusRecord.APPEARANCE_CREAMY -> "creamy"
            CervicalMucusRecord.APPEARANCE_WATERY -> "watery"
            CervicalMucusRecord.APPEARANCE_EGG_WHITE -> "egg_white"
            CervicalMucusRecord.APPEARANCE_UNUSUAL -> "unusual"
            else -> "unknown"
        }
        val s = when (sensation) {
            CervicalMucusRecord.SENSATION_LIGHT -> "light"
            CervicalMucusRecord.SENSATION_MEDIUM -> "medium"
            CervicalMucusRecord.SENSATION_HEAVY -> "heavy"
            else -> "unknown"
        }
        return "$a / $s"
    }

    private fun ovulationResultName(result: Int): String = when (result) {
        OvulationTestRecord.RESULT_POSITIVE -> "positive"
        OvulationTestRecord.RESULT_HIGH -> "high"
        OvulationTestRecord.RESULT_NEGATIVE -> "negative"
        OvulationTestRecord.RESULT_INCONCLUSIVE -> "inconclusive"
        else -> "unknown"
    }

    private fun sexualProtectionName(protection: Int): String = when (protection) {
        SexualActivityRecord.PROTECTION_USED_PROTECTED -> "protected"
        SexualActivityRecord.PROTECTION_USED_UNPROTECTED -> "unprotected"
        else -> "unknown"
    }

    private fun mindfulnessTypeName(type: Int): String = when (type) {
        MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_MEDITATION -> "meditation"
        MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_BREATHING -> "breathing"
        MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_MUSIC -> "music"
        MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_MOVEMENT -> "movement"
        MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_UNGUIDED -> "unguided"
        MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_UNKNOWN -> "unknown"
        else -> "mindfulness_$type"
    }

    /**
     * Wire names for exercise types. Owned by Omnesis (not Health Connect's own
     * string map) so the analytics vocabulary stays stable across androidx
     * releases. Unmapped ints (future additions) fall back to `exercise_<int>`.
     */
    internal val exerciseTypeNames: Map<Int, String> = mapOf(
        ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT to "other_workout",
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON to "badminton",
        ExerciseSessionRecord.EXERCISE_TYPE_BASEBALL to "baseball",
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL to "basketball",
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING to "biking",
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY to "biking_stationary",
        ExerciseSessionRecord.EXERCISE_TYPE_BOOT_CAMP to "boot_camp",
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING to "boxing",
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS to "calisthenics",
        ExerciseSessionRecord.EXERCISE_TYPE_CRICKET to "cricket",
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING to "dancing",
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL to "elliptical",
        ExerciseSessionRecord.EXERCISE_TYPE_EXERCISE_CLASS to "exercise_class",
        ExerciseSessionRecord.EXERCISE_TYPE_FENCING to "fencing",
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AMERICAN to "football_american",
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AUSTRALIAN to "football_australian",
        ExerciseSessionRecord.EXERCISE_TYPE_FRISBEE_DISC to "frisbee_disc",
        ExerciseSessionRecord.EXERCISE_TYPE_GOLF to "golf",
        ExerciseSessionRecord.EXERCISE_TYPE_GUIDED_BREATHING to "guided_breathing",
        ExerciseSessionRecord.EXERCISE_TYPE_GYMNASTICS to "gymnastics",
        ExerciseSessionRecord.EXERCISE_TYPE_HANDBALL to "handball",
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING to "hiit",
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING to "hiking",
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_HOCKEY to "ice_hockey",
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_SKATING to "ice_skating",
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS to "martial_arts",
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING to "paddling",
        ExerciseSessionRecord.EXERCISE_TYPE_PARAGLIDING to "paragliding",
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES to "pilates",
        ExerciseSessionRecord.EXERCISE_TYPE_RACQUETBALL to "racquetball",
        ExerciseSessionRecord.EXERCISE_TYPE_ROCK_CLIMBING to "rock_climbing",
        ExerciseSessionRecord.EXERCISE_TYPE_ROLLER_HOCKEY to "roller_hockey",
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING to "rowing",
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE to "rowing_machine",
        ExerciseSessionRecord.EXERCISE_TYPE_RUGBY to "rugby",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING to "running",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL to "running_treadmill",
        ExerciseSessionRecord.EXERCISE_TYPE_SAILING to "sailing",
        ExerciseSessionRecord.EXERCISE_TYPE_SCUBA_DIVING to "scuba_diving",
        ExerciseSessionRecord.EXERCISE_TYPE_SKATING to "skating",
        ExerciseSessionRecord.EXERCISE_TYPE_SKIING to "skiing",
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWBOARDING to "snowboarding",
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWSHOEING to "snowshoeing",
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER to "soccer",
        ExerciseSessionRecord.EXERCISE_TYPE_SOFTBALL to "softball",
        ExerciseSessionRecord.EXERCISE_TYPE_SQUASH to "squash",
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING to "stair_climbing",
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE to "stair_climbing_machine",
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING to "strength_training",
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING to "stretching",
        ExerciseSessionRecord.EXERCISE_TYPE_SURFING to "surfing",
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER to "swimming_open_water",
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL to "swimming_pool",
        ExerciseSessionRecord.EXERCISE_TYPE_TABLE_TENNIS to "table_tennis",
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS to "tennis",
        ExerciseSessionRecord.EXERCISE_TYPE_VOLLEYBALL to "volleyball",
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING to "walking",
        ExerciseSessionRecord.EXERCISE_TYPE_WATER_POLO to "water_polo",
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING to "weightlifting",
        ExerciseSessionRecord.EXERCISE_TYPE_WHEELCHAIR to "wheelchair",
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA to "yoga",
    )

    private fun exerciseTypeName(type: Int): String =
        exerciseTypeNames[type] ?: "exercise_$type"

    private fun recordingMethod(metadata: Metadata): String = when (metadata.recordingMethod) {
        Metadata.RECORDING_METHOD_ACTIVELY_RECORDED -> "actively_recorded"
        Metadata.RECORDING_METHOD_AUTOMATICALLY_RECORDED -> "automatically_recorded"
        Metadata.RECORDING_METHOD_MANUAL_ENTRY -> "manually_entered"
        else -> "unknown"
    }

    private fun deviceType(metadata: Metadata): JsonElement {
        val device = metadata.device ?: return JsonNull
        val name = when (device.type) {
            Device.TYPE_WATCH -> "watch"
            Device.TYPE_PHONE -> "phone"
            Device.TYPE_SCALE -> "scale"
            Device.TYPE_RING -> "ring"
            Device.TYPE_CHEST_STRAP -> "chest_strap"
            Device.TYPE_FITNESS_BAND -> "fitness_band"
            Device.TYPE_HEAD_MOUNTED -> "head_mounted"
            Device.TYPE_SMART_DISPLAY -> "smart_display"
            else -> "unknown"
        }
        return JsonPrimitive(name)
    }

    private fun dataOrigin(metadata: Metadata): JsonElement =
        metadata.dataOrigin.packageName.takeIf { it.isNotBlank() }
            ?.let { JsonPrimitive(it) } ?: JsonNull

    private fun nullableString(value: String?): JsonElement =
        value?.let { JsonPrimitive(it) } ?: JsonNull

    // ── Time helpers ──────────────────────────────────────────────────

    private val isoMillis: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** ISO-8601 UTC with milliseconds — the wire format for every timestamp this source emits. */
    fun isoUtcMillis(instant: Instant): String = isoMillis.format(instant)

    private fun iso(instant: Instant): String = isoUtcMillis(instant)
}

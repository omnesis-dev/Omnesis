// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@file:OptIn(ExperimentalMindfulnessSessionApi::class)

package dev.omnesis.android.feature.health

import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.permission.HealthPermission
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
import kotlin.reflect.KClass

/**
 * Declarative description of one Health Connect record type Omnesis reads.
 *
 * @property name Stable name used as the per-type changes-token key in
 *   [HealthCursor] and as the skip-list entry in [SyncOutcome]. Never rename —
 *   renames orphan persisted tokens and force a re-baseline.
 * @property recordType The androidx record class, used for read permissions,
 *   changes-token requests and record reads.
 * @property tableName Target `hc_*` DuckDB table.
 * @property metric `metric` column value for tall-table rows. Null for session
 *   tables and for [NutritionRecord], whose rows carry a per-nutrient
 *   `Nutrition.<field>` metric.
 * @property metricSlug `metric_slug` column value. Null for session tables and
 *   for fan-out types whose rows carry per-component slugs (blood pressure,
 *   nutrition).
 * @property unit Canonical wire unit for the `value` column, when uniform.
 */
data class CatalogEntry(
    val name: String,
    val recordType: KClass<out Record>,
    val tableName: String,
    val metric: String? = null,
    val metricSlug: String? = null,
    val unit: String? = null,
    /** Provider capability required before this record type can be requested. */
    val requiredFeature: Int? = null,
)

/**
 * v1 set of Health Connect record types Omnesis reads — the Android counterpart
 * of the iOS `TypeCatalog`.
 *
 * Order matters: the sync cycle walks entries in this order. Body composition
 * comes first so a fresh weigh-in propagates fast; high-volume vitals (heart
 * rate) stream in later in the pass.
 *
 * Coverage is the full Health Connect record set: every concrete record type the
 * client SDK exposes maps to one of the `hc_*` tables. SkinTemperature fans its
 * baseline + per-time deltas into hc_vitals rows; the categorical cycle-tracking
 * records (menstruation, cervical mucus, ovulation, sexual activity) land in
 * hc_cycle, which carries a `text_value` column for their non-numeric readings.
 */
object HealthTypeCatalog {

    val entries: List<CatalogEntry> = listOf(
        // ── Body composition ──────────────────────────────────────────
        CatalogEntry("Weight", WeightRecord::class, "hc_body", "Weight", "weight", "kg"),
        CatalogEntry("Height", HeightRecord::class, "hc_body", "Height", "height", "m"),
        CatalogEntry("BodyFat", BodyFatRecord::class, "hc_body", "BodyFat", "body_fat", "%"),
        CatalogEntry("LeanBodyMass", LeanBodyMassRecord::class, "hc_body", "LeanBodyMass", "lean_body_mass", "kg"),
        CatalogEntry("BoneMass", BoneMassRecord::class, "hc_body", "BoneMass", "bone_mass", "kg"),
        CatalogEntry("BodyWaterMass", BodyWaterMassRecord::class, "hc_body", "BodyWaterMass", "body_water_mass", "kg"),
        CatalogEntry(
            "BasalMetabolicRate", BasalMetabolicRateRecord::class, "hc_body",
            "BasalMetabolicRate", "basal_metabolic_rate", "kcal/day",
        ),

        // ── Activity ──────────────────────────────────────────────────
        CatalogEntry("Steps", StepsRecord::class, "hc_activity", "Steps", "steps", "count"),
        CatalogEntry("Distance", DistanceRecord::class, "hc_activity", "Distance", "distance", "m"),
        CatalogEntry(
            "ActiveCaloriesBurned", ActiveCaloriesBurnedRecord::class, "hc_activity",
            "ActiveCaloriesBurned", "active_calories", "kcal",
        ),
        CatalogEntry(
            "TotalCaloriesBurned", TotalCaloriesBurnedRecord::class, "hc_activity",
            "TotalCaloriesBurned", "total_calories", "kcal",
        ),
        CatalogEntry("FloorsClimbed", FloorsClimbedRecord::class, "hc_activity", "FloorsClimbed", "floors_climbed", "count"),
        CatalogEntry("ElevationGained", ElevationGainedRecord::class, "hc_activity", "ElevationGained", "elevation_gained", "m"),
        CatalogEntry("Vo2Max", Vo2MaxRecord::class, "hc_activity", "Vo2Max", "vo2_max", "mL/min/kg"),
        CatalogEntry(
            "WheelchairPushes", WheelchairPushesRecord::class, "hc_activity",
            "WheelchairPushes", "wheelchair_pushes", "count",
        ),
        // Series records — one row per sample, like HeartRate (fan out on record_id).
        CatalogEntry("Power", PowerRecord::class, "hc_activity", "Power", "power", "W"),
        CatalogEntry("Speed", SpeedRecord::class, "hc_activity", "Speed", "speed", "m/s"),
        CatalogEntry("StepsCadence", StepsCadenceRecord::class, "hc_activity", "StepsCadence", "steps_cadence", "rpm"),
        CatalogEntry(
            "CyclingPedalingCadence", CyclingPedalingCadenceRecord::class, "hc_activity",
            "CyclingPedalingCadence", "cycling_pedaling_cadence", "rpm",
        ),

        // ── Vitals ────────────────────────────────────────────────────
        CatalogEntry("HeartRate", HeartRateRecord::class, "hc_vitals", "HeartRate", "heart_rate", "bpm"),
        CatalogEntry(
            "RestingHeartRate", RestingHeartRateRecord::class, "hc_vitals",
            "RestingHeartRate", "resting_heart_rate", "bpm",
        ),
        CatalogEntry(
            "HeartRateVariabilityRmssd", HeartRateVariabilityRmssdRecord::class, "hc_vitals",
            "HeartRateVariabilityRmssd", "hrv", "ms",
        ),
        // Fans out into blood_pressure_systolic / blood_pressure_diastolic rows.
        CatalogEntry("BloodPressure", BloodPressureRecord::class, "hc_vitals", "BloodPressure", unit = "mmHg"),
        CatalogEntry(
            "OxygenSaturation", OxygenSaturationRecord::class, "hc_vitals",
            "OxygenSaturation", "oxygen_saturation", "%",
        ),
        CatalogEntry("BloodGlucose", BloodGlucoseRecord::class, "hc_vitals", "BloodGlucose", "blood_glucose", "mmol/L"),
        CatalogEntry("BodyTemperature", BodyTemperatureRecord::class, "hc_vitals", "BodyTemperature", "body_temperature", "°C"),
        CatalogEntry("RespiratoryRate", RespiratoryRateRecord::class, "hc_vitals", "RespiratoryRate", "respiratory_rate", "rpm"),
        CatalogEntry(
            "BasalBodyTemperature", BasalBodyTemperatureRecord::class, "hc_vitals",
            "BasalBodyTemperature", "basal_body_temperature", "°C",
        ),
        // Fans out into a baseline row + one row per delta sample (per-row slugs).
        CatalogEntry(
            "SkinTemperature", SkinTemperatureRecord::class, "hc_vitals", "SkinTemperature", unit = "°C",
            requiredFeature = HealthConnectFeatures.FEATURE_SKIN_TEMPERATURE,
        ),

        // ── Sleep ─────────────────────────────────────────────────────
        CatalogEntry("SleepSession", SleepSessionRecord::class, "hc_sleep"),

        // ── Nutrition ─────────────────────────────────────────────────
        // Fans out into one row per non-null nutrient (Nutrition.<field>).
        CatalogEntry("Nutrition", NutritionRecord::class, "hc_nutrition"),
        CatalogEntry("Hydration", HydrationRecord::class, "hc_nutrition", "Hydration", "hydration", "mL"),

        // ── Mindfulness ───────────────────────────────────────────────
        CatalogEntry(
            "MindfulnessSession", MindfulnessSessionRecord::class, "hc_mindfulness",
            requiredFeature = HealthConnectFeatures.FEATURE_MINDFULNESS_SESSION,
        ),

        // ── Workouts ──────────────────────────────────────────────────
        CatalogEntry("ExerciseSession", ExerciseSessionRecord::class, "hc_exercise"),
        CatalogEntry(
            "PlannedExerciseSession", PlannedExerciseSessionRecord::class, "hc_exercise",
            requiredFeature = HealthConnectFeatures.FEATURE_PLANNED_EXERCISE,
        ),

        // ── Cycle tracking ────────────────────────────────────────────
        // Categorical reproductive-health records: no numeric reading, so each
        // carries its category in hc_cycle's `text_value` column (value is null).
        CatalogEntry("MenstruationFlow", MenstruationFlowRecord::class, "hc_cycle", "MenstruationFlow", "menstruation_flow"),
        CatalogEntry("MenstruationPeriod", MenstruationPeriodRecord::class, "hc_cycle", "MenstruationPeriod", "menstruation_period"),
        CatalogEntry(
            "IntermenstrualBleeding", IntermenstrualBleedingRecord::class, "hc_cycle",
            "IntermenstrualBleeding", "intermenstrual_bleeding",
        ),
        CatalogEntry("CervicalMucus", CervicalMucusRecord::class, "hc_cycle", "CervicalMucus", "cervical_mucus"),
        CatalogEntry("OvulationTest", OvulationTestRecord::class, "hc_cycle", "OvulationTest", "ovulation_test"),
        CatalogEntry("SexualActivity", SexualActivityRecord::class, "hc_cycle", "SexualActivity", "sexual_activity"),
    )

    /** The Health Connect read permission guarding [entry]'s record type. */
    fun readPermissionFor(entry: CatalogEntry): String =
        HealthPermission.getReadPermission(entry.recordType)

    /** Every per-type read permission the catalog needs, deduped. */
    val perTypeReadPermissions: Set<String> =
        entries.map { readPermissionFor(it) }.toSet()

    /**
     * Everything the consent flow must request: the per-type read permissions
     * plus background reads (sync runs from a background worker, which throws
     * SecurityException without the grant) and history reads (the baseline
     * pages from epoch, not just the 30 days before the grant).
     */
    fun permissionsToRequest(
        categories: Set<HealthCategory>,
        featureAvailable: (Int) -> Boolean = { true },
    ): Set<String> {
        if (categories.isEmpty()) return emptySet()
        val typePermissions = entries
            .filter { HealthCategory.fromTableName(it.tableName) in categories }
            .filter { it.requiredFeature?.let(featureAvailable) != false }
            .map(::readPermissionFor)
            .toSet()
        return buildSet {
            addAll(typePermissions)
            if (featureAvailable(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)) {
                add(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
            }
            if (featureAvailable(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY)) {
                add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
            }
        }
    }

    /** Complete declaration set, used for manifest parity and existing users. */
    val allPermissionsToRequest: Set<String> = permissionsToRequest(HealthCategory.entries.toSet())

    /** Index for the normalizer's record-class → entry dispatch. */
    val byRecordType: Map<KClass<out Record>, CatalogEntry> =
        entries.associateBy { it.recordType }

    /**
     * Which column Changes-API deletion ids match against in [tableName].
     * Tall tables fan one record out into several rows sharing `record_id`;
     * sleep stages share their `session_id`; session tables delete by primary key
     * (null — the record id IS the row id).
     *
     * The same answer becomes the table's own `deleteKey` when its schema is
     * pushed, so the gateway is told how the table is addressed once rather
     * than being reminded on every page that carries a tombstone.
     */
    fun deleteKeyColumnFor(tableName: String): String? = when (tableName) {
        "hc_body", "hc_activity", "hc_vitals", "hc_nutrition" -> "record_id"
        "hc_sleep" -> "session_id"
        else -> null
    }
}

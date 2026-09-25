// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.MenstruationFlowRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Temperature
import java.time.Instant

/**
 * Deterministic synthetic fixtures the Tier B round-trip seeds into the real
 * Health Connect provider. Every value is invented — nothing here derives from
 * any real person's data. All timestamps hang off a caller-supplied `base`
 * (the test passes `Instant.now()`) and stay in the recent past, inside the
 * provider's 30-days-before-grant read window, so the test never needs the
 * `READ_HEALTH_DATA_HISTORY` grant.
 *
 * Each record carries a `clientRecordId` under [CLIENT_ID_PREFIX] — the handle
 * the test's clean-slate pass uses to find and delete leftovers from previous
 * runs without touching anything else in the provider.
 */
object SyntheticHealthData {

    const val CLIENT_ID_PREFIX = "omnesis-tierb-"

    const val WEIGHT_A_KG = 71.5
    const val WEIGHT_B_KG = 72.25
    const val WEIGHT_DELTA_KG = 73.0
    const val STEPS_COUNT = 4321L
    val HEART_RATE_BPM = listOf(62L, 75L, 68L)
    const val ACTIVE_KCAL = 320.0
    const val TOTAL_KCAL = 1875.0
    const val DISTANCE_M = 5200.0

    /** Two weights, one steps interval, one 3-sample heart-rate record, one 2-stage sleep session. */
    fun baselineRecords(base: Instant): List<Record> =
        listOf(weightA(base), weightB(base), steps(base), heartRate(base), sleepSession(base))

    /**
     * Energy + distance activity records (hc_activity), kept separate from
     * [baselineRecords] so the round-trip test's per-table counts are unaffected.
     * The seeder ([SeedHealthData]) adds these so a QA device exercises the
     * energy-burned columns the activity dashboards key off.
     */
    fun energyAndDistanceRecords(base: Instant): List<Record> =
        listOf(activeCalories(base), totalCalories(base), distance(base))

    fun activeCalories(base: Instant): ActiveCaloriesBurnedRecord {
        val start = base.minusSeconds(4 * 3600)
        return ActiveCaloriesBurnedRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(45 * 60),
            endZoneOffset = null,
            energy = Energy.kilocalories(ACTIVE_KCAL),
            metadata = metadata("active-cal-a"),
        )
    }

    fun totalCalories(base: Instant): TotalCaloriesBurnedRecord {
        val start = base.minusSeconds(5 * 3600)
        return TotalCaloriesBurnedRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(3600),
            endZoneOffset = null,
            energy = Energy.kilocalories(TOTAL_KCAL),
            metadata = metadata("total-cal-a"),
        )
    }

    fun distance(base: Instant): DistanceRecord {
        val start = base.minusSeconds(3 * 3600)
        return DistanceRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(40 * 60),
            endZoneOffset = null,
            distance = Length.meters(DISTANCE_M),
            metadata = metadata("distance-a"),
        )
    }

    /**
     * One record from each of the three "new shape" paths added for full
     * coverage: a new scalar vital (basal body temp → hc_vitals), a series record
     * (power → hc_activity), and a categorical cycle record (menstruation flow →
     * hc_cycle, exercising the text_value column). Seeded by [SeedHealthData].
     */
    fun fullCoverageRecords(base: Instant): List<Record> =
        listOf(basalBodyTemperature(base), power(base), menstruationFlow(base))

    fun basalBodyTemperature(base: Instant): BasalBodyTemperatureRecord = BasalBodyTemperatureRecord(
        time = base.minusSeconds(6 * 3600),
        zoneOffset = null,
        temperature = Temperature.celsius(36.6),
        metadata = metadata("basal-temp-a"),
    )

    fun power(base: Instant): PowerRecord {
        val start = base.minusSeconds(150 * 60)
        return PowerRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(120),
            endZoneOffset = null,
            samples = listOf(
                PowerRecord.Sample(start, Power.watts(180.0)),
                PowerRecord.Sample(start.plusSeconds(60), Power.watts(205.0)),
            ),
            metadata = metadata("power-a"),
        )
    }

    fun menstruationFlow(base: Instant): MenstruationFlowRecord = MenstruationFlowRecord(
        time = base.minusSeconds(7 * 3600),
        zoneOffset = null,
        flow = MenstruationFlowRecord.FLOW_MEDIUM,
        metadata = metadata("flow-a"),
    )

    fun weightA(base: Instant): WeightRecord = weight(WEIGHT_A_KG, base.minusSeconds(2 * 3600), "weight-a")

    fun weightB(base: Instant): WeightRecord = weight(WEIGHT_B_KG, base.minusSeconds(3600), "weight-b")

    /** The extra weight inserted between the baseline and the delta sync. */
    fun deltaWeight(base: Instant): WeightRecord = weight(WEIGHT_DELTA_KG, base.minusSeconds(30 * 60), "weight-c")

    fun steps(base: Instant): StepsRecord {
        val start = base.minusSeconds(3 * 3600)
        return StepsRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(3600),
            endZoneOffset = null,
            count = STEPS_COUNT,
            metadata = metadata("steps-a"),
        )
    }

    /** One record, three samples a minute apart. */
    fun heartRate(base: Instant): HeartRateRecord {
        val start = base.minusSeconds(90 * 60)
        return HeartRateRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(HEART_RATE_BPM.size * 60L),
            endZoneOffset = null,
            samples = HEART_RATE_BPM.mapIndexed { idx, bpm ->
                HeartRateRecord.Sample(start.plusSeconds(idx * 60L), bpm)
            },
            metadata = metadata("hr-a"),
        )
    }

    /** One session, two stages (light then deep) tiling the session span. */
    fun sleepSession(base: Instant): SleepSessionRecord {
        val start = base.minusSeconds(9 * 3600)
        val mid = start.plusSeconds(3600)
        val end = start.plusSeconds(2 * 3600)
        return SleepSessionRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = end,
            endZoneOffset = null,
            stages = listOf(
                SleepSessionRecord.Stage(start, mid, SleepSessionRecord.STAGE_TYPE_LIGHT),
                SleepSessionRecord.Stage(mid, end, SleepSessionRecord.STAGE_TYPE_DEEP),
            ),
            metadata = metadata("sleep-a"),
        )
    }

    private fun weight(kg: Double, at: Instant, idSuffix: String): WeightRecord = WeightRecord(
        time = at,
        zoneOffset = null,
        weight = Mass.kilograms(kg),
        metadata = metadata(idSuffix),
    )

    private fun metadata(idSuffix: String): Metadata =
        Metadata.manualEntry(clientRecordId = CLIENT_ID_PREFIX + idSuffix)
}

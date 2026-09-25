// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.content.Context
import android.os.RemoteException
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.reflect.KClass
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tier B: the production [HealthConnectSource] against the REAL Health Connect
 * provider on a device/emulator — the layer the JVM fakes can't cover. The test
 * APK plays both roles: it seeds invented records via `insertRecords`, then the
 * production engine reads them back through the real Changes API, proving the
 * provider honors the whole baseline → delta → deletion cursor model.
 *
 * Three phases inside one test (the cursor threads through, so order matters):
 *  1. Baseline — seed 2 weights / 1 steps / 1 three-sample heart rate /
 *     1 two-stage sleep session, sync from the empty cursor, assert the
 *     normalized rows and that changes tokens were minted.
 *  2. Delta — insert one more weight, sync with the returned cursor, assert
 *     exactly that record arrives (preceded by its fan-out pre-delete page).
 *  3. Deletion — delete one baseline weight, sync again, assert a tombstone
 *     page carrying that record id.
 *
 * Setup never `pm clear`s the provider (that would nuke the permission grants);
 * the clean slate deletes leftovers from previous runs found via the
 * [SyntheticHealthData.CLIENT_ID_PREFIX] clientRecordId convention.
 *
 * A blank [TierBHostActivity] stays RESUMED for the duration so reads count as
 * foreground (no `READ_HEALTH_DATA_IN_BACKGROUND` grant needed).
 */
@LargeTest
@RunWith(AndroidJUnit4::class)
class HealthConnectRoundTripTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var client: HealthConnectClient

    /**
     * Deliberately NOT this test APK's package: rows the test writes carry
     * `dataOrigin` = the test package, and the source drops rows whose origin
     * equals `selfPackageName` (self-echo suppression). A fictional package
     * keeps the seeded rows visible while still exercising that filter.
     */
    private val selfPackage = "com.example.synthwriter"

    private val seededTypes: List<KClass<out Record>> = listOf(
        WeightRecord::class,
        StepsRecord::class,
        HeartRateRecord::class,
        SleepSessionRecord::class,
    )

    @Before
    fun setUp() {
        assumeTrue(
            "Health Connect SDK not available on this image",
            HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE,
        )
        client = HealthConnectClient.getOrCreate(context)
        HealthPermissionGate.ensureGranted(context, client)
        runBlocking { deleteSeededRecords() }
    }

    @After
    fun tearDown() {
        // Best effort — leave the provider clean for whoever uses the emulator
        // next. Guarded so a permission-skip in setUp doesn't turn into a failure.
        if (!this::client.isInitialized) return
        try {
            runBlocking { deleteSeededRecords() }
        } catch (e: SecurityException) {
            // Permissions were never granted; nothing was seeded.
        }
    }

    @Test
    fun roundTrip_baseline_delta_deletion() {
        ActivityScenario.launch(TierBHostActivity::class.java).use {
            val base = Instant.now()
            val source = HealthConnectSource(
                client = client,
                accountId = "tierb-test",
                selfPackageName = selfPackage,
                settings = HealthSettings(InMemoryKeyValueStore()),
            )

            // ── Phase 1: baseline ─────────────────────────────────────────
            val insertedIds = runBlocking {
                rateLimitAware { client.insertRecords(SyntheticHealthData.baselineRecords(base)).recordIdsList }
            }
            val (weightAId, weightBId, stepsId, hrId, sleepId) = insertedIds

            val pages1 = mutableListOf<HealthPage>()
            val outcome1 = runBlocking { source.sync(HealthCursor()) { pages1 += it } }

            // hc_body: both weights, exact kg values, attributed to this package.
            val bodyRows = rows(pages1, "hc_body").filter { str(it, "record_id") in setOf(weightAId, weightBId) }
            assertEquals(2, bodyRows.size)
            assertEquals(
                mapOf(
                    weightAId to SyntheticHealthData.WEIGHT_A_KG,
                    weightBId to SyntheticHealthData.WEIGHT_B_KG,
                ),
                bodyRows.associate { str(it, "record_id") to dbl(it, "value") },
            )
            bodyRows.forEach { assertEquals(context.packageName, str(it, "data_origin")) }

            // hc_activity: the steps interval.
            val stepRows = rows(pages1, "hc_activity").filter { str(it, "record_id") == stepsId }
            assertEquals(1, stepRows.size)
            assertEquals(SyntheticHealthData.STEPS_COUNT.toDouble(), dbl(stepRows.single(), "value"), 0.0)

            // hc_vitals: three sample rows fanned out of ONE record, ids suffixed :0..:2.
            val hrRows = rows(pages1, "hc_vitals").filter { str(it, "record_id") == hrId }
            assertEquals(3, hrRows.size)
            assertEquals(
                SyntheticHealthData.HEART_RATE_BPM.mapIndexed { i, bpm -> "$hrId:$i" to bpm.toDouble() }.toMap(),
                hrRows.associate { str(it, "id") to dbl(it, "value") },
            )

            // hc_sleep: two stage rows sharing the session id.
            val sleepRows = rows(pages1, "hc_sleep").filter { str(it, "session_id") == sleepId }
            assertEquals(2, sleepRows.size)
            assertEquals(setOf("$sleepId:0", "$sleepId:1"), sleepRows.map { str(it, "id") }.toSet())
            assertEquals(setOf("light", "deep"), sleepRows.map { str(it, "stage") }.toSet())

            // Changes tokens minted for every seeded type; none of them skipped.
            for (name in listOf("Weight", "Steps", "HeartRate", "SleepSession")) {
                assertFalse("$name unexpectedly skipped", name in outcome1.skipped)
                assertNotNull("missing changes token for $name", outcome1.cursor.tokenFor(name))
            }
            // Catalog-wide invariant: a type either synced (token) or was skipped.
            val granted = runBlocking { client.permissionController.getGrantedPermissions() }
            for (entry in HealthTypeCatalog.entries) {
                if (HealthTypeCatalog.readPermissionFor(entry) in granted) {
                    if (entry.name !in outcome1.skipped) {
                        assertNotNull(outcome1.cursor.tokenFor(entry.name))
                    }
                } else {
                    assertTrue("ungranted ${entry.name} must be skipped", entry.name in outcome1.skipped)
                }
            }

            // ── Phase 2: delta — exactly the new record arrives ───────────
            val deltaId = runBlocking {
                rateLimitAware { client.insertRecords(listOf(SyntheticHealthData.deltaWeight(base))).recordIdsList.single() }
            }
            val pages2 = mutableListOf<HealthPage>()
            val outcome2 = runBlocking { source.sync(outcome1.cursor) { pages2 += it } }

            assertEquals(1, outcome2.upserted)
            assertEquals(0, outcome2.deleted)
            val deltaRows = pages2.flatMap { it.records }
            assertEquals(1, deltaRows.size)
            assertEquals("hc_body", pages2.first { it.records.isNotEmpty() }.tableName)
            assertEquals(deltaId, str(deltaRows.single(), "record_id"))
            assertEquals(SyntheticHealthData.WEIGHT_DELTA_KG, dbl(deltaRows.single(), "value"), 1e-9)

            // The fan-out pre-delete tombstone precedes the fresh row.
            val tombstoneIdx = pages2.indexOfFirst {
                it.tableName == "hc_body" && it.records.isEmpty() && it.deletedIds == listOf(deltaId)
            }
            val rowIdx = pages2.indexOfFirst { it.records.isNotEmpty() }
            assertTrue("pre-delete tombstone page missing", tombstoneIdx >= 0)
            assertEquals("record_id", pages2[tombstoneIdx].deleteKeyColumn)
            assertTrue("tombstone must precede the row page", tombstoneIdx < rowIdx)

            // ── Phase 3: deletion — tombstone for the deleted record ──────
            runBlocking { rateLimitAware { client.deleteRecords(WeightRecord::class, listOf(weightAId), emptyList()) } }
            val pages3 = mutableListOf<HealthPage>()
            val outcome3 = runBlocking { source.sync(outcome2.cursor) { pages3 += it } }

            assertEquals(0, outcome3.upserted)
            assertEquals(1, outcome3.deleted)
            val delPage = pages3.single()
            assertEquals("hc_body", delPage.tableName)
            assertTrue(delPage.records.isEmpty())
            assertEquals(listOf(weightAId), delPage.deletedIds)
            assertEquals("record_id", delPage.deleteKeyColumn)
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /**
     * Health Connect rate-limits requests per app; reading the catalogue on a busy
     * physical device can exhaust the quota and the provider then throws a
     * [RemoteException] until it replenishes. The production source rides this out
     * with its own backoff; this test's own direct provider calls need the same so
     * the suite doesn't flake on a device whose quota is low. Retries with backoff
     * only on the rate-limit error; anything else propagates.
     */
    private suspend fun <T> rateLimitAware(block: suspend () -> T): T {
        var delayMs = 1_000L
        repeat(8) {
            try {
                return block()
            } catch (e: RemoteException) {
                val rateLimited = e.message?.contains("rate limit", ignoreCase = true) == true ||
                    e.message?.contains("quota", ignoreCase = true) == true
                if (!rateLimited) throw e
                delay(delayMs)
                delayMs = (delayMs * 2).coerceAtMost(30_000L)
            }
        }
        return block()
    }

    /**
     * Deletes every record carrying the tierb clientRecordId prefix, by record
     * id. Reads back a 7-day window (well past any fixture timestamp) so the
     * query never needs the history grant.
     */
    private suspend fun deleteSeededRecords() {
        val window = TimeRangeFilter.after(Instant.now().minus(7, ChronoUnit.DAYS))
        for (type in seededTypes) {
            val ours = mutableListOf<String>()
            var pageToken: String? = null
            do {
                @Suppress("UNCHECKED_CAST")
                val response = rateLimitAware {
                    client.readRecords(
                        ReadRecordsRequest(
                            recordType = type as KClass<Record>,
                            timeRangeFilter = window,
                            pageToken = pageToken,
                        ),
                    )
                }
                response.records
                    .filter { it.metadata.clientRecordId?.startsWith(SyntheticHealthData.CLIENT_ID_PREFIX) == true }
                    .forEach { ours += it.metadata.id }
                pageToken = response.pageToken
            } while (pageToken != null)
            if (ours.isNotEmpty()) {
                rateLimitAware { client.deleteRecords(type, ours, emptyList()) }
            }
        }
    }

    private fun rows(pages: List<HealthPage>, table: String): List<Map<String, JsonElement>> =
        pages.filter { it.tableName == table }.flatMap { it.records }

    private fun str(row: Map<String, JsonElement>, key: String): String =
        (row.getValue(key) as JsonPrimitive).content

    private fun dbl(row: Map<String, JsonElement>, key: String): Double =
        (row.getValue(key) as JsonPrimitive).double
}

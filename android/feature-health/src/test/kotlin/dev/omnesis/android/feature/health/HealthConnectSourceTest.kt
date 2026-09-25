// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.os.RemoteException
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ChangesResponse
import androidx.health.connect.client.response.ReadRecordsResponse
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import androidx.health.connect.client.testing.stubs.Stub
import androidx.health.connect.client.units.Mass
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sync-engine behavior against the androidx [FakeHealthConnectClient]: baseline,
 * incremental deltas, deletions, permission degradation, token expiry and
 * page chunking.
 *
 * Note on the fake (connect-testing 1.0.0-alpha03): after a `getChanges` call
 * drains all changes, the *stored* state for the returned future token is
 * mis-timed (its internal time advances by `pageSizeGetChanges` instead of to
 * the change log head), so a SECOND delta round against the same fake misses
 * new changes. Every test therefore runs at most one delta round per fake
 * instance — baseline, mutate, one sync.
 *
 * All fixture values invented; package names are fictional.
 */
class HealthConnectSourceTest {

    private val accountId = "android-11aa22bb"
    private val selfPackage = "dev.omnesis.android"
    private val otherPackage = "com.example.fittracker"
    private val fixedNow = Instant.parse("2030-01-01T00:00:00Z")
    private val t0 = Instant.parse("2026-06-10T08:00:00Z")

    private fun source(
        fake: FakeHealthConnectClient,
        settings: HealthSettings = HealthSettings(InMemoryKeyValueStore()),
        pageSize: Int = 500,
    ) = HealthConnectSource(
        client = fake,
        accountId = accountId,
        selfPackageName = selfPackage,
        settings = settings,
        clock = { fixedNow },
        pageSize = pageSize,
    )

    private fun weight(kg: Double, at: Instant = t0) = WeightRecord(
        time = at,
        zoneOffset = null,
        weight = Mass.kilograms(kg),
        metadata = Metadata.manualEntry(),
    )

    private fun steps(count: Long, start: Instant = t0) = StepsRecord(
        startTime = start,
        startZoneOffset = null,
        endTime = start.plusSeconds(3600),
        endZoneOffset = null,
        count = count,
        metadata = Metadata.manualEntry(),
    )

    private fun heartRate(
        sampleCount: Int,
        start: Instant = t0,
        metadata: Metadata = Metadata.manualEntry(),
    ) = HeartRateRecord(
        startTime = start,
        startZoneOffset = null,
        endTime = start.plusSeconds(sampleCount * 60L + 1),
        endZoneOffset = null,
        samples = (0 until sampleCount).map {
            HeartRateRecord.Sample(start.plusSeconds(it * 60L), 60L + (it % 30))
        },
        metadata = metadata,
    )

    private fun rowsFor(pages: List<HealthPage>, tableName: String) =
        pages.filter { it.tableName == tableName }.flatMap { it.records }

    // ── (a) baseline ──────────────────────────────────────────────────

    @Test
    fun baselineEmitsAllRecordsAndStoresTokens() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0), weight(70.4, t0.plusSeconds(86400)), weight(70.2, t0.plusSeconds(2 * 86400))))
        fake.insertRecords(listOf(steps(8200), steps(10400, t0.plusSeconds(86400))))

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(HealthCursor()) { pages += it }

        val bodyRows = rowsFor(pages, "hc_body")
        val activityRows = rowsFor(pages, "hc_activity")
        assertEquals(3, bodyRows.size)
        assertEquals(2, activityRows.size)
        assertEquals(5, outcome.upserted)
        assertEquals(0, outcome.deleted)
        assertTrue(outcome.skipped.isEmpty())

        // Every granted type baselined: token present even for types with no data.
        for (entry in HealthTypeCatalog.entries) {
            assertNotNull("missing token for ${entry.name}", outcome.cursor.tokenFor(entry.name))
        }

        // Rows match the table contract exactly (column set + key fields).
        val row = bodyRows.first()
        assertEquals(HealthSchemas.HC_BODY.columns.map { it.name }.toSet(), row.keys)
        assertEquals(row["id"], row["record_id"])
        assertEquals(JsonPrimitive(accountId), row["account_id"])
        assertEquals(JsonPrimitive(FakeHealthConnectClient.DEFAULT_PACKAGE_NAME), row["data_origin"])

        // Pages attach the right schema.
        assertTrue(pages.all { it.schema.tableName == it.tableName })
    }

    // ── (b) idempotent delta ──────────────────────────────────────────

    @Test
    fun immediateResyncEmitsNothingNew() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0), steps(9100)))
        val first = source(fake).sync(HealthCursor()) {}

        val pages = mutableListOf<HealthPage>()
        val second = source(fake).sync(first.cursor) { pages += it }

        assertEquals(0, second.upserted)
        assertEquals(0, second.deleted)
        assertTrue(pages.isEmpty())
        for (entry in HealthTypeCatalog.entries) {
            assertNotNull(second.cursor.tokenFor(entry.name))
        }
    }

    // ── (c) incremental upsert ────────────────────────────────────────

    @Test
    fun newRecordAfterBaselineComesThroughTheDelta() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0)))
        val baseline = source(fake).sync(HealthCursor()) {}
        val weightTokenBefore = baseline.cursor.tokenFor("Weight")

        val inserted = fake.insertRecords(listOf(weight(69.6, t0.plusSeconds(86400)))).recordIdsList.single()

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(baseline.cursor) { pages += it }

        val rows = rowsFor(pages, "hc_body")
        assertEquals(1, rows.size)
        assertEquals(JsonPrimitive(inserted), rows.single()["id"])
        assertEquals(1, outcome.upserted)
        assertNotEquals(weightTokenBefore, outcome.cursor.tokenFor("Weight"))
    }

    // ── (d) deletion ──────────────────────────────────────────────────

    @Test
    fun deletionTombstonesCarryTheDeleteKeyColumn() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        val ids = fake.insertRecords(listOf(weight(70.0), weight(70.5, t0.plusSeconds(86400)))).recordIdsList
        val baseline = source(fake).sync(HealthCursor()) {}

        fake.deleteRecords(WeightRecord::class, recordIdsList = listOf(ids[0]), clientRecordIdsList = emptyList())

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(baseline.cursor) { pages += it }

        assertEquals(1, outcome.deleted)
        assertEquals(0, outcome.upserted)
        val page = pages.single()
        assertEquals("hc_body", page.tableName)
        assertTrue(page.records.isEmpty())
        assertEquals(listOf(ids[0]), page.deletedIds)
        assertEquals("record_id", page.deleteKeyColumn)
    }

    // ── (e) permissions missing ───────────────────────────────────────

    @Test
    fun missingPermissionsSkipEverythingAndLeaveTheCursorUntouched() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = false))
        fake.insertRecords(listOf(weight(70.0)))

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(HealthCursor()) { pages += it }

        assertTrue(pages.isEmpty())
        assertEquals(0, outcome.upserted)
        assertEquals(HealthTypeCatalog.entries.map { it.name }.toSet(), outcome.skipped.toSet())
        assertEquals(HealthCursor(), outcome.cursor)
    }

    // ── (f) SecurityException mid-flight ──────────────────────────────

    @Test
    fun backgroundDenialSkipsTheTypeButKeepsItsToken() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0), steps(8000)))
        val baseline = source(fake).sync(HealthCursor()) {}
        val weightToken = baseline.cursor.tokenFor("Weight")!!

        // A background read without the background-read grant throws
        // SecurityException even while every per-type read permission is
        // still granted.
        val newSteps = fake.insertRecords(listOf(steps(9500, t0.plusSeconds(86400)))).recordIdsList.single()
        fake.overrides.getChanges = Stub<String, ChangesResponse> { token ->
            if (token == weightToken) throw SecurityException("background read not permitted") else null
        }

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(baseline.cursor) { pages += it }

        assertEquals(listOf("Weight"), outcome.skipped)
        // Permission still granted → the token survives for the next pass.
        assertEquals(weightToken, outcome.cursor.tokenFor("Weight"))
        // The rest of the catalog still synced.
        val activityRows = rowsFor(pages, "hc_activity")
        assertEquals(1, activityRows.size)
        assertEquals(JsonPrimitive(newSteps), activityRows.single()["id"])
        assertNotNull(outcome.cursor.tokenFor("Steps"))
    }

    @Test
    fun confirmedRevocationSkipsTheTypeAndDropsItsToken() = runTest {
        val permissions = FakePermissionController(grantAll = true)
        val fake = FakeHealthConnectClient(permissionController = permissions)
        fake.insertRecords(listOf(weight(70.0), steps(8000)))
        val baseline = source(fake).sync(HealthCursor()) {}
        val weightToken = baseline.cursor.tokenFor("Weight")!!
        val weightEntry = HealthTypeCatalog.entries.first { it.name == "Weight" }

        // The revocation lands between the pass's upfront permission snapshot
        // and the type's read, so the grant is gone when the engine re-checks.
        fake.overrides.getChanges = Stub<String, ChangesResponse> { token ->
            if (token == weightToken) {
                permissions.revokePermission(HealthTypeCatalog.readPermissionFor(weightEntry))
                throw SecurityException("read permission revoked")
            } else {
                null
            }
        }

        val outcome = source(fake).sync(baseline.cursor) {}

        assertEquals(listOf("Weight"), outcome.skipped)
        // Confirmed revocation → the token is dropped so a re-grant re-baselines.
        assertNull(outcome.cursor.tokenFor("Weight"))
        assertNotNull(outcome.cursor.tokenFor("Steps"))
    }

    // ── (g) hard failure aborts after partial progress ────────────────

    @Test
    fun ioFailureAbortsWithAdvancedCursorAndWellFormedPages() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0)))
        val baseline = source(fake).sync(HealthCursor()) {}
        val weightTokenBefore = baseline.cursor.tokenFor("Weight")
        val stepsToken = baseline.cursor.tokenFor("Steps")!!

        // Weight precedes Steps in the catalog, so the weight delta lands first.
        val newWeight = fake.insertRecords(listOf(weight(69.4, t0.plusSeconds(86400)))).recordIdsList.single()
        fake.overrides.getChanges = Stub<String, ChangesResponse> { token ->
            if (token == stepsToken) throw IOException("binder transport gone") else null
        }

        val pages = mutableListOf<HealthPage>()
        var thrown: HealthSyncException? = null
        try {
            source(fake).sync(baseline.cursor) { pages += it }
        } catch (e: HealthSyncException) {
            thrown = e
        }

        assertNotNull(thrown)
        thrown!!
        assertTrue(thrown.cause is IOException)
        // Progress made before the failure is preserved on the exception.
        assertEquals(1, thrown.upserted)
        assertNotEquals(weightTokenBefore, thrown.cursor.tokenFor("Weight"))
        // Pages already emitted are complete and re-sendable.
        val rows = rowsFor(pages, "hc_body")
        assertEquals(1, rows.size)
        assertEquals(JsonPrimitive(newWeight), rows.single()["id"])
        assertEquals(HealthSchemas.HC_BODY.columns.map { it.name }.toSet(), rows.single().keys)
    }

    // ── (h) token expiry re-baselines ─────────────────────────────────

    @Test
    fun expiredTokenForcesAFullRebaselineOfTheType() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0), weight(70.3, t0.plusSeconds(86400))))
        val baseline = source(fake).sync(HealthCursor()) {}
        val expiredToken = baseline.cursor.tokenFor("Weight")!!

        fake.insertRecords(listOf(weight(69.9, t0.plusSeconds(2 * 86400))))
        fake.expireToken(expiredToken)

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(baseline.cursor) { pages += it }

        // All three rows re-emitted (old ids dedup via PK upsert downstream).
        assertEquals(3, rowsFor(pages, "hc_body").size)
        assertEquals(3, outcome.upserted)
        assertNotNull(outcome.cursor.tokenFor("Weight"))
        assertNotEquals(expiredToken, outcome.cursor.tokenFor("Weight"))
    }

    // ── (i) disabled category ─────────────────────────────────────────

    @Test
    fun disabledCategorySkipsItsTypes() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0), steps(7600)))
        val settings = HealthSettings(InMemoryKeyValueStore())
        settings.setCategory(HealthCategory.BODY, false)

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake, settings = settings).sync(HealthCursor()) { pages += it }

        val bodyNames = HealthTypeCatalog.entries.filter { it.tableName == "hc_body" }.map { it.name }
        assertEquals(bodyNames.toSet(), outcome.skipped.toSet())
        assertTrue(rowsFor(pages, "hc_body").isEmpty())
        assertNull(outcome.cursor.tokenFor("Weight"))
        assertEquals(1, rowsFor(pages, "hc_activity").size)
        assertNotNull(outcome.cursor.tokenFor("Steps"))
    }

    // ── (j) fan-out chunking ──────────────────────────────────────────

    @Test
    fun fanOutRowsAreChunkedToThePageSize() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(heartRate(sampleCount = 25)))

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake, pageSize = 10).sync(HealthCursor()) { pages += it }

        val vitalsPages = pages.filter { it.tableName == "hc_vitals" }
        assertEquals(3, vitalsPages.size)
        assertTrue(vitalsPages.all { it.records.size <= 10 })
        val rows = vitalsPages.flatMap { it.records }
        assertEquals(25, rows.size)
        assertEquals(25, rows.map { it["id"] }.toSet().size)
        assertEquals(25, outcome.upserted)
    }

    // ── self-written records are skipped ──────────────────────────────

    @Test
    fun recordsWrittenByThisAppAreNotEchoedBack() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        val baseline = source(fake).sync(HealthCursor()) {}

        fake.setPackageName(selfPackage)
        fake.insertRecords(listOf(weight(70.0)))
        fake.setPackageName(otherPackage)
        val foreignId = fake.insertRecords(listOf(weight(71.2, t0.plusSeconds(60)))).recordIdsList.single()

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(baseline.cursor) { pages += it }

        val rows = rowsFor(pages, "hc_body")
        assertEquals(1, rows.size)
        assertEquals(JsonPrimitive(foreignId), rows.single()["id"])
        assertEquals(JsonPrimitive(otherPackage), rows.single()["data_origin"])
        assertEquals(1, outcome.upserted)
    }

    @Test
    fun baselineExcludesRecordsWrittenByThisApp() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.setPackageName(selfPackage)
        fake.insertRecords(listOf(weight(70.0)))
        fake.setPackageName(otherPackage)
        val foreignId = fake.insertRecords(listOf(weight(71.2, t0.plusSeconds(60)))).recordIdsList.single()

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(HealthCursor()) { pages += it }

        val rows = rowsFor(pages, "hc_body")
        assertEquals(1, rows.size)
        assertEquals(JsonPrimitive(foreignId), rows.single()["id"])
        assertEquals(JsonPrimitive(otherPackage), rows.single()["data_origin"])
        assertEquals(1, outcome.upserted)
    }

    // ── (k) fan-out shrink ────────────────────────────────────────────

    @Test
    fun rewrittenFanOutRecordIsTombstonedBeforeItsRows() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        val recordId = fake.insertRecords(
            listOf(heartRate(sampleCount = 5, metadata = Metadata.manualEntry("hr-rewrite", 1L))),
        ).recordIdsList.single()
        val baseline = source(fake).sync(HealthCursor()) {}

        // The writing app rewrites the record with fewer samples. Sample-row
        // ids are index-suffixed, so rows :3 and :4 of the old version exist
        // in the table and no longer correspond to anything.
        fake.insertRecords(listOf(heartRate(sampleCount = 3, metadata = Metadata.manualEntry("hr-rewrite", 2L))))

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(baseline.cursor) { pages += it }

        val vitals = pages.filter { it.tableName == "hc_vitals" }
        assertEquals(2, vitals.size)
        val (tombstone, rowsPage) = vitals
        // The tombstone-only page precedes the row page so the gateway wipes
        // every old row of the record before ingesting the fresh fan-out.
        assertTrue(tombstone.records.isEmpty())
        assertEquals(listOf(recordId), tombstone.deletedIds)
        assertEquals("record_id", tombstone.deleteKeyColumn)
        assertEquals(3, rowsPage.records.size)
        assertTrue(rowsPage.deletedIds.isEmpty())
        assertTrue(rowsPage.records.all { it["record_id"] == JsonPrimitive(recordId) })
        assertEquals(3, outcome.upserted)
        assertEquals(0, outcome.deleted)
    }

    // ── (l) multi-page changes drain ──────────────────────────────────

    @Test
    fun multiPageChangesDrainDeliversEveryRowAndAdvancesTheToken() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        val baseline = source(fake).sync(HealthCursor()) {}
        val weightTokenBefore = baseline.cursor.tokenFor("Weight")

        val ids = (0 until 5).flatMap {
            fake.insertRecords(listOf(weight(70.0 + it, t0.plusSeconds(it * 3600L)))).recordIdsList
        }
        fake.pageSizeGetChanges = 2

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(baseline.cursor) { pages += it }

        val rows = rowsFor(pages, "hc_body")
        assertEquals(5, rows.size)
        assertEquals(ids.map { JsonPrimitive(it) }.toSet(), rows.map { it["id"] }.toSet())
        assertEquals(5, outcome.upserted)
        assertNotEquals(weightTokenBefore, outcome.cursor.tokenFor("Weight"))
    }

    // ── (m) mixed upserts + deletions at the page boundary ────────────

    @Test
    fun mixedUpsertsAndDeletionsChunkAtThePageSizeBoundary() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        val oldIds = fake.insertRecords(listOf(weight(70.0), weight(70.5, t0.plusSeconds(3600)))).recordIdsList
        val baseline = source(fake, pageSize = 3).sync(HealthCursor()) {}

        fake.deleteRecords(WeightRecord::class, recordIdsList = oldIds, clientRecordIdsList = emptyList())
        val newIds = (0 until 4).flatMap {
            fake.insertRecords(listOf(weight(68.0 + it, t0.plusSeconds(7200L + it)))).recordIdsList
        }

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake, pageSize = 3).sync(baseline.cursor) { pages += it }

        // Two pre-delete tombstone pages (4 upserted ids chunked at 3), one
        // full row page, one final page with the leftover row + both real
        // deletions — and no empty trailing page.
        val bodyPages = pages.filter { it.tableName == "hc_body" }
        assertEquals(4, bodyPages.size)
        assertTrue(bodyPages.all { it.records.size + it.deletedIds.size in 1..3 })
        // Every upserted row arrived exactly once.
        val rows = bodyPages.flatMap { it.records }
        assertEquals(4, rows.size)
        assertEquals(newIds.map { JsonPrimitive(it) }.toSet(), rows.map { it["id"] }.toSet())
        // Tombstones cover the real deletions plus the pre-deletes of the upserts.
        assertEquals((oldIds + newIds).toSet(), bodyPages.flatMap { it.deletedIds }.toSet())
        // deleteKeyColumn rides only on pages that carry deletions.
        for (page in bodyPages) {
            if (page.deletedIds.isEmpty()) assertNull(page.deleteKeyColumn)
            else assertEquals("record_id", page.deleteKeyColumn)
        }
        assertEquals(4, outcome.upserted)
        assertEquals(2, outcome.deleted)
    }

    // ── (n) baseline read pagination ──────────────────────────────────

    @Test
    fun baselinePagesThroughTheWholeHistory() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords((0 until 25).map { weight(60.0 + it, t0.plusSeconds(it * 3600L)) })

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake, pageSize = 10).sync(HealthCursor()) { pages += it }

        val bodyPages = pages.filter { it.tableName == "hc_body" }
        assertEquals(listOf(10, 10, 5), bodyPages.map { it.records.size })
        assertEquals(25, bodyPages.flatMap { it.records }.map { it["id"] }.toSet().size)
        assertEquals(25, outcome.upserted)
    }

    // ── (o) onPage failure durability ─────────────────────────────────

    @Test
    fun onPageFailureKeepsCompletedTokensButNotTheInFlightOne() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0), steps(8000)))
        val baseline = source(fake).sync(HealthCursor()) {}

        // Weight precedes Steps in the catalog, so its delta completes first.
        // The new Steps record produces two hc_activity pages (pre-delete
        // tombstone, then rows); the upload dies on the second one.
        fake.insertRecords(listOf(weight(69.4, t0.plusSeconds(86400))))
        fake.insertRecords(listOf(steps(9100, t0.plusSeconds(86400))))

        var activityPages = 0
        var thrown: HealthSyncException? = null
        try {
            source(fake).sync(baseline.cursor) { page ->
                if (page.tableName == "hc_activity") {
                    activityPages++
                    if (activityPages == 2) throw IOException("ingest endpoint unreachable")
                }
            }
        } catch (e: HealthSyncException) {
            thrown = e
        }

        assertNotNull(thrown)
        thrown!!
        assertTrue(thrown.cause is IOException)
        // Weight finished its drain before the failure: its advanced token
        // rides the exception cursor.
        assertNotEquals(baseline.cursor.tokenFor("Weight"), thrown.cursor.tokenFor("Weight"))
        // Steps was mid-drain: its token stays at the pre-sync value so the
        // next pass replays the unacknowledged changes.
        assertEquals(baseline.cursor.tokenFor("Steps"), thrown.cursor.tokenFor("Steps"))
    }

    // ── record types unsupported by the device's Health Connect module ──

    @OptIn(ExperimentalMindfulnessSessionApi::class)
    @Test
    fun unsupportedRecordTypeIsSkippedAndTheRestOfTheCatalogStillSyncs() = runTest {
        // The platform-backed client fails at class-link time for record types
        // newer than the device's module (seen live with MindfulnessSessionRecord
        // on the API 35 image, surfacing as a NoSuchMethodError). One bad type
        // must not abort the drain or lose the other types' tokens.
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(71.5)))

        val client = object : HealthConnectClient by fake {
            override suspend fun getChangesToken(request: ChangesTokenRequest): String {
                if (MindfulnessSessionRecord::class in request.recordTypes) {
                    throw NoSuchMethodError("MindfulnessSessionRecord.getMindfulnessSessionType")
                }
                return fake.getChangesToken(request)
            }
        }
        val source = HealthConnectSource(
            client = client,
            accountId = accountId,
            selfPackageName = selfPackage,
            settings = HealthSettings(InMemoryKeyValueStore()),
            clock = { fixedNow },
        )

        val pages = mutableListOf<HealthPage>()
        val outcome = source.sync(HealthCursor()) { pages += it }

        assertTrue("MindfulnessSession" in outcome.skipped)
        assertTrue(outcome.failed.isEmpty())
        assertEquals(1, outcome.upserted)
        assertNotNull(outcome.cursor.tokenFor("Weight"))
        assertNull(outcome.cursor.tokenFor("MindfulnessSession"))
        assertTrue(pages.any { it.tableName == "hc_body" })
    }

    @Test
    fun providerInternalErrorIsReportedWhileHealthyTypesSyncAndRecoveryRetriesTheFailedType() = runTest {
        // The Health Connect provider can hit an internal error serving one record
        // type's read, surfacing client-side as an android.os.RemoteException (seen
        // live for WeightRecord: "while parsing a protocol message…"). One bad type
        // must be skipped, not abort the whole sync into an endless retry.
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(71.5), steps(1200)))

        var failWeight = true
        val client = object : HealthConnectClient by fake {
            override suspend fun getChangesToken(request: ChangesTokenRequest): String {
                if (failWeight && WeightRecord::class in request.recordTypes) {
                    throw RemoteException(
                        "While parsing a protocol message, the input ended unexpectedly in the middle of a field.",
                    )
                }
                return fake.getChangesToken(request)
            }
        }
        val source = HealthConnectSource(
            client = client,
            accountId = accountId,
            selfPackageName = selfPackage,
            settings = HealthSettings(InMemoryKeyValueStore()),
            clock = { fixedNow },
        )

        val pages = mutableListOf<HealthPage>()
        // Must not throw: the bad type is skipped, not fatal.
        val outcome = source.sync(HealthCursor()) { pages += it }

        assertEquals(listOf("Weight"), outcome.failed)
        assertTrue("Weight" !in outcome.skipped)
        assertNull(outcome.cursor.lastFullSyncAt)
        assertNull(outcome.cursor.tokenFor("Weight"))
        // A healthy type still synced through.
        assertNotNull(outcome.cursor.tokenFor("Steps"))
        assertTrue(pages.any { it.tableName == "hc_activity" })

        failWeight = false
        pages.clear()
        val recovered = source.sync(outcome.cursor) { pages += it }
        assertTrue(recovered.failed.isEmpty())
        assertNotNull(recovered.cursor.tokenFor("Weight"))
        assertNotNull(recovered.cursor.lastFullSyncAt)
        assertEquals(1, rowsFor(pages, "hc_body").size)
    }

    @Test
    fun providerFailureKeepsExistingTokenAndLastSuccessfulTimestamp() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        val baseline = source(fake).sync(HealthCursor()) {}
        val weightToken = baseline.cursor.tokenFor("Weight")!!
        fake.insertRecords(listOf(steps(3300)))
        fake.overrides.getChanges = Stub<String, ChangesResponse> { token ->
            if (token == weightToken) throw RemoteException("Provider read failed") else null
        }
        fake.overrides.readRecords = Stub<ReadRecordsRequest<*>, ReadRecordsResponse<*>> { request ->
            if (request.recordType == WeightRecord::class) throw RemoteException("Provider read failed") else null
        }
        val previous = baseline.cursor.copy(lastFullSyncAt = "2029-12-31T00:00:00.000Z")
        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(previous) { pages += it }
        assertEquals(listOf("Weight"), outcome.failed)
        assertEquals(weightToken, outcome.cursor.tokenFor("Weight"))
        assertEquals(previous.lastFullSyncAt, outcome.cursor.lastFullSyncAt)
        assertEquals(1, rowsFor(pages, "hc_activity").size)
    }

    @Test
    fun getChangesProviderErrorReBaselinesTheTypeInsteadOfSkipping() = runTest {
        // Some providers throw the internal "parsing a protocol message" error serving
        // getChanges (delta) for a type while readRecords (baseline) still works for it.
        // The engine must RECOVER by re-baselining — not skip — so data keeps flowing on
        // such devices. Mirrors the expired-token re-baseline path.
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        fake.insertRecords(listOf(weight(70.0), steps(8000)))
        val baseline = source(fake).sync(HealthCursor()) {}
        val weightToken = baseline.cursor.tokenFor("Weight")!!

        // A new weight arrives; getChanges for the weight token throws the provider error,
        // but the baseline read path (getChangesToken + readRecords) is unaffected.
        val newWeightId = fake.insertRecords(listOf(weight(71.5, t0.plusSeconds(3600)))).recordIdsList.single()
        fake.overrides.getChanges = Stub<String, ChangesResponse> { token ->
            if (token == weightToken) {
                throw RemoteException(
                    "While parsing a protocol message, the input ended unexpectedly in the middle of a field.",
                )
            } else {
                null
            }
        }

        val pages = mutableListOf<HealthPage>()
        val outcome = source(fake).sync(baseline.cursor) { pages += it }

        // Recovered via re-baseline: the type is NOT skipped and keeps a fresh token…
        assertTrue("Weight" !in outcome.skipped)
        assertTrue(outcome.failed.isEmpty())
        assertNotNull(outcome.cursor.tokenFor("Weight"))
        // …and the re-baseline re-read the weights via readRecords, including the new one.
        val bodyIds = rowsFor(pages, "hc_body").map { it["record_id"] }
        assertTrue(JsonPrimitive(newWeightId) in bodyIds)
    }

    @Test
    fun baselineTerminatesWhenThePageTokenNeverAdvances() = runTest {
        // A misbehaving provider returns a non-null page token that never advances and
        // keeps re-yielding the same records. Baseline MUST terminate (not loop forever
        // flooding the provider) and emit each record exactly once.
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        val stuck = fake.insertRecords(listOf(weight(70.0))).recordIdsList.single()
        val looping = fake.readRecords(
            ReadRecordsRequest(
                recordType = WeightRecord::class,
                timeRangeFilter = androidx.health.connect.client.time.TimeRangeFilter.before(java.time.Instant.now()),
            ),
        ).records
        fake.overrides.readRecords = Stub<ReadRecordsRequest<*>, ReadRecordsResponse<*>> { req ->
            if (req.recordType == WeightRecord::class) {
                ReadRecordsResponse(looping, pageToken = "never-advances")
            } else {
                ReadRecordsResponse(emptyList<androidx.health.connect.client.records.Record>(), pageToken = null)
            }
        }

        val pages = mutableListOf<HealthPage>()
        // Must return rather than hang; runTest fails the test if it never completes.
        val outcome = source(fake).sync(HealthCursor()) { pages += it }

        // The single weight is emitted exactly once despite the looping page token.
        val bodyRows = rowsFor(pages, "hc_body")
        assertEquals(1, bodyRows.size)
        assertEquals(JsonPrimitive(stuck), bodyRows.single()["record_id"])
        assertNotNull(outcome.cursor.tokenFor("Weight"))
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.content.ContentValues
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.RefusalPolicy
import dev.omnesis.android.transport.SkippedPush
import dev.omnesis.android.transport.MobileSourceActivation
import dev.omnesis.android.transport.dto.SourceRecord
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowContentResolver

/**
 * The coordinator's gateway contract, exercised end-to-end: real
 * [AnalyticsClient]/[DocumentsClient]/[AdminClient] against MockWebServer on
 * one side, a real [PhotosSource] wrapping [FakePhotosProvider] on the
 * other — mirrors `CallLogSyncCoordinatorTest`'s shape.
 */
@RunWith(RobolectricTestRunner::class)
class PhotosSyncCoordinatorTest {

    private lateinit var server: MockWebServer
    private lateinit var provider: FakePhotosProvider
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private val fixedClock: () -> Instant = { Instant.parse("2026-07-05T12:00:00Z") }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        events.clear()
        provider = Robolectric.buildContentProvider(FakePhotosProvider::class.java).create("media").get()
        ShadowContentResolver.registerProviderInternal("media", provider)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun enabledSettings() = PhotosSettings(InMemoryKeyValueStore()).apply { photosEnabled = true }

    private fun coordinator(
        settings: PhotosSettings = enabledSettings(),
        hasPermission: Boolean = true,
        hasFullAccess: Boolean = hasPermission,
        fullAccessCheck: (() -> Boolean)? = null,
        accessGeneration: () -> Long = { 0L },
        analysisCalls: MutableList<AnalysisTier>? = null,
        now: Instant = fixedClock(),
        prepareSync: suspend () -> Unit = {},
    ): PhotosSyncCoordinator {
        val http = GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")
        return PhotosSyncCoordinator(
            sourceFactory = {
                PhotosSource(
                    resolver = ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
                    analyze = { _, tier ->
                        analysisCalls?.add(tier)
                        PhotoAnalysisFragment()
                    },
                )
            },
            analytics = AnalyticsClient(http),
            documents = DocumentsClient(http),
            settings = settings,
            hasPermission = { hasPermission },
            hasFullAccess = fullAccessCheck ?: { hasFullAccess },
            accessGeneration = accessGeneration,
            sendEvent = { type, payload -> synchronized(events) { events += type to payload } },
            clock = { now },
            prepareSync = prepareSync,
        )
    }

    private fun insertImage(dateAddedSec: Long, relativePath: String = "Pictures/Screenshots/") {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DATE_ADDED, dateAddedSec)
            put(MediaStore.Images.Media.DATE_MODIFIED, dateAddedSec)
            put(MediaStore.Images.Media.RELATIVE_PATH, relativePath)
        }
        ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
            .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
    }

    private fun body(request: RecordedRequest): JsonObject =
        OmnesisJson.parseToJsonElement(request.body.readUtf8()).jsonObject

    private fun eventStates(): List<String> =
        synchronized(events) { events.map { it.second["state"]!!.jsonPrimitive.content } }

    private fun enqueueOk(json: String = """{"ok":true}""") {
        server.enqueue(MockResponse().setBody(json))
    }

    @Test
    fun `disabled setting skips without any HTTP call`() = runTest {
        val result = coordinator(settings = PhotosSettings(InMemoryKeyValueStore())).syncNow()
        assertEquals(PhotosSyncCoordinator.SyncResult.Skipped("Photos syncing is disabled"), result)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `missing permission skips without any HTTP call`() = runTest {
        val result = coordinator(hasPermission = false).syncNow()
        assertEquals(PhotosSyncCoordinator.SyncResult.Skipped("Photos permission not granted"), result)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `partition preparation refusal stops before cursor or protected photo reads`() = runTest {
        insertImage(1000)
        val candidates = listOf(
            null,
            SourceRecord(id = "photos:local", type = "photos", deviceId = "other", members = listOf("other"), multiDeviceMode = "partitioned"),
            SourceRecord(id = "photos:local", type = "photos", deviceId = "this", members = listOf("this"), multiDeviceMode = "replicated"),
        )
        val analysisCalls = mutableListOf<AnalysisTier>()
        for (source in candidates) {
            val result = coordinator(analysisCalls = analysisCalls, prepareSync = {
                MobileSourceActivation.prepareHostedPartition(source, "this") { _, _ -> error("must not mutate") }
            }).syncNow()
            assertTrue(result is PhotosSyncCoordinator.SyncResult.Failed)
        }
        assertTrue(coordinator(prepareSync = { throw IllegalStateException("mode upgrade refused") }).syncNow() is PhotosSyncCoordinator.SyncResult.Failed)
        assertEquals(0, server.requestCount)
        assertTrue(analysisCalls.isEmpty())
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun `ordinary startup does not register a missing source before preparation`() = runTest {
        val settings = enabledSettings()
        val c = coordinator(settings, prepareSync = {
            MobileSourceActivation.prepareHostedPartition(null, "this") { _, _ -> error("must not mutate") }
        })
        PhotosIntegration(ApplicationProvider.getApplicationContext(), settings).launchInitialSync(c, this)
        advanceUntilIdle()
        assertEquals(0, server.requestCount)
        assertEquals(listOf("syncing", "error"), eventStates())
    }

    @Test
    fun `an unavailable full-library snapshot is skipped, not turned into a deletion`() = runTest {
        insertImage(1000)
        provider.failSnapshotQuery = true
        val settings = enabledSettings()
        // The cursor read, the page push and the cursor write — a whole
        // ordinary sync. A reconcile would add a fourth.
        enqueueOk("""{"cursor":null}""")
        enqueueOk()
        enqueueOk()

        val result = coordinator(settings).syncNow()

        // The page still lands: an enumeration that could not run says nothing
        // about the photos this cycle just ingested, so failing the sync over
        // it would stop the library being read at all.
        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), result)
        // Nothing was reconciled, and the throttle was not advanced, so the
        // next cycle tries the snapshot again rather than waiting out the
        // interval on a snapshot that never happened.
        assertNull(settings.lastReconcileAt)
        assertEquals(3, server.requestCount)
        assertEquals("GET", server.takeRequest().method)
        assertEquals("/documents", server.takeRequest().path)
        val persisted = body(server.takeRequest())["cursor"]!!

        // The ingestion watermark can advance: deletion reconciliation always
        // scans the whole library, not only assets after that watermark. A
        // deletion during the unavailable scan must still be observed later.
        provider.failSnapshotQuery = false
        ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
            .delete(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, null, null)
        enqueueOk("""{"cursor":$persisted}""")
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"retry"}"""))
        assertTrue(coordinator(settings).syncNow() is PhotosSyncCoordinator.SyncResult.Failed)
        assertNull(settings.lastReconcileAt)
        server.takeRequest()
        val failedSnapshot = server.takeRequest()
        assertEquals("/documents/reconcile", failedSnapshot.path)
        assertEquals(0, body(failedSnapshot)["presentExternalIds"]!!.jsonArray.size)

        // A network failure cannot mark the deletion assessment as complete;
        // even at the same clock instant the next pass resends the full set.
        enqueueOk("""{"cursor":$persisted}""")
        enqueueOk()
        enqueueOk()
        assertEquals(PhotosSyncCoordinator.SyncResult.Success(0), coordinator(settings).syncNow())
        server.takeRequest()
        val recoveredSnapshot = server.takeRequest()
        assertEquals("/documents/reconcile", recoveredSnapshot.path)
        assertEquals(0, body(recoveredSnapshot)["presentExternalIds"]!!.jsonArray.size)
        assertEquals("/sync-state/photos:local", server.takeRequest().path)
        assertEquals(fixedClock(), settings.lastReconcileAt)
    }

    @Test
    fun `a cursor write failure retries the same document instead of losing the page`() = runTest {
        insertImage(1000)
        val settings = enabledSettings().apply { lastReconcileAt = fixedClock() }
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk()
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"unavailable"}"""))
        assertTrue(coordinator(settings).syncNow() is PhotosSyncCoordinator.SyncResult.Failed)
        server.takeRequest()
        val first = body(server.takeRequest())["documents"]!!.jsonArray.single().jsonObject
        server.takeRequest()

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk(); enqueueOk()
        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), coordinator(settings).syncNow())
        server.takeRequest()
        val retry = body(server.takeRequest())["documents"]!!.jsonArray.single().jsonObject
        assertEquals(first["externalId"], retry["externalId"])
        assertEquals(first["contentHash"], retry["contentHash"])
    }

    @Test
    fun `a successful no-change pass persists a fresh sync timestamp`() = runTest {
        insertImage(1000)
        val settings = enabledSettings().apply { lastReconcileAt = fixedClock() }
        enqueueOk("""{"cursor":{"phase":"STEADY","lastAssetDateAddedSec":1000,"lastAssetId":"1"},"lastSyncedAt":"2026-07-04T12:00:00Z"}""")
        enqueueOk()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(0), coordinator(settings).syncNow())

        assertEquals(2, server.requestCount)
        assertEquals("GET", server.takeRequest().method)
        val heartbeat = server.takeRequest()
        assertEquals("/sync-state/photos:local", heartbeat.path)
        assertEquals("STEADY", body(heartbeat)["cursor"]!!.jsonObject["phase"]!!.jsonPrimitive.content)
        assertEquals(listOf("syncing", "completed"), eventStates())
    }

    @Test
    fun `a reset member cursor replays local photos after detach and rejoin`() = runTest {
        insertImage(1000)
        val settings = enabledSettings().apply { lastReconcileAt = fixedClock() }
        enqueueOk("""{"cursor":{"phase":"STEADY","lastAssetDateAddedSec":1000,"lastAssetId":"1"}}""")
        enqueueOk()
        assertEquals(PhotosSyncCoordinator.SyncResult.Success(0), coordinator(settings).syncNow())
        assertEquals(2, server.requestCount)
        server.takeRequest()
        server.takeRequest()

        // A per-member resync/detach clears only this device's gateway cursor.
        // The local MediaStore remains the authoritative source of its photos.
        enqueueOk("""{"cursor":null}""")
        enqueueOk(); enqueueOk()
        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), coordinator(settings).syncNow())
        server.takeRequest()
        val document = body(server.takeRequest())["documents"]!!.jsonArray.single().jsonObject
        assertEquals("1", document["externalId"]!!.jsonPrimitive.content)
    }



    @Test
    fun `first sync pushes documents, reconciles since never reconciled before, and persists the cursor`() = runTest {
        insertImage(1_000)

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk("""{"deleted":0,"deletedIds":[]}""")
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), result)
        assertEquals(4, server.requestCount)

        val get = server.takeRequest()
        assertEquals("GET", get.method)
        assertEquals("/sync-state/photos:local", get.path)

        val documentsIngest = body(server.takeRequest())
        assertEquals(1, documentsIngest["documents"]!!.jsonArray.size)

        val reconcile = body(server.takeRequest())
        assertEquals("photos:local", reconcile["sourceId"]!!.jsonPrimitive.content)
        assertEquals(1, reconcile["presentExternalIds"]!!.jsonArray.size)

        val setState = server.takeRequest()
        assertEquals("POST", setState.method)
        assertEquals("/sync-state/photos:local", setState.path)
        assertEquals("Photos", body(setState)["label"]!!.jsonPrimitive.content)

        assertEquals(listOf("syncing", "completed"), eventStates())
    }

    @Test
    fun `reconcile is skipped when already run within the last day`() = runTest {
        insertImage(1_000)
        val settings = enabledSettings().apply { lastReconcileAt = fixedClock().minusSeconds(3600) }

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk()

        val result = coordinator(settings).syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), result)
        assertEquals(3, server.requestCount) // GET sync-state, documents ingest, set sync-state — no reconcile
    }

    @Test
    fun `limited photo access syncs visible assets but never reconciles hidden assets`() = runTest {
        val settings = enabledSettings()
        insertImage(1_000)
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk()

        val result = coordinator(settings, hasPermission = true, hasFullAccess = false).syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), result)
        assertEquals(3, server.requestCount)
        assertNull(settings.lastReconcileAt)
        server.takeRequest()
        server.takeRequest()
        assertEquals("/sync-state/photos:local", server.takeRequest().path)
    }

    @Test
    fun `first full observation resets a legacy steady cursor and indexes older visible assets`() = runTest {
        val settings = enabledSettings().apply { lastReconcileAt = fixedClock() }
        insertImage(1_000)
        val generation = settings.observeAccess(PhotosAccess.FULL)
        assertEquals(1L, generation)
        server.enqueue(
            MockResponse().setBody(
                """{"cursor":{"phase":"STEADY","lastAssetDateAddedSec":9000,"lastAssetId":"9000","backfillCompletedAt":"2026-07-01T00:00:00Z"},"lastSyncedAt":"2026-07-05T12:00:00Z"}""",
            ),
        )
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk("""{"deleted":0,"deletedIds":[]}""")
        enqueueOk()

        val tiers = mutableListOf<AnalysisTier>()
        val result = coordinator(
            settings,
            accessGeneration = { settings.accessGeneration },
            analysisCalls = tiers,
        ).syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), result)
        server.takeRequest() // GET legacy sync-state
        val ingest = body(server.takeRequest())
        assertEquals(1, ingest["documents"]!!.jsonArray.size)
        assertEquals(listOf(AnalysisTier.NEW), tiers)
        server.takeRequest() // full-library reconcile after access expansion
        val persisted = body(server.takeRequest())["cursor"]!!.jsonObject
        assertEquals(1L, persisted["accessGeneration"]!!.jsonPrimitive.content.toLong())
        assertEquals("RECENT", persisted["phase"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an access expansion during a sync cannot persist the old generation cursor`() = runTest {
        insertImage(1_000)
        var generation = 0L
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk()

        val result = coordinator(
            fullAccessCheck = {
                generation = 1L
                false
            },
            accessGeneration = { generation },
        ).syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), result)
        server.takeRequest()
        server.takeRequest()
        val persisted = body(server.takeRequest())["cursor"]!!.jsonObject
        assertEquals(1L, persisted["accessGeneration"]!!.jsonPrimitive.content.toLong())
        assertEquals("SCREENSHOTS", persisted["phase"]!!.jsonPrimitive.content)
    }

    @Test
    fun `full access lost during reconcile enumeration never sends a deletion snapshot`() = runTest {
        val settings = enabledSettings()
        insertImage(1_000)
        val checks = ArrayDeque(listOf(true, false))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk()

        val result = coordinator(
            settings = settings,
            fullAccessCheck = { checks.removeFirst() },
        ).syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), result)
        assertEquals(3, server.requestCount)
        assertNull(settings.lastReconcileAt)
        server.takeRequest()
        server.takeRequest()
        assertEquals("/sync-state/photos:local", server.takeRequest().path)
    }

    @Test
    fun `a paused source stops the drain without disabling local syncing`() = runTest {
        insertImage(1_000)
        val settings = enabledSettings()

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"photos:local","reason":"paused"}]}""")

        val result = coordinator(settings).syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.SourcePaused("Photos is paused in Omnesis"), result)
        assertTrue(settings.photosEnabled)
    }

    @Test
    fun `a removed source disables local syncing`() = runTest {
        insertImage(1_000)
        val settings = enabledSettings()

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"photos:local","reason":"removed"}]}""")

        val result = coordinator(settings).syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.SourceRemoved("Photos was removed in Omnesis"), result)
        assertEquals(false, settings.photosEnabled)
    }

    // ── giving up on a page the gateway will never accept ──────────────

    /**
     * One pass whose documents push the gateway answers with [status]. Set
     * [advances] for the pass expected to give up — it writes the cursor.
     */
    private suspend fun refusedPass(
        settings: PhotosSettings,
        at: Instant,
        status: Int = 400,
        advances: Boolean = false,
    ): PhotosSyncCoordinator.SyncResult {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":"refused"}"""))
        if (advances) enqueueOk()
        return coordinator(settings, now = at).syncNow()
    }

    /** Every cursor written back to `/sync-state` so far. Drains the recorded requests. */
    private fun persistedCursors(): List<JsonObject> {
        val cursors = mutableListOf<JsonObject>()
        repeat(server.requestCount) {
            val request = server.takeRequest()
            if (request.method == "POST" && request.path == "/sync-state/photos:local") {
                cursors += body(request)["cursor"]!!.jsonObject
            }
        }
        return cursors
    }

    @Test
    fun `a refused page is skipped once the budget and the grace window are spent, and the phase moves on`() = runTest {
        insertImage(1_000)
        // A photo the phase AFTER screenshots will carry, dated inside the
        // recent window the source computes from its own clock.
        insertImage(Instant.now().epochSecond - 3_600, relativePath = "Pictures/Camera/")
        val settings = enabledSettings().apply { lastReconcileAt = fixedClock() }
        val firstRefusalAt = fixedClock()

        repeat(RefusalPolicy.MAX_REFUSALS) {
            val result = refusedPass(settings, firstRefusalAt)
            assertEquals(false, (result as PhotosSyncCoordinator.SyncResult.Failed).retryable)
        }

        // The budget is spent but the grace window is not: a fix on the gateway
        // has not had its chance yet, so nothing is skipped and no cursor moves.
        assertEquals(RefusalPolicy.MAX_REFUSALS, settings.pushRefusals.openRun?.count)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)

        refusedPass(settings, firstRefusalAt.plus(RefusalPolicy.GRACE), advances = true)

        assertNull(settings.pushRefusals.openRun)
        val skipped = settings.pushRefusals.skipped.single()
        assertEquals(PhotosSyncCoordinator.SOURCE_ID, skipped.sourceId)
        assertEquals(RefusalPolicy.MAX_REFUSALS + 1, skipped.refusals)
        assertTrue("names the page it skipped: ${skipped.unit}", skipped.unit.contains("1 photo in the screenshots pass"))

        // The cursor advanced past the refused page into the next phase —
        // exactly one advance, on the pass that gave up.
        val cursor = persistedCursors().single()
        assertEquals("RECENT", cursor["phase"]!!.jsonPrimitive.content)

        // And the phase machine keeps going: the next pass carries the page
        // behind the one that was skipped.
        enqueueOk("""{"cursor":$cursor,"lastSyncedAt":"2026-07-05T12:00:00Z"}""")
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk()

        val result = coordinator(settings, now = firstRefusalAt.plus(RefusalPolicy.GRACE)).syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(1), result)
    }

    @Test
    fun `an outage never costs data however long it lasts`() = runTest {
        insertImage(1_000)
        val settings = enabledSettings().apply { lastReconcileAt = fixedClock() }

        // Well past both the attempt budget and the grace window.
        repeat(RefusalPolicy.MAX_REFUSALS * 3) { attempt ->
            val at = fixedClock().plus(RefusalPolicy.GRACE.multipliedBy(attempt.toLong()))
            val result = refusedPass(settings, at, status = 503)
            assertEquals(true, (result as PhotosSyncCoordinator.SyncResult.Failed).retryable)
        }

        assertNull(settings.pushRefusals.openRun)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)
        assertEquals(emptyList<JsonObject>(), persistedCursors())
    }

    @Test
    fun `a rate-limited push is a retry, not a verdict on the payload`() = runTest {
        insertImage(1_000)
        val settings = enabledSettings().apply { lastReconcileAt = fixedClock() }

        repeat(RefusalPolicy.MAX_REFUSALS * 2) { attempt ->
            val at = fixedClock().plus(RefusalPolicy.GRACE.multipliedBy(attempt.toLong()))
            val result = refusedPass(settings, at, status = 429)
            assertEquals(true, (result as PhotosSyncCoordinator.SyncResult.Failed).retryable)
        }

        assertNull(settings.pushRefusals.openRun)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)
        assertEquals(emptyList<JsonObject>(), persistedCursors())
    }

    @Test
    fun `an empty library still reconciles (first ever pass) but skips the documents push`() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"deleted":0,"deletedIds":[]}""")
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(PhotosSyncCoordinator.SyncResult.Success(0), result)
        assertEquals(3, server.requestCount)
        server.takeRequest() // GET sync-state
        val reconcile = body(server.takeRequest())
        assertEquals(0, reconcile["presentExternalIds"]!!.jsonArray.size)
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.content.ContentValues
import android.provider.CallLog
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.RefusalPolicy
import dev.omnesis.android.transport.SkippedPush
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import java.time.Instant
import kotlinx.coroutines.test.runTest
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
 * one side, a real [CallLogSource] wrapping [FakeCallLogProvider] on the
 * other — mirrors `HealthSyncCoordinatorTest`'s shape.
 */
@RunWith(RobolectricTestRunner::class)
class CallLogSyncCoordinatorTest {

    private lateinit var server: MockWebServer
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private val t0: Instant = Instant.parse("2026-03-04T12:00:00Z")

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        events.clear()
        val provider = Robolectric.buildContentProvider(FakeCallLogProvider::class.java).create("call_log").get()
        ShadowContentResolver.registerProviderInternal("call_log", provider)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun enabledSettings() = CallLogSettings(InMemoryKeyValueStore()).apply { callLogEnabled = true }

    private fun coordinator(
        settings: CallLogSettings = enabledSettings(),
        hasPermission: Boolean = true,
        now: Instant = t0,
    ): CallLogSyncCoordinator {
        val http = GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")
        return CallLogSyncCoordinator(
            sourceFactory = {
                CallLogSource(ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver)
            },
            analytics = AnalyticsClient(http),
            documents = DocumentsClient(http),
            settings = settings,
            hasPermission = { hasPermission },
            sendEvent = { type, payload -> synchronized(events) { events += type to payload } },
            clock = { now },
        )
    }

    private fun insertCall(number: String, dateMillis: Long) {
        val values = ContentValues().apply {
            put(CallLog.Calls.NUMBER, number)
            put(CallLog.Calls.DATE, dateMillis)
            put(CallLog.Calls.DURATION, 30)
            put(CallLog.Calls.TYPE, CallLog.Calls.INCOMING_TYPE)
            put(CallLog.Calls.COUNTRY_ISO, "US")
            put(CallLog.Calls.NUMBER_PRESENTATION, CallLog.Calls.PRESENTATION_ALLOWED)
        }
        ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver
            .insert(CallLog.Calls.CONTENT_URI, values)
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
        val result = coordinator(settings = CallLogSettings(InMemoryKeyValueStore())).syncNow()
        assertEquals(CallLogSyncCoordinator.SyncResult.Skipped("Call Log syncing is disabled"), result)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `missing permission skips without any HTTP call`() = runTest {
        val result = coordinator(hasPermission = false).syncNow()
        assertEquals(CallLogSyncCoordinator.SyncResult.Skipped("READ_CALL_LOG permission not granted"), result)
        assertEquals(0, server.requestCount)
    }



    @Test
    fun `first sync pushes analytics rows then documents then reconciles, and persists the cursor`() = runTest {
        insertCall("+14155552671", 1_772_618_400_000L)

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk("""{"deleted":0,"deletedIds":[]}""")
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(CallLogSyncCoordinator.SyncResult.Success(2), result)
        assertEquals(5, server.requestCount)

        val get = server.takeRequest()
        assertEquals("GET", get.method)
        assertEquals("/sync-state/android-call-log:local", get.path)

        val analyticsIngest = body(server.takeRequest())
        assertEquals("android_call_log", analyticsIngest["tableName"]!!.jsonPrimitive.content)
        assertEquals("android-call-log:local", analyticsIngest["sourceId"]!!.jsonPrimitive.content)
        assertEquals(1, analyticsIngest["records"]!!.jsonArray.size)

        val documentsIngest = body(server.takeRequest())
        assertEquals(1, documentsIngest["documents"]!!.jsonArray.size)
        assertEquals(
            "call-log:2026-03-04",
            documentsIngest["documents"]!!.jsonArray[0].jsonObject["externalId"]!!.jsonPrimitive.content,
        )

        val reconcile = body(server.takeRequest())
        assertEquals("android-call-log:local", reconcile["sourceId"]!!.jsonPrimitive.content)
        assertEquals(listOf("call-log:2026-03-04"), reconcile["presentExternalIds"]!!.jsonArray.map { it.jsonPrimitive.content })

        val setState = server.takeRequest()
        assertEquals("POST", setState.method)
        assertEquals("/sync-state/android-call-log:local", setState.path)
        assertEquals("Android Call Log", body(setState)["label"]!!.jsonPrimitive.content)

        assertEquals(listOf("syncing", "completed"), eventStates())
    }

    @Test
    fun `a paused source stops the drain without disabling local syncing`() = runTest {
        insertCall("+14155552671", 1_772_618_400_000L)
        val settings = enabledSettings()

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"android-call-log:local","reason":"paused"}]}""")

        val result = coordinator(settings).syncNow()

        assertEquals(CallLogSyncCoordinator.SyncResult.SourcePaused("Call Log is paused in Omnesis"), result)
        assertEquals(true, settings.callLogEnabled)
    }

    @Test
    fun `a removed source disables local syncing`() = runTest {
        insertCall("+14155552671", 1_772_618_400_000L)
        val settings = enabledSettings()

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"android-call-log:local","reason":"removed"}]}""")

        val result = coordinator(settings).syncNow()

        assertEquals(CallLogSyncCoordinator.SyncResult.SourceRemoved("Call Log was removed in Omnesis"), result)
        assertEquals(false, settings.callLogEnabled)
    }

    // ── giving up on a window the gateway will never accept ────────────

    /**
     * One pass whose analytics push the gateway answers with [status]. Set
     * [advances] for the pass expected to give up — it writes the cursor.
     */
    private suspend fun refusedPass(
        settings: CallLogSettings,
        at: Instant,
        status: Int = 400,
        advances: Boolean = false,
    ): CallLogSyncCoordinator.SyncResult {
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
            if (request.method == "POST" && request.path == "/sync-state/android-call-log:local") {
                cursors += body(request)["cursor"]!!.jsonObject
            }
        }
        return cursors
    }

    @Test
    fun `a refused window is skipped once the budget and the grace window are spent, and later calls flow`() = runTest {
        val refusedCallAt = 1_772_618_400_000L // 2026-03-04T10:00:00Z
        insertCall("+15550100111", refusedCallAt)
        val settings = enabledSettings()

        repeat(RefusalPolicy.MAX_REFUSALS) {
            val result = refusedPass(settings, t0)
            assertEquals(false, (result as CallLogSyncCoordinator.SyncResult.Failed).retryable)
        }

        // The budget is spent but the grace window is not: a fix on the gateway
        // has not had its chance yet, so nothing is skipped and no cursor moves.
        assertEquals(RefusalPolicy.MAX_REFUSALS, settings.pushRefusals.openRun?.count)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)

        refusedPass(settings, t0.plus(RefusalPolicy.GRACE), advances = true)

        assertNull(settings.pushRefusals.openRun)
        val skipped = settings.pushRefusals.skipped.single()
        assertEquals(CallLogSyncCoordinator.SOURCE_ID, skipped.sourceId)
        assertEquals(RefusalPolicy.MAX_REFUSALS + 1, skipped.refusals)
        assertTrue("names what it skipped: ${skipped.unit}", skipped.unit.startsWith("1 call from the start of the call log"))

        // The watermark advanced past the refused window — exactly once, on the
        // pass that gave up.
        val cursor = persistedCursors().single()
        assertEquals(refusedCallAt.toString(), cursor["lastDateMillis"]!!.jsonPrimitive.content)

        // A call logged after it now syncs, and the refused one is not re-sent.
        insertCall("+15550100222", refusedCallAt + 3_600_000)
        enqueueOk("""{"cursor":$cursor,"lastSyncedAt":"2026-03-04T11:00:00Z"}""")
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk("""{"deleted":0,"deletedIds":[]}""")
        enqueueOk()

        val result = coordinator(settings, now = t0.plus(RefusalPolicy.GRACE)).syncNow()

        assertEquals(CallLogSyncCoordinator.SyncResult.Success(2), result)
        server.takeRequest() // GET sync-state
        val analyticsIngest = body(server.takeRequest())
        assertEquals(1, analyticsIngest["records"]!!.jsonArray.size)
    }

    @Test
    fun `an outage never costs data however long it lasts`() = runTest {
        insertCall("+15550100111", 1_772_618_400_000L)
        val settings = enabledSettings()

        // Well past both the attempt budget and the grace window.
        repeat(RefusalPolicy.MAX_REFUSALS * 3) { attempt ->
            val at = t0.plus(RefusalPolicy.GRACE.multipliedBy(attempt.toLong()))
            val result = refusedPass(settings, at, status = 503)
            assertEquals(true, (result as CallLogSyncCoordinator.SyncResult.Failed).retryable)
        }

        assertNull(settings.pushRefusals.openRun)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)
        assertEquals(emptyList<JsonObject>(), persistedCursors())
    }

    @Test
    fun `a rate-limited push is a retry, not a verdict on the payload`() = runTest {
        insertCall("+15550100111", 1_772_618_400_000L)
        val settings = enabledSettings()

        repeat(RefusalPolicy.MAX_REFUSALS * 2) { attempt ->
            val at = t0.plus(RefusalPolicy.GRACE.multipliedBy(attempt.toLong()))
            val result = refusedPass(settings, at, status = 429)
            assertEquals(true, (result as CallLogSyncCoordinator.SyncResult.Failed).retryable)
        }

        assertNull(settings.pushRefusals.openRun)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)
        assertEquals(emptyList<JsonObject>(), persistedCursors())
    }

    @Test
    fun `an empty sync still reconciles but skips the analytics and documents push`() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"deleted":0,"deletedIds":[]}""")
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(CallLogSyncCoordinator.SyncResult.Success(0), result)
        assertEquals(3, server.requestCount)
        server.takeRequest() // GET sync-state
        val reconcile = body(server.takeRequest())
        assertEquals(0, reconcile["presentExternalIds"]!!.jsonArray.size)
    }
}

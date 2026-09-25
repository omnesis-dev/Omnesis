// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import android.app.Application
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
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
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * The coordinator's gateway contract, exercised end-to-end: real
 * [AnalyticsClient]/[DocumentsClient]/[AdminClient] against MockWebServer on
 * one side, a real [AppUsageSource] wrapping Robolectric's
 * `ShadowUsageStatsManager` on the other — mirrors
 * `CallLogSyncCoordinatorTest`'s shape.
 */
@Suppress("DEPRECATION") // MOVE_TO_FOREGROUND/MOVE_TO_BACKGROUND — see AppUsageSource.kindFor.
@RunWith(RobolectricTestRunner::class)
class AppUsageSyncCoordinatorTest {

    private lateinit var server: MockWebServer
    private lateinit var usageStatsManager: UsageStatsManager
    private val events = mutableListOf<Pair<String, JsonObject>>()

    private val day1Start = 1_772_582_400_000L

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        events.clear()
        val context = ApplicationProvider.getApplicationContext<Application>()
        usageStatsManager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun enabledSettings() = AppUsageSettings(InMemoryKeyValueStore()).apply { appUsageEnabled = true }

    private fun coordinator(
        settings: AppUsageSettings = enabledSettings(),
        hasUsageAccess: Boolean = true,
        nowMillis: Long = day1Start + 90_000,
    ): AppUsageSyncCoordinator {
        val http = GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")
        return AppUsageSyncCoordinator(
            sourceFactory = {
                AppUsageSource(usageStatsManager, labelResolver = { "Example Notes" }, clock = { nowMillis })
            },
            analytics = AnalyticsClient(http),
            documents = DocumentsClient(http),
            settings = settings,
            hasUsageAccess = { hasUsageAccess },
            sendEvent = { type, payload -> synchronized(events) { events += type to payload } },
            clock = { Instant.ofEpochMilli(nowMillis) },
        )
    }

    private fun addEvent(pkg: String, t: Long, type: Int) = shadowOf(usageStatsManager).addEvent(pkg, t, type)

    private fun body(request: RecordedRequest): JsonObject =
        OmnesisJson.parseToJsonElement(request.body.readUtf8()).jsonObject

    private fun eventStates(): List<String> =
        synchronized(events) { events.map { it.second["state"]!!.jsonPrimitive.content } }

    private fun enqueueOk(json: String = """{"ok":true}""") {
        server.enqueue(MockResponse().setBody(json))
    }

    @Test
    fun `disabled setting skips without any HTTP call`() = runTest {
        val result = coordinator(settings = AppUsageSettings(InMemoryKeyValueStore())).syncNow()
        assertEquals(AppUsageSyncCoordinator.SyncResult.Skipped("App Usage syncing is disabled"), result)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `missing usage access skips without any HTTP call`() = runTest {
        val result = coordinator(hasUsageAccess = false).syncNow()
        assertEquals(AppUsageSyncCoordinator.SyncResult.Skipped("Usage access not granted"), result)
        assertEquals(0, server.requestCount)
    }



    @Test
    fun `first sync pushes each analytics table then documents and persists the cursor`() = runTest {
        addEvent("com.example.notes", day1Start + 1_000, UsageEvents.Event.MOVE_TO_FOREGROUND)
        addEvent("com.example.notes", day1Start + 61_000, UsageEvents.Event.MOVE_TO_BACKGROUND)

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(AppUsageSyncCoordinator.SyncResult.Success(3), result)
        assertEquals(5, server.requestCount)

        val get = server.takeRequest()
        assertEquals("GET", get.method)
        assertEquals("/sync-state/android-app-usage:local", get.path)

        val sessionIngest = body(server.takeRequest())
        assertEquals("android_app_usage_sessions", sessionIngest["tableName"]!!.jsonPrimitive.content)
        assertEquals("android_app_usage_sessions", sessionIngest["schema"]!!.jsonObject["tableName"]!!.jsonPrimitive.content)
        assertEquals("android-app-usage:local", sessionIngest["sourceId"]!!.jsonPrimitive.content)
        val sessionRecord = sessionIngest["records"]!!.jsonArray.single().jsonObject
        assertEquals(
            setOf("id", "package_name", "app_name", "start_time", "end_time", "duration_seconds", "date"),
            sessionRecord.keys,
        )

        val dailyIngest = body(server.takeRequest())
        assertEquals("android_app_usage_daily", dailyIngest["tableName"]!!.jsonPrimitive.content)
        assertEquals("android_app_usage_daily", dailyIngest["schema"]!!.jsonObject["tableName"]!!.jsonPrimitive.content)
        assertEquals("android-app-usage:local", dailyIngest["sourceId"]!!.jsonPrimitive.content)
        val dailyRecord = dailyIngest["records"]!!.jsonArray.single().jsonObject
        assertEquals(
            setOf("id", "package_name", "app_name", "date", "total_seconds", "session_count"),
            dailyRecord.keys,
        )

        val documentsIngest = body(server.takeRequest())
        assertEquals(1, documentsIngest["documents"]!!.jsonArray.size)
        assertEquals(
            "attention-timeline:2026-03-04",
            documentsIngest["documents"]!!.jsonArray[0].jsonObject["externalId"]!!.jsonPrimitive.content,
        )

        val setState = server.takeRequest()
        assertEquals("POST", setState.method)
        assertEquals("/sync-state/android-app-usage:local", setState.path)
        assertEquals("Android App Usage", body(setState)["label"]!!.jsonPrimitive.content)

        assertEquals(listOf("syncing", "completed"), eventStates())
    }

    @Test
    fun `a daily analytics failure retries stable rows before advancing the cursor`() = runTest {
        addEvent("com.example.notes", day1Start + 1_000, UsageEvents.Event.MOVE_TO_FOREGROUND)
        addEvent("com.example.notes", day1Start + 61_000, UsageEvents.Event.MOVE_TO_BACKGROUND)
        val c = coordinator()

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""")
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"temporary failure"}"""))

        val failed = c.syncNow()

        assertEquals(AppUsageSyncCoordinator.SyncResult.Failed("server error 500", retryable = true), failed)
        assertEquals(3, server.requestCount)

        val firstStateRead = server.takeRequest()
        assertEquals("GET", firstStateRead.method)
        val firstSessionIngest = body(server.takeRequest())
        assertEquals("android_app_usage_sessions", firstSessionIngest["tableName"]!!.jsonPrimitive.content)
        val firstSessionId = firstSessionIngest["records"]!!.jsonArray.single().jsonObject["id"]!!.jsonPrimitive.content
        val failedDailyIngest = body(server.takeRequest())
        assertEquals("android_app_usage_daily", failedDailyIngest["tableName"]!!.jsonPrimitive.content)

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk()

        val recovered = c.syncNow()

        assertEquals(AppUsageSyncCoordinator.SyncResult.Success(3), recovered)
        assertEquals("GET", server.takeRequest().method)
        val retriedSessionIngest = body(server.takeRequest())
        val retriedSessionId = retriedSessionIngest["records"]!!.jsonArray.single().jsonObject["id"]!!.jsonPrimitive.content
        assertEquals(firstSessionId, retriedSessionId)
        assertEquals("android_app_usage_daily", body(server.takeRequest())["tableName"]!!.jsonPrimitive.content)
        assertEquals("/documents", server.takeRequest().path)
        val cursorWrite = server.takeRequest()
        assertEquals("POST", cursorWrite.method)
        assertEquals("/sync-state/android-app-usage:local", cursorWrite.path)
        assertEquals(listOf("syncing", "error", "syncing", "completed"), eventStates())
    }

    @Test
    fun `a paused source stops the drain without disabling local syncing`() = runTest {
        addEvent("com.example.notes", day1Start + 1_000, UsageEvents.Event.MOVE_TO_FOREGROUND)
        addEvent("com.example.notes", day1Start + 61_000, UsageEvents.Event.MOVE_TO_BACKGROUND)
        val settings = enabledSettings()

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"android-app-usage:local","reason":"paused"}]}""")

        val result = coordinator(settings).syncNow()

        assertEquals(AppUsageSyncCoordinator.SyncResult.SourcePaused("App Usage is paused in Omnesis"), result)
        assertEquals(true, settings.appUsageEnabled)
    }

    @Test
    fun `a removed source disables local syncing`() = runTest {
        addEvent("com.example.notes", day1Start + 1_000, UsageEvents.Event.MOVE_TO_FOREGROUND)
        addEvent("com.example.notes", day1Start + 61_000, UsageEvents.Event.MOVE_TO_BACKGROUND)
        val settings = enabledSettings()

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"android-app-usage:local","reason":"removed"}]}""")

        val result = coordinator(settings).syncNow()

        assertEquals(AppUsageSyncCoordinator.SyncResult.SourceRemoved("App Usage was removed in Omnesis"), result)
        assertEquals(false, settings.appUsageEnabled)
    }

    // ── giving up on a window the gateway will never accept ────────────

    private fun usageBurst() {
        addEvent("com.example.notes", day1Start + 1_000, UsageEvents.Event.MOVE_TO_FOREGROUND)
        addEvent("com.example.notes", day1Start + 61_000, UsageEvents.Event.MOVE_TO_BACKGROUND)
    }

    /**
     * One pass whose analytics push the gateway answers with [status]. Set
     * [advances] for the pass expected to give up — it writes the cursor.
     */
    private suspend fun refusedPass(
        settings: AppUsageSettings,
        atMillis: Long,
        status: Int = 400,
        advances: Boolean = false,
    ): AppUsageSyncCoordinator.SyncResult {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":"refused"}"""))
        if (advances) enqueueOk()
        return coordinator(settings, nowMillis = atMillis).syncNow()
    }

    /** Every cursor written back to `/sync-state` so far. Drains the recorded requests. */
    private fun persistedCursors(): List<JsonObject> {
        val cursors = mutableListOf<JsonObject>()
        repeat(server.requestCount) {
            val request = server.takeRequest()
            if (request.method == "POST" && request.path == "/sync-state/android-app-usage:local") {
                cursors += body(request)["cursor"]!!.jsonObject
            }
        }
        return cursors
    }

    @Test
    fun `a refused window is skipped once the budget and the grace window are spent, and stops widening`() = runTest {
        usageBurst()
        val settings = enabledSettings()
        val firstRefusalAt = day1Start + 90_000

        repeat(RefusalPolicy.MAX_REFUSALS) {
            val result = refusedPass(settings, firstRefusalAt)
            assertEquals(false, (result as AppUsageSyncCoordinator.SyncResult.Failed).retryable)
        }

        // The budget is spent but the grace window is not: a fix on the gateway
        // has not had its chance yet, so nothing is skipped and no cursor moves.
        assertEquals(RefusalPolicy.MAX_REFUSALS, settings.pushRefusals.openRun?.count)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)

        val giveUpAt = firstRefusalAt + RefusalPolicy.GRACE.toMillis()
        refusedPass(settings, giveUpAt, advances = true)

        assertNull(settings.pushRefusals.openRun)
        val skipped = settings.pushRefusals.skipped.single()
        assertEquals(AppUsageSyncCoordinator.SOURCE_ID, skipped.sourceId)
        assertEquals(RefusalPolicy.MAX_REFUSALS + 1, skipped.refusals)
        assertTrue("names what it skipped: ${skipped.unit}", skipped.unit.contains("app-usage rows between the start of the usage history"))

        // The window's start moved to its end, so the next query covers only
        // what happened since — the widening stops here.
        val cursor = persistedCursors().single()
        assertEquals(giveUpAt.toString(), cursor["lastQueriedThroughMillis"]!!.jsonPrimitive.content)

        val requestsBefore = server.requestCount
        enqueueOk("""{"cursor":$cursor,"lastSyncedAt":"2026-03-04T12:00:00Z"}""")
        enqueueOk()

        val result = coordinator(settings, nowMillis = giveUpAt + 1_000).syncNow()

        // The whole pass is a state read and a state write: no ingest, because
        // the refused events are behind the cursor now.
        assertEquals(AppUsageSyncCoordinator.SyncResult.Success(0), result)
        assertEquals(2, server.requestCount - requestsBefore)
    }

    @Test
    fun `an outage never costs data however long it lasts`() = runTest {
        usageBurst()
        val settings = enabledSettings()

        // Well past both the attempt budget and the grace window.
        repeat(RefusalPolicy.MAX_REFUSALS * 3) { attempt ->
            val at = day1Start + 90_000 + attempt * RefusalPolicy.GRACE.toMillis()
            val result = refusedPass(settings, at, status = 503)
            assertEquals(true, (result as AppUsageSyncCoordinator.SyncResult.Failed).retryable)
        }

        assertNull(settings.pushRefusals.openRun)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)
        assertEquals(emptyList<JsonObject>(), persistedCursors())
    }

    @Test
    fun `a rate-limited push is a retry, not a verdict on the payload`() = runTest {
        usageBurst()
        val settings = enabledSettings()

        repeat(RefusalPolicy.MAX_REFUSALS * 2) { attempt ->
            val at = day1Start + 90_000 + attempt * RefusalPolicy.GRACE.toMillis()
            val result = refusedPass(settings, at, status = 429)
            assertEquals(true, (result as AppUsageSyncCoordinator.SyncResult.Failed).retryable)
        }

        assertNull(settings.pushRefusals.openRun)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)
        assertEquals(emptyList<JsonObject>(), persistedCursors())
    }

    @Test
    fun `an empty sync skips the analytics and documents push but still persists the cursor`() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(AppUsageSyncCoordinator.SyncResult.Success(0), result)
        assertEquals(2, server.requestCount)
    }
}

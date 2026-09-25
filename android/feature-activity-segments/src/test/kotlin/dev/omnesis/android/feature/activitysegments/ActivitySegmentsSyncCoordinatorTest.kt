// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.RefusalPolicy
import dev.omnesis.android.transport.PushHealth
import dev.omnesis.android.transport.RetryOutcome
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.QueueDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The coordinator's gateway contract, exercised end-to-end: real
 * [AnalyticsClient]/[DocumentsClient]/[AdminClient] against MockWebServer,
 * a real [ActivityTransitionBuffer]/[ActivitySegmentsHistoryStore] backed by
 * Robolectric SQLite — mirrors `CallLogSyncCoordinatorTest`'s shape.
 */
@RunWith(RobolectricTestRunner::class)
class ActivitySegmentsSyncCoordinatorTest {

    private lateinit var server: MockWebServer
    private lateinit var buffer: ActivityTransitionBuffer
    private lateinit var history: ActivitySegmentsHistoryStore
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private val syncReads = AtomicInteger()
    private var stateResponseStatus = 200
    private var stateResponse = """{"cursor":{"historyProjectionVersion":1,"lastConsumedId":0}}"""
    private val writeRequestCount get() = server.requestCount - syncReads.get()

    private val t0 = 1_772_582_400_000L // 2026-03-04T00:00:00Z

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : QueueDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "GET" && request.path!!.startsWith("/sync-state/")) {
                    syncReads.incrementAndGet()
                    return MockResponse().setResponseCode(stateResponseStatus).setBody(stateResponse)
                }
                return super.dispatch(request)
            }
        }
        server.start()
        events.clear()
        val context = ApplicationProvider.getApplicationContext<Application>()
        buffer = ActivityTransitionBuffer(context)
        history = ActivitySegmentsHistoryStore(context)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun enabledSettings() = ActivitySegmentsSettings(InMemoryKeyValueStore()).apply { activitySegmentsEnabled = true }

    private fun coordinator(
        settings: ActivitySegmentsSettings = enabledSettings(),
        hasPermission: Boolean = true,
        availability: ActivitySegmentsAvailability = ActivitySegmentsAvailability.Available,
        nowMillis: Long = t0 + 3_600_000,
    ): ActivitySegmentsSyncCoordinator {
        val http = GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")
        return ActivitySegmentsSyncCoordinator(
            buffer = buffer,
            history = history,
            analytics = AnalyticsClient(http),
            documents = DocumentsClient(http),
            settings = settings,
            hasPermission = { hasPermission },
            availability = { availability },
            sendEvent = { type, payload -> synchronized(events) { events += type to payload } },
            clock = { Instant.ofEpochMilli(nowMillis) },
        )
    }

    private fun event(type: String, transition: String, wallClockMillis: Long) =
        BufferedTransitionEvent(id = 0, activityType = type, transitionType = transition, elapsedRealtimeNanos = wallClockMillis * 1_000_000, eventWallClockMillis = wallClockMillis)

    private fun body(request: RecordedRequest): JsonObject =
        OmnesisJson.parseToJsonElement(request.body.readUtf8()).jsonObject

    private fun enqueueOk(json: String = """{"ok":true}""") {
        // These drain tests start with a repaired member. Replay/missing-state
        // behavior has its own stateful gateway fixture in ReplayTest.
        val parsed = OmnesisJson.parseToJsonElement(json).jsonObject
        if ("cursor" in parsed) {
            stateResponse = buildJsonObject {
                parsed.forEach { (key, value) -> if (key != "cursor") put(key, value) }
                put("cursor", buildJsonObject {
                    (parsed["cursor"] as? JsonObject)?.forEach { (key, value) -> put(key, value) }
                    put("historyProjectionVersion", 1)
                })
            }.toString()
            return
        }
        server.enqueue(MockResponse().setBody(json))
    }

    private fun takeWriteRequest(): RecordedRequest {
        while (true) {
            val request = server.takeRequest()
            if (request.method != "GET") return request
        }
    }

    @Test
    fun `disabled setting skips without any HTTP call`() = runTest {
        val result = coordinator(settings = ActivitySegmentsSettings(InMemoryKeyValueStore())).syncNow()
        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Skipped("Activity Segments syncing is disabled"), result)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `missing permission skips without any HTTP call`() = runTest {
        val result = coordinator(hasPermission = false).syncNow()
        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Skipped("Activity recognition permission not granted"), result)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `unavailable Google Play services skips without any HTTP call`() = runTest {
        val result = coordinator(availability = ActivitySegmentsAvailability.NotInstalled).syncNow()
        assertTrue(result is ActivitySegmentsSyncCoordinator.SyncResult.Skipped)
        assertEquals(0, server.requestCount)
    }



    @Test
    fun `an unreadable gateway cursor cannot drain or change the local history`() = runTest {
        buffer.insertAll(queuedPair())
        stateResponseStatus = 503
        stateResponse = """{"error":"unavailable"}"""

        val result = coordinator().syncNow()

        assertTrue(result is ActivitySegmentsSyncCoordinator.SyncResult.Failed)
        assertEquals(true, (result as ActivitySegmentsSyncCoordinator.SyncResult.Failed).retryable)
        assertEquals(1, server.requestCount)
        assertEquals(0, writeRequestCount)
        assertEquals(2, buffer.readAll().size)
        assertTrue(history.segmentsForDate("2026-03-04").isEmpty())
    }

    @Test
    fun `an empty buffer records a successful sync without regressing its cursor`() = runTest {
        enqueueOk("""{"cursor":{"lastConsumedId":41},"lastSyncedAt":"2026-03-04T00:00:00.000Z"}""")
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Success(0), result)
        assertEquals(1, writeRequestCount)
        assertEquals("/sync-state/android-activity-segments:local", server.takeRequest().path)
        val saved = body(takeWriteRequest())
        assertEquals(41L, saved["cursor"]!!.jsonObject["lastConsumedId"]!!.jsonPrimitive.content.toLong())
        assertEquals("Android Activity Segments", saved["label"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a closed segment pushes analytics rows then a day document, and drains the buffer through consumedThroughId`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))

        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Success(2), result)
        assertEquals(3, writeRequestCount)

        val analyticsIngest = body(takeWriteRequest())
        assertEquals("android_activity_segments", analyticsIngest["tableName"]!!.jsonPrimitive.content)
        assertEquals(1, analyticsIngest["records"]!!.jsonArray.size)

        val documentsIngest = body(takeWriteRequest())
        assertEquals(1, documentsIngest["documents"]!!.jsonArray.size)
        assertEquals(
            "activity-segments:2026-03-04",
            documentsIngest["documents"]!!.jsonArray[0].jsonObject["externalId"]!!.jsonPrimitive.content,
        )

        val setState = takeWriteRequest()
        assertEquals("/sync-state/android-activity-segments:local", setState.path)
        assertEquals("Android Activity Segments", body(setState)["label"]!!.jsonPrimitive.content)

        assertTrue(buffer.readAll().isEmpty())
    }

    @Test
    fun `a sub-floor blip records success and still drains from the buffer`() = runTest {
        // 10s walking blip — resolved (real ENTER+EXIT) but below MIN_SEGMENT_DURATION,
        // so it produces no Segment. Regression test: these events must still be
        // deleted from the buffer, or they accumulate forever and eventually crowd
        // out real events under readAll()'s fixed row limit.
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 10_000)))
        enqueueOk()

        val result = coordinator().syncNow()

        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Success(0), result)
        assertEquals(1, writeRequestCount)
        assertTrue(buffer.readAll().isEmpty())
    }

    @Test
    fun `a still-open trailing segment is left in the buffer while recording success`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0)))
        enqueueOk("""{"cursor":{"lastConsumedId":17},"lastSyncedAt":"2026-03-04T00:00:00.000Z"}""")
        enqueueOk()

        val result = coordinator(nowMillis = t0 + 5 * 60_000).syncNow()

        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Success(0), result)
        assertEquals(1, writeRequestCount)
        assertEquals(1, buffer.readAll().size)
    }

    @Test
    fun `a later drain touching the same day rebuilds the document with the full day's segments`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        enqueueOk(); enqueueOk(); enqueueOk()
        coordinator().syncNow()

        buffer.insertAll(listOf(event("running", "ENTER", t0 + 3600_000), event("running", "EXIT", t0 + 3600_000 + 6 * 60_000)))
        enqueueOk(); enqueueOk(); enqueueOk()
        coordinator(nowMillis = t0 + 7200_000).syncNow()

        val documentsIngestRequest = writeRequestCount
        assertEquals(6, documentsIngestRequest)
        // Re-take the second drain's document push (3rd and 6th requests are analytics, docs, setState per pass).
        takeWriteRequest(); takeWriteRequest(); takeWriteRequest() // first pass
        takeWriteRequest() // second pass analytics
        val secondDocs = body(takeWriteRequest())
        val doc = secondDocs["documents"]!!.jsonArray[0].jsonObject
        assertEquals("activity-segments:2026-03-04", doc["externalId"]!!.jsonPrimitive.content)
        assertTrue(doc["content"]!!.jsonPrimitive.content.contains("2 segments"))
    }

    @Test
    fun `a rejected analytics push leaves the buffer untouched for retry`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"android-activity-segments:local","reason":"paused"}]}""")

        val settings = enabledSettings()
        val result = coordinator(settings).syncNow()

        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.SourcePaused("Activity Segments is paused in Omnesis"), result)
        assertEquals(true, settings.activitySegmentsEnabled)
        assertEquals(2, buffer.readAll().size)
    }

    @Test
    fun `a removed source disables local syncing and leaves the buffer untouched`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"android-activity-segments:local","reason":"removed"}]}""")

        val settings = enabledSettings()
        val result = coordinator(settings).syncNow()

        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.SourceRemoved("Activity Segments was removed in Omnesis"), result)
        assertEquals(false, settings.activitySegmentsEnabled)
        assertEquals(2, buffer.readAll().size)
    }

    @Test
    fun `a server error during the documents push leaves the buffer untouched`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        enqueueOk("""{"ingested":1,"rejected":[]}""")
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))

        val result = coordinator().syncNow()

        assertTrue(result is ActivitySegmentsSyncCoordinator.SyncResult.Failed)
        assertEquals(true, (result as ActivitySegmentsSyncCoordinator.SyncResult.Failed).retryable)
        assertEquals(2, buffer.readAll().size)
    }

    @Test
    fun `a failed cursor write retains the raw events for an idempotent retry`() = runTest {
        buffer.insertAll(queuedPair())
        enqueueOk(); enqueueOk()
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"unavailable"}"""))

        assertTrue(coordinator().syncNow() is ActivitySegmentsSyncCoordinator.SyncResult.Failed)
        assertEquals(2, buffer.readAll().size)

        enqueueOk(); enqueueOk(); enqueueOk()
        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Success(2), coordinator().syncNow())
        assertTrue(buffer.readAll().isEmpty())
    }

    private fun enqueueRefusal(status: Int = 400) {
        server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":"refused"}"""))
    }

    /** One pass whose analytics push the gateway refuses, at a chosen wall clock. */
    private suspend fun refusedPass(settings: ActivitySegmentsSettings, atMillis: Long, status: Int = 400): ActivitySegmentsSyncCoordinator.SyncResult {
        enqueueRefusal(status)
        return coordinator(settings, nowMillis = atMillis).syncNow()
    }

    @Test
    fun `a refused push stays queued until both the budget and the grace window are spent`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        val settings = enabledSettings()
        val firstRefusalAt = t0 + 3_600_000

        repeat(RefusalPolicy.MAX_REFUSALS) {
            val result = refusedPass(settings, firstRefusalAt)
            assertTrue(result is ActivitySegmentsSyncCoordinator.SyncResult.Failed)
            assertEquals(false, (result as ActivitySegmentsSyncCoordinator.SyncResult.Failed).retryable)
        }

        // The budget is spent but the grace window is not: a fix on the
        // gateway has not had its chance yet, so nothing is given up on.
        assertEquals(2, buffer.readAll().size)
        assertEquals(0, buffer.quarantinedCount())
        assertEquals(RefusalPolicy.MAX_REFUSALS, settings.pushRefusals.openRun?.count)

        refusedPass(settings, firstRefusalAt + RefusalPolicy.GRACE.toMillis())

        assertTrue(buffer.readAll().isEmpty())
        assertEquals(2, buffer.quarantinedCount())
        assertEquals(null, settings.pushRefusals.openRun)

        // The user is told what was set aside, and that it took a run of
        // refusals rather than one bad pass.
        val skipped = settings.pushRefusals.skipped.single()
        assertEquals(ActivitySegmentsSyncCoordinator.SOURCE_ID, skipped.sourceId)
        assertEquals("2 buffered activity transition events", skipped.unit)
        assertEquals(RefusalPolicy.MAX_REFUSALS + 1, skipped.refusals)
    }

    @Test
    fun `once quarantined, the events behind the refused range drain normally`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        val settings = enabledSettings()
        val firstRefusalAt = t0 + 3_600_000
        repeat(RefusalPolicy.MAX_REFUSALS) { refusedPass(settings, firstRefusalAt) }
        refusedPass(settings, firstRefusalAt + RefusalPolicy.GRACE.toMillis())

        val later = t0 + 24 * 3_600_000
        buffer.insertAll(listOf(event("running", "ENTER", later), event("running", "EXIT", later + 6 * 60_000)))
        enqueueOk("""{"ingested":1,"rejected":[]}"""); enqueueOk("""{"ingested":1,"rejected":[]}"""); enqueueOk()

        val result = coordinator(settings, nowMillis = later + 3_600_000).syncNow()

        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Success(2), result)
        assertTrue(buffer.readAll().isEmpty())
    }

    @Test
    fun `a refusal against a different range starts its own run`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        val settings = enabledSettings()
        val firstRefusalAt = t0 + 3_600_000
        repeat(RefusalPolicy.MAX_REFUSALS) { refusedPass(settings, firstRefusalAt) }
        refusedPass(settings, firstRefusalAt + RefusalPolicy.GRACE.toMillis())
        assertEquals(null, settings.pushRefusals.openRun)

        val later = t0 + 24 * 3_600_000
        buffer.insertAll(listOf(event("running", "ENTER", later), event("running", "EXIT", later + 6 * 60_000)))
        refusedPass(settings, later + 3_600_000)

        // A spent run must not condemn whatever lands behind it: the new range
        // gets the full budget and grace window of its own.
        val run = settings.pushRefusals.openRun
        assertEquals(1, run?.count)
        assertEquals(buffer.readAll().first().id.toString(), run?.unitKey)
        assertEquals(2, buffer.readAll().size)
    }

    @Test
    fun `an outage never costs data however long it lasts`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        val settings = enabledSettings()

        // Well past both the attempt budget and the grace window.
        repeat(RefusalPolicy.MAX_REFUSALS * 3) { attempt ->
            val at = t0 + 3_600_000 + attempt.toLong() * RefusalPolicy.GRACE.toMillis()
            val result = refusedPass(settings, at, status = 503)
            assertEquals(true, (result as ActivitySegmentsSyncCoordinator.SyncResult.Failed).retryable)
        }

        assertEquals(2, buffer.readAll().size)
        assertEquals(0, buffer.quarantinedCount())
        assertEquals(null, settings.pushRefusals.openRun)
    }

    @Test
    fun `a rate-limited push is a retry, not a verdict on the payload`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        val settings = enabledSettings()

        repeat(RefusalPolicy.MAX_REFUSALS * 2) { attempt ->
            val at = t0 + 3_600_000 + attempt.toLong() * RefusalPolicy.GRACE.toMillis()
            val result = refusedPass(settings, at, status = 429)
            assertEquals(true, (result as ActivitySegmentsSyncCoordinator.SyncResult.Failed).retryable)
        }

        assertEquals(2, buffer.readAll().size)
        assertEquals(0, buffer.quarantinedCount())
        assertEquals(null, settings.pushRefusals.openRun)
    }

    @Test
    fun `a pass that gets through retires the run of refusals`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        val settings = enabledSettings()
        repeat(2) { refusedPass(settings, t0 + 3_600_000) }
        assertEquals(2, settings.pushRefusals.openRun?.count)

        enqueueOk("""{"ingested":1,"rejected":[]}"""); enqueueOk("""{"ingested":1,"rejected":[]}"""); enqueueOk()
        val result = coordinator(settings).syncNow()

        assertEquals(ActivitySegmentsSyncCoordinator.SyncResult.Success(2), result)
        assertEquals(null, settings.pushRefusals.openRun)
    }

    @Test
    fun `a paused source is never counted against the give-up budget`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        val settings = enabledSettings()

        repeat(RefusalPolicy.MAX_REFUSALS * 2) { attempt ->
            enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"android-activity-segments:local","reason":"paused"}]}""")
            val at = t0 + 3_600_000 + attempt.toLong() * RefusalPolicy.GRACE.toMillis()
            coordinator(settings, nowMillis = at).syncNow()
        }

        assertEquals(2, buffer.readAll().size)
        assertEquals(0, buffer.quarantinedCount())
        assertEquals(null, settings.pushRefusals.openRun)
    }

    @Test
    fun `concurrent syncNow calls coalesce into one drain`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000)))
        enqueueOk(); enqueueOk(); enqueueOk()

        val c = coordinator()
        val first = async { c.syncNow() }
        val second = async { c.syncNow() }

        assertEquals(first.await(), second.await())
        assertEquals(3, writeRequestCount)
        assertEquals(1, syncReads.get())
    }

    // --- Delivery health ---

    private fun queuedPair() = listOf(event("walking", "ENTER", t0), event("walking", "EXIT", t0 + 6 * 60_000))

    @Test
    fun `a gateway that refuses this device's authority marks the source blocked`() = runTest {
        buffer.insertAll(queuedPair())
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"missing scope"}"""))
        val settings = enabledSettings()

        val result = coordinator(settings).syncNow()

        assertTrue(result is ActivitySegmentsSyncCoordinator.SyncResult.NeedsAttention)
        assertEquals(true, settings.pushRefusals.blocked)
        assertEquals(true, coordinator(settings).deliveryEvidence().blocked)
        // A scope refusal is not a verdict on the payload, so it never spends
        // the give-up budget.
        assertEquals(null, settings.pushRefusals.openRun)
        assertEquals(2, buffer.readAll().size)
    }

    @Test
    fun `a push that gets through clears the blocked flag`() = runTest {
        buffer.insertAll(queuedPair())
        val settings = enabledSettings()
        settings.pushRefusals.blocked = true
        enqueueOk(); enqueueOk(); enqueueOk()

        coordinator(settings).syncNow()

        assertEquals(false, settings.pushRefusals.blocked)
    }

    @Test
    fun `an unreachable gateway is not evidence the scope was granted`() = runTest {
        buffer.insertAll(queuedPair())
        val settings = enabledSettings()
        settings.pushRefusals.blocked = true
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))

        coordinator(settings).syncNow()

        assertEquals(true, settings.pushRefusals.blocked)
    }

    @Test
    fun `evidence reports the queue, what is retained, and what was skipped`() = runTest {
        buffer.insertAll(queuedPair())
        val settings = enabledSettings()
        settings.pushRefusals.noteRefusal("1", Instant.ofEpochMilli(t0))
        settings.pushRefusals.recordSkipped("2 buffered activity transition events", Instant.ofEpochMilli(t0))
        buffer.insertAll(listOf(event("running", "ENTER", t0 + 60_000)))
        buffer.quarantine(3)

        val evidence = coordinator(settings).deliveryEvidence()

        assertEquals(ActivitySegmentsSyncCoordinator.SOURCE_ID, evidence.sourceId)
        assertEquals(0, evidence.queuedCount)
        assertEquals(null, evidence.oldestQueuedAtMillis)
        assertEquals(3, evidence.setAsideCount)
        assertEquals("2 buffered activity transition events", evidence.skipped.single().unit)
    }

    @Test
    fun `evidence dates the queue from when its oldest segment became complete`() = runTest {
        buffer.insertAll(queuedPair())

        val evidence = coordinator().deliveryEvidence()

        assertEquals(1, evidence.queuedCount)
        assertEquals(t0 + 6 * 60_000, evidence.oldestQueuedAtMillis)
    }

    @Test
    fun `unfinished activity is not a delivery backlog even after the warning threshold`() = runTest {
        buffer.insertAll(listOf(event("still", "ENTER", t0)))
        val now = t0 + 8 * 3_600_000L
        val c = coordinator(nowMillis = now)
        val evidence = c.deliveryEvidence()
        assertEquals(0, evidence.queuedCount)
        assertEquals(null, evidence.oldestQueuedAtMillis)
        assertTrue(PushHealth.isHealthy(PushHealth.summarize(listOf(evidence), Instant.ofEpochMilli(now))))
        enqueueOk("""{"cursor":null,"lastSyncedAt":null}""")
        enqueueOk()
        assertEquals(RetryOutcome.IDLE, c.retryDelivery())
        assertEquals(1, buffer.readAll().size)
        assertEquals(0, c.deliveryEvidence().queuedCount)
    }

    @Test
    fun `completed activity remains a backlog beside an unfinished interval until delivered`() = runTest {
        buffer.insertAll(queuedPair() + event("still", "ENTER", t0 + 7 * 60_000))
        val now = t0 + 8 * 3_600_000L
        val c = coordinator(nowMillis = now)
        val evidence = c.deliveryEvidence()
        assertEquals(1, evidence.queuedCount)
        assertEquals(t0 + 6 * 60_000, evidence.oldestQueuedAtMillis)
        assertTrue(PushHealth.isBacklogged(PushHealth.summarize(listOf(evidence), Instant.ofEpochMilli(now))))
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"unavailable"}"""))
        assertEquals(RetryOutcome.UNREACHABLE, c.retryDelivery())
        assertEquals(1, c.deliveryEvidence().queuedCount)
        enqueueOk(); enqueueOk(); enqueueOk()
        assertEquals(RetryOutcome.DELIVERED, c.retryDelivery())
        assertEquals(1, buffer.readAll().size)
        assertEquals(0, c.deliveryEvidence().queuedCount)
    }

    @Test
    fun `an open interval becomes deliverable at the normalizer safety limit`() = runTest {
        buffer.insertAll(listOf(event("still", "ENTER", t0)))
        assertEquals(0, coordinator(nowMillis = t0 + 12 * 3_600_000L - 1).deliveryEvidence().queuedCount)
        assertEquals(1, coordinator(nowMillis = t0 + 12 * 3_600_000L).deliveryEvidence().queuedCount)
        assertEquals(1, buffer.readAll().size)
    }

    @Test
    fun `a long activity that just ended has not been waiting to upload`() = runTest {
        val now = t0 + 8 * 3_600_000L
        buffer.insertAll(listOf(event("still", "ENTER", t0), event("still", "EXIT", now)))
        val evidence = coordinator(nowMillis = now).deliveryEvidence()
        assertEquals(1, evidence.queuedCount)
        assertEquals(now, evidence.oldestQueuedAtMillis)
        assertTrue(PushHealth.isHealthy(PushHealth.summarize(listOf(evidence), Instant.ofEpochMilli(now))))
    }

    @Test
    fun `safety closed activity ages from a fixed eligibility time rather than each observation`() = runTest {
        buffer.insertAll(listOf(event("still", "ENTER", t0)))
        val eligible = t0 + 12 * 3_600_000L
        val fresh = coordinator(nowMillis = eligible).deliveryEvidence()
        assertEquals(eligible, fresh.oldestQueuedAtMillis)
        assertTrue(PushHealth.isHealthy(PushHealth.summarize(listOf(fresh), Instant.ofEpochMilli(eligible))))
        val later = eligible + 6 * 3_600_000L
        val stale = coordinator(nowMillis = later).deliveryEvidence()
        assertEquals(eligible, stale.oldestQueuedAtMillis)
        assertTrue(PushHealth.isBacklogged(PushHealth.summarize(listOf(stale), Instant.ofEpochMilli(later))))
    }

    @Test
    fun `a retry reports what the pass achieved`() = runTest {
        buffer.insertAll(queuedPair())
        enqueueOk(); enqueueOk(); enqueueOk()
        assertEquals(RetryOutcome.DELIVERED, coordinator().retryDelivery())
    }

    @Test
    fun `a retry with nothing to send is not a failure`() = runTest {
        enqueueOk("""{"cursor":null,"lastSyncedAt":null}""")
        enqueueOk()
        assertEquals(RetryOutcome.IDLE, coordinator().retryDelivery())
    }

    @Test
    fun `a retry against a disabled source is not a failure`() = runTest {
        val off = ActivitySegmentsSettings(InMemoryKeyValueStore())
        assertEquals(RetryOutcome.IDLE, coordinator(off).retryDelivery())
    }

    @Test
    fun `a retry the gateway refuses reads as refused, not unreachable`() = runTest {
        buffer.insertAll(queuedPair())
        enqueueRefusal()
        assertEquals(RetryOutcome.REFUSED, coordinator().retryDelivery())
    }

    @Test
    fun `a retry that cannot reach the gateway reads as unreachable`() = runTest {
        buffer.insertAll(queuedPair())
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"down"}"""))
        assertEquals(RetryOutcome.UNREACHABLE, coordinator().retryDelivery())
    }

    @Test
    fun `a retry the pairing cannot authorize reads as failed`() = runTest {
        buffer.insertAll(queuedPair())
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"no"}"""))
        assertEquals(RetryOutcome.FAILED, coordinator().retryDelivery())
    }

    @Test
    fun `a retry landing while a pass runs reports busy rather than joining it`() = runTest {
        buffer.insertAll(queuedPair())
        // Hold the first push open so the retry lands mid-pass. Reporting the
        // running pass's outcome would answer a question the user did not ask.
        val gate = CompletableDeferred<Unit>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                runBlocking { gate.await() }
                return MockResponse().setBody("""{"ok":true}""")
            }
        }
        val c = coordinator()
        val pass = async { c.syncNow() }
        while (writeRequestCount == 0) yield()

        assertEquals(RetryOutcome.BUSY, c.retryDelivery())

        gate.complete(Unit)
        pass.await()
    }

    @Test
    fun `discarding deletes the retained events and forgets what was skipped`() = runTest {
        buffer.insertAll(queuedPair())
        buffer.quarantine(2)
        val settings = enabledSettings()
        settings.pushRefusals.noteRefusal("1", Instant.ofEpochMilli(t0))
        settings.pushRefusals.recordSkipped("2 buffered activity transition events", Instant.ofEpochMilli(t0))

        coordinator(settings).discardUndelivered()

        assertEquals(0, buffer.quarantinedCount())
        assertTrue(settings.pushRefusals.skipped.isEmpty())
    }
}

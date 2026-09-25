// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import java.time.Instant
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Durable history survives app reconstruction; the fake gateway can lose just this member's stream. */
@RunWith(RobolectricTestRunner::class)
class ActivitySegmentsReplayTest {
    private lateinit var server: MockWebServer
    private lateinit var history: ActivitySegmentsHistoryStore
    private lateinit var buffer: ActivityTransitionBuffer
    private var cursor: JsonObject? = null
    private val rows = linkedMapOf<String, JsonObject>()
    private val docs = linkedMapOf<String, JsonObject>()
    private var analyticsPushes = 0
    private val pageSizes = mutableListOf<Int>()
    private var failDocuments = false
    private var failDocumentsAfter: Int? = null
    private var failCursor = false
    private var rejectAnalytics: String? = null
    private val start = Instant.parse("2025-02-10T12:00:00Z").toEpochMilli()

    @Before fun setup() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        history = ActivitySegmentsHistoryStore(context)
        buffer = ActivityTransitionBuffer(context)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "GET") {
                    return ok(buildJsonObject { put("cursor", cursor ?: JsonNull) }.toString())
                }
                val body = OmnesisJson.parseToJsonElement(request.body.readUtf8()).jsonObject
                return when (request.path) {
                    "/analytics/ingest" -> {
                        analyticsPushes++
                        pageSizes += body["records"]!!.jsonArray.size
                        rejectAnalytics?.let {
                            return ok("""{"rejected":[{"sourceId":"android-activity-segments:local","reason":"$it"}]}""")
                        }
                        body["records"]!!.jsonArray.forEach { row ->
                            val value = row.jsonObject
                            rows[value["id"]!!.jsonPrimitive.content] = value
                        }
                        ok()
                    }
                    "/documents" -> {
                        if (failDocuments || failDocumentsAfter == analyticsPushes) return MockResponse().setResponseCode(500).setBody("""{"error":"unavailable"}""")
                        body["documents"]!!.jsonArray.forEach { doc ->
                            val value = doc.jsonObject
                            docs[value["externalId"]!!.jsonPrimitive.content] = value
                        }
                        ok()
                    }
                    "/sync-state/android-activity-segments:local" -> {
                        if (failCursor) return MockResponse().setResponseCode(500).setBody("""{"error":"unavailable"}""")
                        cursor = body["cursor"]!!.jsonObject
                        ok()
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun cleanup() { server.shutdown() }
    private fun ok(body: String = """{"ok":true}""") = MockResponse().setBody(body)
    private fun segment(index: Int = 0) = Segment(
        activityType = "walking", startMillis = start + index * 120_000L,
        endMillis = start + index * 120_000L + 60_000L,
        confidence = SegmentConfidence.HIGH, truncated = false,
    )
    private fun coordinator(): ActivitySegmentsSyncCoordinator {
        val http = GatewayHttp(OkHttpClient(), server.url("/").toString(), "test-token")
        return ActivitySegmentsSyncCoordinator(
            buffer, history, AnalyticsClient(http), DocumentsClient(http),
            ActivitySegmentsSettings(InMemoryKeyValueStore()).apply { activitySegmentsEnabled = true },
            { true }, { ActivitySegmentsAvailability.Available }, { _, _ -> },
            { Instant.ofEpochMilli(start + 86_400_000L) },
        )
    }

    @Test fun `missing member cursor restores both planes from history with an empty raw buffer`() = runTest {
        history.upsertAll(listOf(segment()))
        assertTrue(coordinator().syncNow() is ActivitySegmentsSyncCoordinator.SyncResult.Success)
        assertEquals(1, rows.size)
        assertEquals(1, docs.size)
        assertTrue(docs.values.single()["content"]!!.jsonPrimitive.content.contains("1 segment"))
        val pushes = analyticsPushes
        coordinator().syncNow()
        assertEquals("a repaired cursor avoids full replay on every sync", pushes, analyticsPushes)
        rows.clear(); docs.clear(); cursor = null
        coordinator().syncNow()
        assertEquals(1, rows.size)
        assertEquals(1, docs.size)
    }

    @Test fun `legacy cursor repairs documents once without regressing consumed event progress`() = runTest {
        history.upsertAll(listOf(segment()))
        cursor = buildJsonObject { put("lastConsumedId", 73) }
        coordinator().syncNow()
        assertEquals(1, rows.size)
        assertEquals(1, docs.size)
        assertEquals("73", cursor!!["lastConsumedId"]!!.jsonPrimitive.content)
        coordinator().syncNow()
        assertEquals(1, analyticsPushes)
    }

    @Test fun `legacy overnight history repairs both clipped days but retains one canonical analytics row`() = runTest {
        val overnight = segment().copy(startMillis = start + 11 * 3_600_000L, endMillis = start + 13 * 3_600_000L)
        history.upsertAll(listOf(overnight))
        cursor = buildJsonObject { put("lastConsumedId", 73) }

        coordinator().syncNow()

        assertEquals(1, rows.size)
        assertEquals("7200", rows.values.single()["duration_seconds"]!!.jsonPrimitive.content)
        assertEquals(setOf("activity-segments:2025-02-10", "activity-segments:2025-02-11"), docs.keys)
        docs.values.forEach { doc ->
            val metadata = doc["metadata"]!!.jsonObject["extra"]!!.jsonObject
            assertEquals("1", metadata["segmentCount"]!!.jsonPrimitive.content)
            assertEquals("3600", metadata["segments"]!!.jsonArray.single().jsonObject["durationSeconds"]!!.jsonPrimitive.content)
        }
    }

    @Test fun `failed document replay does not advance cursor and a reconstructed coordinator retries both planes`() = runTest {
        history.upsertAll(listOf(segment()))
        failDocuments = true
        assertTrue(coordinator().syncNow() is ActivitySegmentsSyncCoordinator.SyncResult.Failed)
        assertNull(cursor)
        assertEquals(1, rows.size)
        assertTrue(docs.isEmpty())
        failDocuments = false
        coordinator().syncNow()
        assertEquals(1, rows.size)
        assertEquals(1, docs.size)
        assertEquals(2, analyticsPushes)
    }

    @Test fun `failed cursor persistence repeats the replay without duplicating data`() = runTest {
        history.upsertAll(listOf(segment()))
        failCursor = true
        assertTrue(coordinator().syncNow() is ActivitySegmentsSyncCoordinator.SyncResult.Failed)
        assertNull(cursor)
        failCursor = false
        coordinator().syncNow()
        assertEquals(1, rows.size)
        assertEquals(1, docs.size)
        assertEquals(2, analyticsPushes)
    }

    @Test fun `history replay is bounded and resumes after process reconstruction`() = runTest {
        history.upsertAll((0..200).map(::segment))
        failDocumentsAfter = 2
        assertTrue(coordinator().syncNow() is ActivitySegmentsSyncCoordinator.SyncResult.Failed)
        assertNotNull(cursor!!["historyReplayAfter"])
        assertEquals(listOf(200, 1), pageSizes)
        failDocumentsAfter = null
        coordinator().syncNow()
        assertEquals(201, rows.size)
        assertEquals(listOf(200, 1, 1), pageSizes)
        assertNull(cursor!!["historyReplayAfter"])
        coordinator().syncNow()
        assertEquals(3, analyticsPushes)
    }

    @Test fun `an exact full replay page marks completion after its empty tail without uploading again`() = runTest {
        history.upsertAll((0 until 200).map(::segment))

        assertTrue(coordinator().syncNow() is ActivitySegmentsSyncCoordinator.SyncResult.Success)

        assertEquals(200, rows.size)
        assertEquals(listOf(200), pageSizes)
        assertNull(cursor!!["historyReplayAfter"])
        assertEquals("1", cursor!!["historyProjectionVersion"]!!.jsonPrimitive.content)
        coordinator().syncNow()
        coordinator().syncNow()
        assertEquals("a completed replay never uploads its last page again", listOf(200), pageSizes)
    }

    @Test fun `paused history replay never marks the member repaired`() = runTest {
        history.upsertAll(listOf(segment()))
        rejectAnalytics = "paused"
        assertTrue(coordinator().syncNow() is ActivitySegmentsSyncCoordinator.SyncResult.SourcePaused)
        assertNull(cursor)
        assertTrue(rows.isEmpty())
        rejectAnalytics = null
        coordinator().syncNow()
        assertEquals(1, rows.size)
    }
}

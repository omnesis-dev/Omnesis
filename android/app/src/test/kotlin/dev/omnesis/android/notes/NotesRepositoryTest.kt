// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.NotesClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.TimeUnit

/**
 * Save/queue/drain behavior of the quick-capture repository: a real
 * [PendingNotesStore] (Robolectric SQLite) against a MockWebServer gateway.
 */
@RunWith(RobolectricTestRunner::class)
class NotesRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var store: PendingNotesStore

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        store = PendingNotesStore(ApplicationProvider.getApplicationContext())
    }

    @After fun tearDown() { runCatching { server.shutdown() } }

    private fun reachableRepo(deviceId: String? = "dev-1") = NotesRepository(
        store = store,
        gateway = {
            NotesGateway(
                client = NotesClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")),
                deviceId = deviceId,
            )
        },
    )

    private fun unpairedRepo() = NotesRepository(store = store, gateway = { null })

    /** A gateway whose port refuses connections — every call is a connectivity failure. */
    private fun unreachableRepo(): NotesRepository {
        val deadUrl = server.url("/").toString()
        server.shutdown()
        return NotesRepository(
            store = store,
            gateway = { NotesGateway(NotesClient(GatewayHttp(OkHttpClient(), deadUrl, "tok")), "dev-1") },
        )
    }

    private fun entryResponse(id: String = "n1") = MockResponse().setResponseCode(201).setBody(
        """{"id":"$id","day":"2026-07-13","capturedAt":"2026-07-13T09:00:00.000Z",
            "updatedAt":"2026-07-13T09:00:00.000Z","text":"x","surface":"android-app","deviceId":"dev-1"}""",
    )

    @Test
    fun capture_posts_online_with_surface_and_device_id() = runTest {
        server.enqueue(entryResponse())
        val outcome = reachableRepo().capture("  Book the dentist  ", "android-assistant")

        assertTrue(outcome is CaptureOutcome.Posted)
        val sent = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("Book the dentist", sent["text"]?.jsonPrimitive?.content)
        assertEquals("android-assistant", sent["surface"]?.jsonPrimitive?.content)
        assertEquals("dev-1", sent["deviceId"]?.jsonPrimitive?.content)
        // The client-generated idempotency key rides on every create.
        assertEquals(36, sent["id"]?.jsonPrimitive?.content?.length)
        assertTrue(store.readAll().isEmpty())
    }

    @Test
    fun capture_rejects_overlong_text_before_drain_or_network_side_effects() = runTest {
        store.insert("key-backlog", "older backlog note", "2026-07-13T07:00:00.000Z", "android-app")

        try {
            reachableRepo().capture("a".repeat(NotesRepository.MAX_TEXT_LENGTH + 1), "android-assistant")
            fail("expected IllegalArgumentException")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message.orEmpty().contains("8192"))
        }

        assertEquals(0, server.requestCount)
        assertEquals(listOf("older backlog note"), store.readAll().map { it.text })
    }

    @Test
    fun capture_accepts_text_at_the_exact_local_cap() = runTest {
        server.enqueue(entryResponse())

        val outcome = reachableRepo().capture("a".repeat(NotesRepository.MAX_TEXT_LENGTH), "android-assistant")

        assertTrue(outcome is CaptureOutcome.Posted)
        assertEquals(
            NotesRepository.MAX_TEXT_LENGTH,
            OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8())
                .jsonObject["text"]?.jsonPrimitive?.content?.length,
        )
    }

    @Test
    fun capture_rejects_whitespace_before_drain_or_network() = runTest {
        try {
            reachableRepo().capture("  \n  ", "android-assistant")
            fail("expected whitespace-only text to be rejected")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
        assertEquals(0, server.requestCount)
        assertTrue(store.readAll().isEmpty())
    }

    @Test
    fun cancellation_during_backlog_drain_aborts_the_new_capture() = runTest {
        store.insert("backlog-key", "older note", "2026-07-13T08:00:00.000Z", "android-app")
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val job = launch(Dispatchers.Default) {
            reachableRepo().capture("new note", "android-assistant")
        }
        // Waited for on a real dispatcher: runTest's virtual clock would expire
        // this timeout at once, before a slower machine's request lands.
        withContext(Dispatchers.Default) {
            withTimeout(5_000) {
                while (server.requestCount == 0) delay(10)
            }
        }

        job.cancelAndJoin()

        assertTrue(job.isCancelled)
        assertEquals(1, server.requestCount)
        assertEquals(listOf("older note"), store.readAll().map { it.text })
    }

    @Test
    fun capture_queues_when_the_gateway_is_unreachable() = runTest {
        val outcome = unreachableRepo().capture("Water the plants", "android-app")

        assertEquals(CaptureOutcome.Queued(QueueReason.UNREACHABLE), outcome)
        val queued = store.readAll()
        assertEquals(1, queued.size)
        assertEquals("Water the plants", queued[0].text)
        assertEquals("android-app", queued[0].surface)
        assertTrue(queued[0].capturedAt.isNotBlank())
        assertEquals("Gateway unreachable", queued[0].lastFailure)
        assertTrue(queued[0].lastAttemptAt?.isNotBlank() == true)
        assertEquals(0, queued[0].retryCount)
        // The idempotency key is minted at capture time and persisted with the row.
        assertEquals(36, queued[0].noteId.length)
    }

    @Test
    fun capture_queues_while_unpaired() = runTest {
        val outcome = unpairedRepo().capture("Renew the passport", "android-shortcut")

        assertEquals(CaptureOutcome.Queued(QueueReason.UNPAIRED), outcome)
        assertEquals(1, store.readAll().size)
        assertEquals("Not paired with a gateway", store.readAll().single().lastFailure)
        assertEquals(null, store.readAll().single().lastAttemptAt)
    }

    @Test
    fun capture_queues_on_a_feature_off_404() = runTest {
        // 404 = an older gateway without /notes. Cross-platform policy: queue
        // it so the note syncs after the gateway is upgraded.
        server.enqueue(MockResponse().setResponseCode(404).setBody("Not found"))

        val outcome = reachableRepo().capture("hello", "android-app")

        assertEquals(CaptureOutcome.Queued(QueueReason.FEATURE_OFF), outcome)
        val queued = store.readAll()
        assertEquals(1, queued.size)
        assertEquals("hello", queued[0].text)
        assertEquals(36, queued[0].noteId.length)
        assertEquals("This gateway version does not support Tell Omnesis", queued[0].lastFailure)
    }

    @Test
    fun capture_queues_auth_and_retryable_http_failures() = runTest {
        val failures = mutableListOf<String?>()
        for (status in listOf(401, 403, 429, 503)) {
            server.enqueue(MockResponse().setResponseCode(status).setBody("unavailable"))

            val outcome = reachableRepo().capture("note for $status", "android-assistant")

            val expected = if (status == 401 || status == 403) {
                QueueReason.UNAUTHORIZED
            } else {
                QueueReason.UNREACHABLE
            }
            assertEquals(CaptureOutcome.Queued(expected), outcome)
            val queued = store.readAll().single()
            failures += queued.lastFailure
            store.delete(queued.id)
        }

        assertEquals(
            listOf(
                "Gateway authorization failed",
                "Gateway denied this device",
                "Gateway returned HTTP 429",
                "Gateway returned HTTP 503",
            ),
            failures,
        )
        assertTrue(store.readAll().isEmpty())
    }

    @Test
    fun capture_does_not_queue_a_note_the_gateway_rejected() = runTest {
        // These deterministic per-note rejections propagate so the UI can
        // explain them — queueing would wedge the queue on a note the gateway
        // will never accept.
        for (status in listOf(400, 413, 422)) {
            server.enqueue(MockResponse().setResponseCode(status).setBody("rejected"))
            try {
                reachableRepo().capture("hello", "android-app")
                fail("expected GatewayException.ServerError for HTTP $status")
            } catch (error: GatewayException.ServerError) {
                assertEquals(status, error.status)
            }
            assertTrue(store.readAll().isEmpty())
        }
    }

    @Test
    fun drain_posts_queued_notes_oldest_first_with_original_captured_at() = runTest {
        store.insert("key-first", "first", "2026-07-13T08:00:00.000Z", "android-tile")
        store.insert("key-second", "second", "2026-07-13T08:05:00.000Z", "android-app")
        server.enqueue(entryResponse("n1"))
        server.enqueue(entryResponse("n2"))

        reachableRepo().drain()

        val firstSent = OmnesisJson.parseToJsonElement(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
        val secondSent = OmnesisJson.parseToJsonElement(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
        assertEquals("first", firstSent["text"]?.jsonPrimitive?.content)
        assertEquals("2026-07-13T08:00:00.000Z", firstSent["capturedAt"]?.jsonPrimitive?.content)
        assertEquals("android-tile", firstSent["surface"]?.jsonPrimitive?.content)
        // Each drained row reuses ITS persisted idempotency key, so a retried
        // drain (e.g. after process death mid-drain) can't duplicate a note.
        assertEquals("key-first", firstSent["id"]?.jsonPrimitive?.content)
        assertEquals("second", secondSent["text"]?.jsonPrimitive?.content)
        assertEquals("key-second", secondSent["id"]?.jsonPrimitive?.content)
        assertTrue(store.readAll().isEmpty())
    }

    @Test
    fun drain_skips_a_rejected_row_and_keeps_draining_the_rest() = runTest {
        // A 400-rejected row must not block the rows behind it — it stays
        // queued (swipe-delete is the manual escape) while the rest drain.
        store.insert("key-rejected", "rejected", "2026-07-13T08:00:00.000Z", "android-app")
        store.insert("key-accepted", "accepted", "2026-07-13T08:05:00.000Z", "android-app")
        server.enqueue(MockResponse().setResponseCode(400).setBody("bad request"))
        server.enqueue(entryResponse("n1"))

        reachableRepo().drain()

        assertEquals(2, server.requestCount)
        val remaining = store.readAll()
        assertEquals(1, remaining.size)
        assertEquals("rejected", remaining[0].text)
        assertEquals("Gateway returned HTTP 400", remaining[0].lastFailure)
        assertEquals(1, remaining[0].retryCount)
    }

    @Test
    fun drain_stops_on_a_network_failure_and_keeps_everything() = runTest {
        store.insert("key-first", "first", "2026-07-13T08:00:00.000Z", "android-app")
        store.insert("key-second", "second", "2026-07-13T08:05:00.000Z", "android-app")

        unreachableRepo().drain()

        val remaining = store.readAll()
        assertEquals(2, remaining.size)
        assertEquals("Gateway unreachable", remaining.first().lastFailure)
        assertEquals(1, remaining.first().retryCount)
        assertEquals(0, remaining.last().retryCount)
    }

    @Test
    fun drain_stops_on_a_feature_off_404_and_keeps_everything() = runTest {
        // A 404 means the whole /notes surface is off — hammering the rest of
        // the queue is pointless, so the drain stops after the first row.
        store.insert("key-first", "first", "2026-07-13T08:00:00.000Z", "android-app")
        store.insert("key-second", "second", "2026-07-13T08:05:00.000Z", "android-app")
        server.enqueue(MockResponse().setResponseCode(404).setBody("Not found"))

        reachableRepo().drain()

        assertEquals(1, server.requestCount)
        val remaining = store.readAll()
        assertEquals(2, remaining.size)
        assertEquals("This gateway version does not support Tell Omnesis", remaining.first().lastFailure)
        assertEquals(1, remaining.first().retryCount)
    }

    @Test
    fun drain_stops_on_auth_failure() = runTest {
        store.insert("key-first", "first", "2026-07-13T08:00:00.000Z", "android-assistant")
        store.insert("key-second", "second", "2026-07-13T08:05:00.000Z", "android-assistant")
        server.enqueue(MockResponse().setResponseCode(401).setBody("unauthorized"))

        reachableRepo().drain()

        assertEquals(1, server.requestCount)
        assertEquals(listOf(1, 0), store.readAll().map { it.retryCount })
        assertEquals("Gateway authorization failed", store.readAll().first().lastFailure)
    }

    @Test
    fun drain_stops_on_retryable_server_failure() = runTest {
        store.insert("key-first", "first", "2026-07-13T08:00:00.000Z", "android-assistant")
        store.insert("key-second", "second", "2026-07-13T08:05:00.000Z", "android-assistant")
        server.enqueue(MockResponse().setResponseCode(503).setBody("unavailable"))

        reachableRepo().drain()

        assertEquals(1, server.requestCount)
        assertEquals(listOf(1, 0), store.readAll().map { it.retryCount })
        assertEquals("Gateway returned HTTP 503", store.readAll().first().lastFailure)
    }

    @Test
    fun drain_reuses_a_queued_captures_idempotency_key() = runTest {
        // Capture offline → the minted key is persisted with the queued row;
        // the later drain must POST that same key, not mint a fresh one.
        unreachableRepo().capture("Renew the passport", "android-app")
        val queuedKey = store.readAll().single().noteId

        server = MockWebServer().also { it.start() }
        server.enqueue(entryResponse("n1"))
        reachableRepo().drain()

        val sent = OmnesisJson.parseToJsonElement(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
        assertEquals(queuedKey, sent["id"]?.jsonPrimitive?.content)
        assertTrue(store.readAll().isEmpty())
    }

    @Test
    fun drain_is_a_noop_while_unpaired() = runTest {
        store.insert("key-kept", "kept", "2026-07-13T08:00:00.000Z", "android-app")

        unpairedRepo().drain()

        assertEquals(1, store.readAll().size)
    }

    @Test
    fun capture_drains_the_backlog_before_posting_the_new_note() = runTest {
        store.insert("key-backlog", "older backlog note", "2026-07-13T07:00:00.000Z", "android-app")
        server.enqueue(entryResponse("n1"))
        server.enqueue(entryResponse("n2"))

        reachableRepo().capture("fresh note", "android-app")

        val firstSent = OmnesisJson.parseToJsonElement(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
        val secondSent = OmnesisJson.parseToJsonElement(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
        assertEquals("older backlog note", firstSent["text"]?.jsonPrimitive?.content)
        assertEquals("fresh note", secondSent["text"]?.jsonPrimitive?.content)
        assertTrue(store.readAll().isEmpty())
    }

    @Test
    fun delete_pending_discards_a_queued_note_and_updates_the_pending_flow() = runTest {
        store.insert("key-discard", "discard me", "2026-07-13T08:00:00.000Z", "android-app")
        val repo = unpairedRepo()
        repo.refreshPending()
        assertEquals(1, repo.pending.value.size)

        repo.deletePending(repo.pending.value.first().id)

        assertTrue(store.readAll().isEmpty())
        assertTrue(repo.pending.value.isEmpty())
    }

    @Test
    fun delete_pending_waits_for_an_inflight_drain() = runTest {
        // deletePending shares drain()'s mutex: while a drain is mid-POST, the
        // swipe-delete must block until the drain releases the lock instead of
        // mutating the queue the drain already snapshotted.
        store.insert("key-inflight", "in flight", "2026-07-13T08:00:00.000Z", "android-app")
        val id = store.readAll().single().id
        server.enqueue(entryResponse("n1").setHeadersDelay(600, TimeUnit.MILLISECONDS))
        val repo = reachableRepo()

        val drain = launch(Dispatchers.IO) { repo.drain() }
        // The drain holds the mutex once its POST is on the wire.
        server.takeRequest(1, TimeUnit.SECONDS)
        val delete = launch(Dispatchers.IO) { repo.deletePending(id) }
        Thread.sleep(200)
        assertTrue("deletePending must block behind the in-flight drain", delete.isActive)

        drain.join()
        delete.join()
        // The drain won the row (POSTed + deleted it); the late delete no-ops.
        assertTrue(store.readAll().isEmpty())
        assertTrue(repo.pending.value.isEmpty())
    }

    @Test
    fun refresh_pending_cannot_republish_a_row_deleted_by_an_inflight_drain() = runTest {
        store.insert("key-inflight", "in flight", "2026-07-13T08:00:00.000Z", "android-app")
        server.enqueue(entryResponse("n1").setHeadersDelay(600, TimeUnit.MILLISECONDS))
        val repo = reachableRepo()

        val drain = launch(Dispatchers.IO) { repo.drain() }
        server.takeRequest(1, TimeUnit.SECONDS)
        val refresh = launch(Dispatchers.IO) { repo.refreshPending() }
        Thread.sleep(200)
        assertTrue("refresh must serialize behind the drain", refresh.isActive)

        drain.join()
        refresh.join()
        assertTrue(repo.pending.value.isEmpty())
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.client.NotesClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A capture relayed from another device keeps the identity, time and time zone it was given there. */
@RunWith(RobolectricTestRunner::class)
class RelayedCaptureTest {
    private lateinit var server: MockWebServer
    private lateinit var store: PendingNotesStore
    private val relayed = RelayedCapture(
        noteId = "5f0c3b1e-8a47-4f6e-9d2b-7c1a2e3f4b5d",
        capturedAt = Instant.parse("2026-03-14T09:30:00Z"),
    )
    private val entry = """
        {"id":"n1","day":"2026-03-14","capturedAt":"2026-03-14T09:30:00.000Z",
         "updatedAt":"2026-03-14T09:30:00.000Z","text":"Buy oat milk"}
    """.trimIndent()

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        store = PendingNotesStore(ApplicationProvider.getApplicationContext())
    }

    @After fun tearDown() { runCatching { server.shutdown() } }

    private fun repository(paired: Boolean = true) = NotesRepository(
        store = store,
        gateway = {
            NotesGateway(NotesClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")), "dev-1")
                .takeIf { paired }
        },
        now = { Instant.parse("2026-03-14T11:00:00Z") },
        timeZone = { ZoneId.of("Asia/Tokyo") },
    )

    @Test
    fun a_relayed_capture_is_posted_under_its_own_key_and_time() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody(entry))

        assertEquals(CaptureOutcome.Posted, repository().capture("Buy oat milk", "android-watch", relayed = relayed))

        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(relayed.noteId, body["id"]?.jsonPrimitive?.content)
        assertEquals("2026-03-14T09:30:00Z", body["capturedAt"]?.jsonPrimitive?.content)
        assertEquals("android-watch", body["surface"]?.jsonPrimitive?.content)
    }

    @Test
    fun a_relayed_capture_queued_offline_keeps_its_key_and_time_for_the_drain() = runTest {
        val outcome = repository(paired = false).capture("Buy oat milk", "android-watch", relayed = relayed)

        assertEquals(CaptureOutcome.Queued(QueueReason.UNPAIRED), outcome)
        val queued = store.readAll().single()
        assertEquals(relayed.noteId, queued.noteId)
        assertEquals("2026-03-14T09:30:00Z", queued.capturedAt)
    }

    @Test
    fun a_relayed_capture_is_filed_in_the_zone_it_was_captured_in() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody(entry))
        val abroad = relayed.copy(zone = CaptureZone("America/Lima", -18_000))

        repository().capture("Buy oat milk", "android-watch", relayed = abroad)

        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("America/Lima", body["capturedTimeZoneId"]?.jsonPrimitive?.content)
        assertEquals("-18000", body["capturedUtcOffsetSeconds"]?.jsonPrimitive?.content)
    }

    @Test
    fun a_relayed_capture_queued_offline_keeps_its_zone_for_the_drain() = runTest {
        val abroad = relayed.copy(zone = CaptureZone("America/Lima", -18_000))

        repository(paired = false).capture("Buy oat milk", "android-watch", relayed = abroad)

        assertEquals(CaptureZone("America/Lima", -18_000), store.readAll().single().zone)
    }

    @Test
    fun a_relayed_capture_without_a_zone_is_filed_in_the_phones_as_it_stood_then() = runTest {
        repository(paired = false).capture("Buy oat milk", "android-watch", relayed = relayed)

        assertEquals(CaptureZone("Asia/Tokyo", 32_400), store.readAll().single().zone)
    }

    @Test
    fun a_relayed_zone_is_kept_only_when_the_gateway_would_accept_it() {
        assertEquals(CaptureZone("Europe/Lisbon", 3_600), CaptureZone.relayed("Europe/Lisbon", 3_600))
        assertEquals(CaptureZone("UTC", 0), CaptureZone.relayed("UTC", 0))
        // A fixed offset, an id no zone database has, and an offset no zone has.
        assertNull(CaptureZone.relayed("GMT+02:00", 7_200))
        assertNull(CaptureZone.relayed("Nowhere/Invented", 0))
        assertNull(CaptureZone.relayed("Europe/Lisbon", 90_000))
        assertNull(CaptureZone.relayed("", 0))
    }

    @Test
    fun a_capture_made_on_the_phone_still_gets_a_fresh_key_and_the_current_time() = runTest {
        repository(paired = false).capture("Buy oat milk", "android-app")
        val queued = store.readAll().single()
        assertEquals("2026-03-14T11:00:00Z", queued.capturedAt)
        assertEquals(36, queued.noteId.length)
    }
}

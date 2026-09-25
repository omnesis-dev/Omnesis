// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.CreateNoteBody
import dev.omnesis.android.transport.dto.NoteEntryDto
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Wire contract for the quick-capture `/notes` surface (OkHttp MockWebServer).
 * Fixture JSON mirrors the gateway's captured response shape; all sample data
 * is invented (privacy rule), never sourced from the corpus.
 */
class NotesClientTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = NotesClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    private val entryJson = """
        {"id":"n1","day":"2026-07-13","capturedAt":"2026-07-13T09:15:00.000Z",
         "updatedAt":"2026-07-13T09:15:00.000Z","text":"Ask Maya Reeves about the demo",
         "surface":"android-tile","deviceId":"dev-42"}
    """.trimIndent()

    @Test
    fun create_posts_full_body_and_decodes_created_entry() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody(entryJson))
        val entry = client().create(
            CreateNoteBody(
                text = "Ask Maya Reeves about the demo",
                id = "3f1a2b64-8c05-4e7d-9a11-5b0c2d6e7f80",
                capturedAt = "2026-07-13T09:15:00.000Z",
                surface = "android-tile",
                deviceId = "dev-42",
            ),
        )
        assertEquals("n1", entry.id)
        assertEquals("2026-07-13", entry.day)
        assertEquals("android-tile", entry.surface)
        assertEquals("dev-42", entry.deviceId)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/notes", req.path)
        val sent = OmnesisJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("Ask Maya Reeves about the demo", sent["text"]?.jsonPrimitive?.content)
        // The client idempotency key is serialized when present (and, per the
        // omits-null test below, absent when not).
        assertEquals("3f1a2b64-8c05-4e7d-9a11-5b0c2d6e7f80", sent["id"]?.jsonPrimitive?.content)
        assertEquals("2026-07-13T09:15:00.000Z", sent["capturedAt"]?.jsonPrimitive?.content)
        assertEquals("android-tile", sent["surface"]?.jsonPrimitive?.content)
    }

    @Test
    fun create_omits_null_optionals_from_the_body() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody(entryJson))
        client().create(CreateNoteBody(text = "Buy espresso beans"))
        val sent = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("text"), sent.keys)
    }

    @Test
    fun non_experimental_gateway_404_maps_to_not_found() = runTest {
        // Older gateways may not expose the /notes surface.
        server.enqueue(MockResponse().setResponseCode(404).setBody("Not found"))
        try {
            client().create(CreateNoteBody(text = "hello"))
            fail("expected GatewayException.NotFound")
        } catch (e: GatewayException.NotFound) {
            // expected
        }
    }

    @Test
    fun entry_decode_tolerates_omitted_optionals() {
        val entry = OmnesisJson.decodeFromString(
            NoteEntryDto.serializer(),
            """{"id":"n9","day":"2026-07-13","capturedAt":"2026-07-13T07:00:00.000Z",
                "updatedAt":"2026-07-13T07:00:00.000Z","text":"water the plants"}""",
        )
        assertNull(entry.surface)
        assertNull(entry.deviceId)
    }
}

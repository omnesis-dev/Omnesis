// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.CreateNoteBody
import dev.omnesis.android.transport.dto.NoteEntryDto
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.VoiceNoteBody
import java.nio.file.Files
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

    @Test
    fun create_voice_uploads_the_note_json_and_the_audio_as_multipart() = runTest {
        val audio = Files.createTempFile("voice", ".wav").toFile().apply { writeText("RIFF-invented") }
        try {
            server.enqueue(MockResponse().setResponseCode(202).setBody("""{"id":"n7","transcription":"pending"}"""))
            val accepted = client().createVoice(
                VoiceNoteBody(
                    id = "3f1a2b64-8c05-4e7d-9a11-5b0c2d6e7f80",
                    text = "Order more filament",
                    capturedAt = "2026-07-13T09:15:00.000Z",
                    surface = "android-tile",
                    deviceId = "dev-42",
                    language = "en-GB",
                ),
                audio,
                "audio/wav",
            )
            assertEquals("n7", accepted.id)
            assertEquals("pending", accepted.transcription)

            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("/notes/voice", req.path)
            assertEquals("Bearer tok", req.getHeader("Authorization"))
            assertTrue(req.getHeader("Content-Type")!!.startsWith("multipart/form-data; boundary="))
            val body = req.body.readUtf8()
            assertTrue(body.contains("Content-Disposition: form-data; name=\"note\""))
            assertTrue(body.contains("\"id\":\"3f1a2b64-8c05-4e7d-9a11-5b0c2d6e7f80\""))
            assertTrue(body.contains("\"language\":\"en-GB\""))
            assertTrue(body.contains("Content-Disposition: form-data; name=\"audio\"; filename=\"${audio.name}\""))
            assertTrue(body.contains("Content-Type: audio/wav"))
            assertTrue(body.contains("RIFF-invented"))
        } finally {
            audio.delete()
        }
    }

    @Test
    fun create_voice_omits_absent_optionals_from_the_note_part() {
        val note = NotesClient.voiceNoteBody(
            VoiceNoteBody(id = "k", text = "", capturedAt = "2026-07-13T09:15:00.000Z", surface = "android-app"),
            Files.createTempFile("voice", ".wav").toFile(),
            "audio/wav",
        ).part(0)
        val buffer = okio.Buffer().also { note.body.writeTo(it) }
        assertEquals(setOf("id", "text", "capturedAt", "surface"), OmnesisJson.parseToJsonElement(buffer.readUtf8()).jsonObject.keys)
    }

    @Test
    fun create_voice_refusals_keep_their_status_and_code() = runTest {
        val audio = Files.createTempFile("voice", ".wav").toFile()
        val note = VoiceNoteBody(id = "k", text = "", capturedAt = "2026-07-13T09:15:00.000Z", surface = "android-app")
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not found"}"""))
        server.enqueue(
            MockResponse().setResponseCode(409)
                .setBody("""{"error":"Gateway dictation is switched off.","code":"DICTATION_DISABLED"}"""),
        )
        server.enqueue(
            MockResponse().setResponseCode(503)
                .setBody("""{"error":"No transcriber model can run.","code":"TRANSCRIBER_UNAVAILABLE"}"""),
        )
        try {
            client().createVoice(note, audio, "audio/wav")
            fail("expected NotFound")
        } catch (_: GatewayException.NotFound) {
        }
        for ((status, code) in listOf(409 to "DICTATION_DISABLED", 503 to "TRANSCRIBER_UNAVAILABLE")) {
            try {
                client().createVoice(note, audio, "audio/wav")
                fail("expected ServerError $status")
            } catch (e: GatewayException.ServerError) {
                assertEquals(status, e.status)
                assertEquals(code, e.code)
            }
        }
        audio.delete()
    }

    @Test
    fun voice_uploads_outlast_the_ordinary_api_timeout() {
        assertTrue(NotesClient.VOICE_UPLOAD_TIMEOUT.seconds > 30)
    }
}

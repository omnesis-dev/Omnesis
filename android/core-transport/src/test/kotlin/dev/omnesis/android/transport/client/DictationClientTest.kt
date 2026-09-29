// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.DictationStatusDto
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.StatusSnapshot
import dev.omnesis.android.transport.http.GatewayHttp
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Wire contract for gateway dictation: the `dictation` gate on `GET /status`, the
 * raw-audio `POST /dictation/transcribe` with each documented refusal mapped to its
 * typed outcome, and the `PATCH /admin/config` that switches it. Replies mirror
 * `packages/gateway/src/http/routes/dictation.ts`; the audio is invented bytes.
 */
class DictationClientTest {

    private lateinit var server: MockWebServer
    private lateinit var audio: File

    @Before fun setUp() {
        server = MockWebServer().also { it.start() }
        audio = Files.createTempFile("dictation", ".m4a").toFile().apply { writeBytes(AUDIO) }
    }

    @After fun tearDown() {
        server.shutdown()
        audio.delete()
    }

    /** No silent retry of a dropped connection, so one scripted drop is one failed call. */
    private fun http() = GatewayHttp(
        OkHttpClient.Builder().retryOnConnectionFailure(false).build(),
        server.url("/").toString(),
        "tok",
        "gen-7",
    )

    private suspend fun transcribe(language: String? = "fr") =
        DictationClient(http()).transcribe(audio, "audio/mp4", language)

    @Test
    fun posts_the_raw_audio_with_its_type_language_and_auth_then_decodes_the_transcript() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"text":"Acheter du pain","language":"fr","durationSec":2.4}"""),
        )
        val outcome = transcribe()
        assertEquals(DictationOutcome.Transcribed("Acheter du pain", "fr", 2.4), outcome)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/dictation/transcribe?language=fr", req.path)
        assertEquals("audio/mp4", req.getHeader("Content-Type"))
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertEquals("gen-7", req.getHeader("Omnesis-Pairing-Generation"))
        assertArrayEquals(AUDIO, req.body.readByteArray())
    }

    @Test
    fun omits_the_language_hint_when_there_is_none_and_tolerates_a_bare_reply() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"text":"hello"}"""))
        assertEquals(DictationOutcome.Transcribed("hello", null, null), transcribe(language = null))
        assertEquals("/dictation/transcribe", server.takeRequest().path)
    }

    @Test
    fun a_404_means_the_gateway_does_not_offer_dictation() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not found"}"""))
        assertEquals(DictationOutcome.Unsupported, transcribe())
    }

    @Test
    fun maps_each_documented_refusal_code() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(409)
                .setBody("""{"error":"Gateway dictation is switched off.","code":"DICTATION_DISABLED"}"""),
        )
        server.enqueue(
            MockResponse().setResponseCode(503)
                .setBody("""{"error":"No transcriber model can run.","code":"TRANSCRIBER_UNAVAILABLE"}"""),
        )
        server.enqueue(
            MockResponse().setResponseCode(413)
                .setBody("""{"error":"Audio body too large (max 25 MB)","code":"PAYLOAD_TOO_LARGE"}"""),
        )
        assertEquals(DictationOutcome.Disabled, transcribe())
        assertEquals(DictationOutcome.TranscriberUnavailable("No transcriber model can run."), transcribe())
        assertEquals(DictationOutcome.TooLarge, transcribe())
    }

    @Test
    fun a_413_from_a_proxy_without_the_envelope_is_still_too_large() = runTest {
        server.enqueue(MockResponse().setResponseCode(413).setBody("<html>Request Entity Too Large</html>"))
        assertEquals(DictationOutcome.TooLarge, transcribe())
    }

    @Test
    fun other_failures_keep_their_typed_error() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom","code":"INTERNAL"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("not json"))
        assertTrue((transcribe() as DictationOutcome.Failed).error is GatewayException.Unauthorized)
        assertTrue((transcribe() as DictationOutcome.Failed).error is GatewayException.ServerError)
        assertTrue((transcribe() as DictationOutcome.Failed).error is GatewayException.Decoding)
    }

    @Test
    fun a_dropped_connection_is_unreachable() = runTest {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertTrue(transcribe() is DictationOutcome.Unreachable)
    }

    @Test
    fun the_transcription_call_outlasts_the_ordinary_api_timeout() {
        assertTrue(DictationClient.TRANSCRIBE_TIMEOUT.seconds >= 60)
    }

    @Test
    fun switching_gateway_dictation_patches_the_inference_config() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        AdminClient(http()).setTranscribeOnGateway(true)
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/admin/config", req.path)
        assertEquals(
            OmnesisJson.parseToJsonElement("""{"inference":{"dictation":{"transcribeOnGateway":true}}}"""),
            OmnesisJson.parseToJsonElement(req.body.readUtf8()),
        )
    }

    @Test
    fun status_decodes_the_dictation_gate() {
        val status = OmnesisJson.decodeFromString(
            StatusSnapshot.serializer(),
            """{"documents":{"total":3,"bySource":{}},"experimental":true,
               "dictation":{"visible":true,"enabled":true,"modelAssigned":false,"active":false,
                            "reason":"No transcriber model is assigned.","maxAudioBytes":26214400}}""",
        )
        assertEquals(
            DictationStatusDto(
                visible = true,
                enabled = true,
                modelAssigned = false,
                active = false,
                reason = "No transcriber model is assigned.",
                maxAudioBytes = 26_214_400,
            ),
            status.dictation,
        )
    }

    @Test
    fun a_gateway_without_the_field_reads_as_no_dictation() {
        val status = OmnesisJson.decodeFromString(
            StatusSnapshot.serializer(),
            """{"documents":{"total":0,"bySource":{}}}""",
        )
        assertNull(status.dictation)
        val partial = OmnesisJson.decodeFromString(DictationStatusDto.serializer(), """{"visible":true}""")
        assertFalse(partial.active)
        assertEquals(0L, partial.maxAudioBytes)
    }

    private companion object {
        val AUDIO = byteArrayOf(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20)
    }
}

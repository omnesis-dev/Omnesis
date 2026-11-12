// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.FinishRecordingBody
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.RecordingChunkMetadata
import dev.omnesis.android.transport.dto.StartRecordingBody
import dev.omnesis.android.transport.dto.StatusSnapshot
import dev.omnesis.android.transport.http.GatewayHttp
import java.io.File
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class RecordingsClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: RecordingsClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = RecordingsClient(GatewayHttp(OkHttpClient(), server.url("/"), "fictional-token"))
    }

    @After fun tearDown() = server.shutdown()

    private val status = """{"id":"3f1c2a9e-0000-4000-8000-000000000001","title":"Q4 budget review","state":"recording",
        |"chunkCount":null,"chunks":{"received":0,"pending":0,"transcribed":0,"failed":0,"silent":0},"projected":false}""".trimMargin()

    @Test fun startPostsTheSessionAndDecodesItsStatus() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody(status))
        val reply = client.start(
            StartRecordingBody(
                id = "3f1c2a9e-0000-4000-8000-000000000001",
                title = "Q4 budget review",
                startedAt = "2026-03-02T09:00:00Z",
                startedTimeZoneId = "Europe/Rome",
                startedUtcOffsetSeconds = 3600,
                language = "en-GB",
            ),
        )
        assertEquals("recording", reply.state)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/recordings", request.path)
        val body = request.body.readUtf8()
        assertTrue(body.contains(""""startedTimeZoneId":"Europe/Rome""""))
    }

    @Test fun putChunkSendsMultipartWithAudio() = runTest {
        server.enqueue(MockResponse().setBody("""{"seq":3,"status":"stored"}"""))
        val audio = File.createTempFile("chunk", ".m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        try {
            val ack = client.putChunk(
                "3f1c2a9e-0000-4000-8000-000000000001",
                3,
                RecordingChunkMetadata(startedAt = "2026-03-02T09:03:00Z", durationMs = 60_000),
                audio,
                "audio/mp4",
            )
            assertEquals(3, ack.seq)
            val request = server.takeRequest()
            assertEquals("PUT", request.method)
            assertEquals("/recordings/3f1c2a9e-0000-4000-8000-000000000001/chunks/3", request.path)
            assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
            val body = request.body.readUtf8()
            assertTrue(body.contains("name=\"chunk\""))
            assertTrue(body.contains("name=\"audio\""))
            assertTrue(body.contains("Content-Type: audio/mp4"))
        } finally {
            audio.delete()
        }
    }

    @Test fun silentChunkHasNoAudioPart() = runTest {
        server.enqueue(MockResponse().setBody("""{"seq":0,"status":"stored"}"""))
        client.putChunk(
            "3f1c2a9e-0000-4000-8000-000000000001",
            0,
            RecordingChunkMetadata(startedAt = "2026-03-02T09:00:00Z", durationMs = 60_000, silent = true),
            null,
            null,
        )
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains(""""silent":true"""))
        assertFalse(body.contains("name=\"audio\""))
    }

    @Test fun finishAndConflictSurfaceAsTypedErrors() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"the recording was finished with a different chunk count","code":"CONFLICT"}"""))
        try {
            client.finish("3f1c2a9e-0000-4000-8000-000000000001", FinishRecordingBody(4, "2026-03-02T10:00:00Z"))
            fail("expected a conflict")
        } catch (e: GatewayException.ServerError) {
            assertEquals(409, e.status)
            assertEquals("CONFLICT", e.code)
        }
        val request = server.takeRequest()
        assertEquals("/recordings/3f1c2a9e-0000-4000-8000-000000000001/finish", request.path)
        assertEquals("""{"chunkCount":4,"endedAt":"2026-03-02T10:00:00Z"}""", request.body.readUtf8())
    }

    @Test fun statusAdvertisesRecordingsOnlyWithTheCapability() {
        val with = OmnesisJson.decodeFromString<StatusSnapshot>("""{"capabilities":{"recordings":{"min":1,"max":1}}}""")
        assertTrue(with.recordings)
        val without = OmnesisJson.decodeFromString<StatusSnapshot>("""{"capabilities":{"taskNoteCapture":{"min":1,"max":1}}}""")
        assertFalse(without.recordings)
        assertFalse(OmnesisJson.decodeFromString<StatusSnapshot>("{}").recordings)
    }
}

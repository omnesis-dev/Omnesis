// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.FinishRecordingBody
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.RecordingChunkMetadata
import dev.omnesis.android.transport.dto.SpeakerMapping
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

    @Test fun listAsksForTheNewestRecordingsAndDecodesThem() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"recordings":[
                |{"id":"r2","title":"Design sync","startedAt":"2026-03-03T10:00:00Z","state":"done","speakers":3,"namedSpeakers":2},
                |{"id":"r1","title":"Conversation","startedAt":"2026-03-02T09:00:00Z","state":"transcribing","speakers":0,"namedSpeakers":0,"future":1}
                |]}""".trimMargin(),
            ),
        )
        val list = client.list(limit = 20)
        assertEquals(listOf("r2", "r1"), list.map { it.id })
        assertEquals(3, list[0].speakers)
        assertEquals(2, list[0].namedSpeakers)
        assertEquals("transcribing", list[1].state)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/recordings?limit=20", request.path)
        assertEquals("no-store", request.getHeader("Cache-Control"))
    }

    @Test fun speakersDecodesMappedAndUnmappedSpeakers() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"speakers":[
                |{"speaker":1,"isSelf":true,"personId":null,"name":null,"talkMs":240000,"samples":["Shall we start?"]},
                |{"speaker":2,"isSelf":false,"personId":"p-1","name":"Maya","talkMs":61000,"samples":["Sounds good.","Next item."]},
                |{"speaker":3,"isSelf":false,"personId":null,"name":null,"talkMs":5000,"samples":[]}
                |]}""".trimMargin(),
            ),
        )
        val speakers = client.speakers("3f1c2a9e-0000-4000-8000-000000000001")
        assertEquals(3, speakers.size)
        assertTrue(speakers[0].isSelf && speakers[0].mapped)
        assertEquals("p-1", speakers[1].personId)
        assertEquals("Maya", speakers[1].name)
        assertEquals(listOf("Sounds good.", "Next item."), speakers[1].samples)
        assertFalse(speakers[2].mapped)
        assertEquals("/recordings/3f1c2a9e-0000-4000-8000-000000000001/speakers", server.takeRequest().path)
    }

    @Test fun speakersOfAnUnknownRecordingIsNotFound() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"recording not found"}"""))
        try {
            client.speakers("3f1c2a9e-0000-4000-8000-000000000009")
            fail("expected not found")
        } catch (_: GatewayException.NotFound) {
        }
    }

    @Test fun setSpeakerSendsExactlyOneMappingKey() = runTest {
        val reply = """{"speakers":[{"speaker":2,"isSelf":false,"personId":null,"name":"Jamie","talkMs":1000,"samples":[]}]}"""
        val cases = listOf(
            SpeakerMapping.Self to """{"self":true}""",
            SpeakerMapping.Person("p-7") to """{"personId":"p-7"}""",
            SpeakerMapping.Name("Jamie") to """{"name":"Jamie"}""",
            SpeakerMapping.Clear to """{"clear":true}""",
        )
        for ((mapping, body) in cases) {
            server.enqueue(MockResponse().setBody(reply))
            val speakers = client.setSpeaker("3f1c2a9e-0000-4000-8000-000000000001", 2, mapping)
            assertEquals("Jamie", speakers.single().name)
            val request = server.takeRequest()
            assertEquals("PUT", request.method)
            assertEquals("/recordings/3f1c2a9e-0000-4000-8000-000000000001/speakers/2", request.path)
            assertEquals(body, request.body.readUtf8())
        }
    }

    @Test fun setSpeakerWithAnUnknownPersonIsABadRequest() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"no such person"}"""))
        try {
            client.setSpeaker("3f1c2a9e-0000-4000-8000-000000000001", 1, SpeakerMapping.Person("missing"))
            fail("expected a bad request")
        } catch (e: GatewayException.ServerError) {
            assertEquals(400, e.status)
        }
    }

    @Test fun statusAdvertisesRecordingsOnlyWithTheCapability() {
        val with = OmnesisJson.decodeFromString<StatusSnapshot>("""{"capabilities":{"recordings":{"min":1,"max":1}}}""")
        assertTrue(with.recordings)
        val without = OmnesisJson.decodeFromString<StatusSnapshot>("""{"capabilities":{"taskNoteCapture":{"min":1,"max":1}}}""")
        assertFalse(without.recordings)
        assertFalse(OmnesisJson.decodeFromString<StatusSnapshot>("{}").recordings)
    }
}

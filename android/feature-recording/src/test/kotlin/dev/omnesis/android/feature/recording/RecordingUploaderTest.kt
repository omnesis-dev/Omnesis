// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.SpeakerMapping
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingUploaderTest {
    private val outbox = InMemoryRecordingOutbox()
    private val dir: File = Files.createTempDirectory("recording-upload").toFile()

    /** Records every call; fails the call named in [failOn] once with [failure]. */
    private class FakeGateway : RecordingsGateway {
        val calls = mutableListOf<String>()
        val chunks = mutableListOf<OutboxChunk>()
        var accepts = true
        var failOn: String? = null
        var failure: GatewayException = GatewayException.Network(IOException("offline"))

        private fun call(name: String) {
            if (name == failOn) {
                failOn = null
                throw failure
            }
            calls += name
        }

        override suspend fun accepting() = accepts
        override suspend fun start(session: OutboxSession) = call("start:${session.id}")
        override suspend fun putChunk(chunk: OutboxChunk) {
            call("chunk:${chunk.sessionId}:${chunk.seq}")
            chunks += chunk
        }
        override suspend fun finish(sessionId: String, chunkCount: Int, endedAt: String) = call("finish:$sessionId:$chunkCount")
        override suspend fun delete(sessionId: String) = call("delete:$sessionId")
        override suspend fun recent(limit: Int) = error("not used by the uploader")
        override suspend fun speakers(sessionId: String) = error("not used by the uploader")
        override suspend fun setSpeaker(sessionId: String, speaker: Int, mapping: SpeakerMapping) =
            error("not used by the uploader")
        override suspend fun searchPeople(query: String, limit: Int) = error("not used by the uploader")
    }

    private val gateway = FakeGateway()
    private val uploader = RecordingUploader(outbox, gateway)

    private fun session(id: String, startedAt: String = "2026-03-02T09:00:00Z") = OutboxSession(
        id = id, title = null, startedAt = startedAt, startedTimeZoneId = "Europe/Rome",
        startedUtcOffsetSeconds = 3600, language = "en-GB", chunkCount = null, endedAt = null,
        created = false, finished = false, refusal = null,
    )

    private fun chunk(id: String, seq: Int, silent: Boolean = false) = OutboxChunk(
        sessionId = id, seq = seq, startedAt = "2026-03-02T09:0$seq:00Z", durationMs = 60_000,
        silent = silent, interrupted = false,
        file = if (silent) null else File(dir, "$id-$seq.m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) },
        mimeType = if (silent) null else "audio/mp4",
    )

    @Test fun sendsStartThenChunksInOrderThenFinish() = runTest {
        outbox.addSession(session("a"))
        outbox.addChunk(chunk("a", 1))
        outbox.addChunk(chunk("a", 0))
        outbox.addChunk(chunk("a", 2, silent = true))
        outbox.markStopped("a", 3, "2026-03-02T09:03:00Z")

        assertEquals(RecordingUploader.Result.Done(sent = 5), uploader.drain())
        assertEquals(listOf("start:a", "chunk:a:0", "chunk:a:1", "chunk:a:2", "finish:a:3"), gateway.calls)
        assertTrue(outbox.sessionsById["a"]!!.finished)
        assertTrue(outbox.chunks.isEmpty())

        // A finished session is never sent again.
        gateway.calls.clear()
        assertEquals(RecordingUploader.Result.Done(sent = 0), uploader.drain())
        assertTrue(gateway.calls.isEmpty())
    }

    @Test fun aSessionStillRecordingIsNotFinished() = runTest {
        outbox.addSession(session("a"))
        outbox.addChunk(chunk("a", 0))
        uploader.drain()
        assertEquals(listOf("start:a", "chunk:a:0"), gateway.calls)
        assertTrue(outbox.sessionsById["a"]!!.created)
    }

    @Test fun sendsNothingToAGatewayWithoutTheCapability() = runTest {
        outbox.addSession(session("a"))
        outbox.addChunk(chunk("a", 0))
        gateway.accepts = false

        assertTrue(uploader.drain() is RecordingUploader.Result.Retry)
        assertTrue(gateway.calls.isEmpty())
        assertEquals(1, outbox.pendingChunks("a").size)
    }

    @Test fun aNetworkFailureStopsAndResumesWhereItStopped() = runTest {
        outbox.addSession(session("a"))
        (0..2).forEach { outbox.addChunk(chunk("a", it)) }
        outbox.markStopped("a", 3, "2026-03-02T09:03:00Z")
        gateway.failOn = "chunk:a:1"

        val first = uploader.drain()
        assertTrue(first is RecordingUploader.Result.Retry)
        assertEquals(listOf("start:a", "chunk:a:0"), gateway.calls)
        assertEquals(listOf(1, 2), outbox.pendingChunks("a").map { it.seq })

        // The next attempt neither restarts the session nor resends chunk 0.
        assertEquals(RecordingUploader.Result.Done(sent = 3), uploader.drain())
        assertEquals(listOf("start:a", "chunk:a:0", "chunk:a:1", "chunk:a:2", "finish:a:3"), gateway.calls)
    }

    @Test fun aRetryableFailureDoesNotHoldBackTheNextSession() = runTest {
        outbox.addSession(session("a", "2026-03-02T09:00:00Z"))
        outbox.addChunk(chunk("a", 0))
        outbox.addSession(session("b", "2026-03-02T11:00:00Z"))
        outbox.addChunk(chunk("b", 0))
        gateway.failOn = "chunk:a:0"
        gateway.failure = GatewayException.ServerError(503, null)

        assertTrue(uploader.drain() is RecordingUploader.Result.Retry)
        assertEquals(listOf("start:a", "start:b", "chunk:b:0"), gateway.calls)
        assertEquals(1, outbox.pendingChunks("a").size)
    }

    @Test fun aNotFoundSendsTheSessionStartAgain() = runTest {
        outbox.addSession(session("a").copy(created = true))
        outbox.addChunk(chunk("a", 0))
        gateway.failOn = "chunk:a:0"
        gateway.failure = GatewayException.NotFound("no such recording")

        assertTrue(uploader.drain() is RecordingUploader.Result.Retry)
        assertNull(outbox.sessionsById["a"]!!.refusal)
        assertFalse(outbox.sessionsById["a"]!!.created)
        val audio = outbox.pendingChunks("a").single().file!!
        assertTrue(audio.exists())

        assertEquals(RecordingUploader.Result.Done(sent = 2), uploader.drain())
        assertEquals(listOf("start:a", "chunk:a:0"), gateway.calls)
    }

    @Test fun aRefusedSessionKeepsItsAudioWithoutBlockingTheNext() = runTest {
        outbox.addSession(session("a", "2026-03-02T09:00:00Z"))
        outbox.addChunk(chunk("a", 0))
        outbox.addSession(session("b", "2026-03-02T11:00:00Z"))
        outbox.addChunk(chunk("b", 0))
        gateway.failOn = "chunk:a:0"
        gateway.failure = GatewayException.ServerError(409, "chunk 0 is past the recording's declared chunk count", "CONFLICT")

        assertEquals(RecordingUploader.Result.Done(sent = 3), uploader.drain())
        assertEquals("chunk 0 is past the recording's declared chunk count", outbox.sessionsById["a"]!!.refusal)
        assertTrue(outbox.pendingChunks("a").single().file!!.exists())
        assertEquals(listOf("start:a", "start:b", "chunk:b:0"), gateway.calls)
    }

    @Test fun aChunkWhoseAudioIsGoneIsSentAsAnInterruptedGap() = runTest {
        outbox.addSession(session("a"))
        val lost = chunk("a", 0)
        lost.file!!.delete()
        outbox.addChunk(lost)
        outbox.addChunk(chunk("a", 1))

        assertEquals(RecordingUploader.Result.Done(sent = 3), uploader.drain())
        val sent = gateway.chunks
        assertTrue(sent[0].silent)
        assertTrue(sent[0].interrupted)
        assertNull(sent[0].file)
        assertNull(sent[0].mimeType)
        assertFalse(sent[1].silent)
        assertEquals("audio/mp4", sent[1].mimeType)
    }

    @Test fun switchedOffTranscriptionKeepsTheAudioForLater() = runTest {
        outbox.addSession(session("a"))
        outbox.addChunk(chunk("a", 0))
        gateway.failOn = "start:a"
        gateway.failure = GatewayException.ServerError(409, "Gateway transcription is switched off.", "DICTATION_DISABLED")

        assertTrue(uploader.drain() is RecordingUploader.Result.Retry)
        assertNull(outbox.sessionsById["a"]!!.refusal)
        assertEquals(1, outbox.pendingChunks("a").size)
    }

    @Test fun classifiesPermanentRefusals() {
        assertNull(RecordingUploader.permanentRefusal(GatewayException.NotFound()))
        assertTrue(RecordingUploader.permanentRefusal(GatewayException.ServerError(400, "bad", "VALIDATION")) != null)
        assertTrue(RecordingUploader.permanentRefusal(GatewayException.ServerError(413, null)) != null)
        assertNull(RecordingUploader.permanentRefusal(GatewayException.ServerError(422, null)))
        assertNull(RecordingUploader.permanentRefusal(GatewayException.ServerError(429, null)))
        assertNull(RecordingUploader.permanentRefusal(GatewayException.ServerError(503, null)))
        assertNull(RecordingUploader.permanentRefusal(GatewayException.Unauthorized()))
        assertNull(RecordingUploader.permanentRefusal(GatewayException.Network(IOException("x"))))
    }
}

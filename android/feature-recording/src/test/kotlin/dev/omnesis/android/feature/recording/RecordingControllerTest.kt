// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import java.io.File
import java.nio.file.Files
import java.time.ZoneId
import java.util.Locale
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingControllerTest {
    private val outbox = InMemoryRecordingOutbox()
    private val root: File = Files.createTempDirectory("recordings").toFile()
    private var now = 1_772_442_000_000L // 2026-03-02T09:00:00Z
    private var queued = 0
    private val controller = RecordingController(
        outbox = outbox,
        files = RecordingFiles(root),
        onWorkQueued = { queued++ },
        clock = { now },
        zone = { ZoneId.of("Europe/Rome") },
        locale = { Locale.UK },
    )

    private fun chunkFile(name: String) = File(root, name).apply { writeBytes(byteArrayOf(1, 2, 3)) }

    @Test fun opensASessionWithTheDevicesTimeZoneAndLanguage() = runTest {
        val active = controller.begin("  Design sync  ")!!
        val session = outbox.sessionsById[active.sessionId]!!
        assertEquals("Design sync", session.title)
        assertEquals("2026-03-02T09:00:00Z", session.startedAt)
        assertEquals("Europe/Rome", session.startedTimeZoneId)
        assertEquals(3600, session.startedUtcOffsetSeconds)
        assertEquals("en-GB", session.language)
        assertEquals(1, queued)
    }

    @Test fun filesChunksAndDropsTheAudioOfSilentOnes() = runTest {
        val active = controller.begin(null)!!
        val loud = chunkFile("chunk-00000.m4a")
        val quiet = chunkFile("chunk-00001.m4a")
        val empty = File(root, "chunk-00002.m4a").apply { createNewFile() }
        controller.chunkClosed(active.sessionId, RecordedChunk(0, now, 60_000, loud, peakAmplitude = 9_000, interrupted = false))
        controller.chunkClosed(active.sessionId, RecordedChunk(1, now + 60_000, 60_000, quiet, peakAmplitude = 120, interrupted = true))
        controller.chunkClosed(active.sessionId, RecordedChunk(2, now + 120_000, 900, empty, peakAmplitude = 9_000, interrupted = false))
        controller.flush()

        val chunks = outbox.pendingChunks(active.sessionId)
        assertFalse(chunks[0].silent)
        assertEquals(loud, chunks[0].file)
        assertEquals(ChunkPolicy.MIME_TYPE, chunks[0].mimeType)
        assertTrue(chunks[1].silent)
        assertTrue(chunks[1].interrupted)
        assertNull(chunks[1].file)
        assertFalse(quiet.exists())
        // An empty file keeps its number as a silent chunk with no length.
        assertTrue(chunks[2].silent)
        assertEquals(0, chunks[2].durationMs)
        assertFalse(empty.exists())
        assertEquals(3, (controller.state.value as RecordingState.Active).chunks)
    }

    @Test fun aLostMicrophoneShowsAsPaused() = runTest {
        controller.begin(null)
        controller.onPaused(micLost = true)
        val paused = controller.state.value as RecordingState.Active
        assertTrue(paused.paused)
        assertTrue(paused.micLost)
        controller.onResumed()
        assertFalse((controller.state.value as RecordingState.Active).micLost)
    }

    @Test fun tracksElapsedTimeAcrossAPause() = runTest {
        controller.begin(null)
        now += 30_000
        controller.onPaused()
        now += 600_000
        val paused = controller.state.value as RecordingState.Active
        assertTrue(paused.paused)
        assertEquals(30_000, paused.elapsedMs(now))
        controller.onResumed()
        now += 15_000
        assertEquals(45_000, (controller.state.value as RecordingState.Active).elapsedMs(now))
    }

    @Test fun stoppingClosesTheSessionAfterItsLastChunk() = runTest {
        val active = controller.begin(null)!!
        now += 120_000
        var closed = false
        // Reported back to back from the main thread, as the service does on Stop.
        controller.chunkClosed(active.sessionId, RecordedChunk(1, now - 60_000, 60_000, chunkFile("chunk-00001.m4a"), 9_000, false))
        controller.stopped(active.sessionId, 2) { closed = true }
        controller.flush()

        val session = outbox.sessionsById[active.sessionId]!!
        assertEquals(listOf(1), outbox.pendingChunks(active.sessionId).map { it.seq })
        assertEquals(2, session.chunkCount)
        assertEquals("2026-03-02T09:02:00Z", session.endedAt)
        assertEquals(RecordingState.Idle, controller.state.value)
        assertTrue(closed)
    }

    @Test fun beginsOnlyOneSessionAtATime() = runTest {
        val first = controller.begin(null)!!
        assertNull(controller.begin(null))
        controller.stopped(first.sessionId, 0)
        // Queued behind the stop, a new start opens a new session.
        val second = controller.begin(null)!!
        assertTrue(second.sessionId != first.sessionId)
    }

    @Test fun aSessionThatNeverRecordedIsDiscarded() = runTest {
        val active = controller.begin(null)!!
        controller.discard(active.sessionId)
        controller.flush()
        assertTrue(outbox.sessionsById.isEmpty())
        assertFalse(File(root, active.sessionId).exists())
        assertEquals(RecordingState.Idle, controller.state.value)
    }

    private fun interruptedSession(id: String) = OutboxSession(
        id = id, title = null, startedAt = "2026-03-02T09:00:00Z", startedTimeZoneId = "Europe/Rome",
        startedUtcOffsetSeconds = 3600, language = "en-GB", chunkCount = null, endedAt = null,
        created = true, finished = false, refusal = null,
    )

    @Test fun recoversARecordingAKillInterrupted() = runTest {
        outbox.addSession(interruptedSession("a"))
        outbox.addChunk(OutboxChunk("a", 0, "2026-03-02T09:00:00Z", 60_000, true, false, null, null))
        outbox.addChunk(OutboxChunk("a", 1, "2026-03-02T09:01:00Z", 60_000, true, false, null, null))
        val dir = File(root, "a").apply { mkdirs() }
        // Chunk 2 was being recorded (30 s of audio); chunk 3 was queued and is empty.
        val recorded = File(dir, ChunkPolicy.fileName(2)).apply {
            writeBytes(ByteArray(120_000))
            setLastModified(1_772_442_150_000L) // 09:02:30
        }
        File(dir, ChunkPolicy.fileName(3)).createNewFile()

        controller.recoverInterrupted()

        val chunks = outbox.pendingChunks("a")
        assertEquals(listOf(0, 1, 2, 3), chunks.map { it.seq })
        assertEquals(recorded, chunks[2].file)
        assertFalse(chunks[2].silent)
        assertTrue(chunks[2].interrupted)
        assertEquals(30_000, chunks[2].durationMs)
        assertEquals("2026-03-02T09:02:00Z", chunks[2].startedAt)
        assertTrue(chunks[3].silent)
        assertTrue(chunks[3].interrupted)
        assertNull(chunks[3].file)
        val session = outbox.sessionsById["a"]!!
        assertEquals(4, session.chunkCount)
        assertEquals("2026-03-02T09:02:30Z", session.endedAt)
        assertTrue(queued > 0)
    }

    @Test fun recoveryClosesAtTheLastFiledChunkAndDropsAnEmptyUnsentSession() = runTest {
        outbox.addSession(interruptedSession("a"))
        outbox.addChunk(OutboxChunk("a", 0, "2026-03-02T09:00:00Z", 45_000, true, false, null, null))
        outbox.addSession(interruptedSession("b").copy(created = false))

        controller.recoverInterrupted()

        assertEquals(1, outbox.sessionsById["a"]!!.chunkCount)
        assertEquals("2026-03-02T09:00:45Z", outbox.sessionsById["a"]!!.endedAt)
        assertNull(outbox.sessionsById["b"])
    }

    @Test fun recoveryLeavesTheActiveSessionAlone() = runTest {
        val active = controller.begin(null)!!
        controller.recoverInterrupted()
        assertNull(outbox.sessionsById[active.sessionId]!!.chunkCount)
        assertEquals(active, controller.state.value)
    }

    @Test fun sweepsDirectoriesTheOutboxNoLongerNames() {
        File(root, "kept").mkdirs()
        File(root, "orphan").mkdirs()
        RecordingFiles(root).sweep(setOf("kept"))
        assertTrue(File(root, "kept").exists())
        assertFalse(File(root, "orphan").exists())
    }

    @Test fun theSilenceGateAndChunkSize() {
        assertTrue(ChunkPolicy.isSilent(0))
        assertFalse(ChunkPolicy.isSilent(ChunkPolicy.SILENCE_PEAK))
        assertEquals(240_000L, ChunkPolicy.maxChunkBytes())
        assertEquals("chunk-00007.m4a", ChunkPolicy.fileName(7))
        assertEquals(7, ChunkPolicy.seqOf("chunk-00007.m4a"))
        assertNull(ChunkPolicy.seqOf("chunk-00007.aac"))
    }
}

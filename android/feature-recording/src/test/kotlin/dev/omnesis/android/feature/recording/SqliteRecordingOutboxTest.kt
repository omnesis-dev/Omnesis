// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SqliteRecordingOutboxTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val outbox = SqliteRecordingOutbox(context, "test-recordings-${System.nanoTime()}.db")

    @After fun tearDown() = outbox.close()

    private fun session(id: String) = OutboxSession(
        id = id, title = "Site walkthrough", startedAt = "2026-03-02T09:00:00Z",
        startedTimeZoneId = "Europe/Rome", startedUtcOffsetSeconds = 3600, language = "en-GB",
        chunkCount = null, endedAt = null, created = false, finished = false, refusal = null,
    )

    private fun chunk(id: String, seq: Int, file: File?) = OutboxChunk(
        sessionId = id, seq = seq, startedAt = "2026-03-02T09:0$seq:00Z", durationMs = 60_000,
        silent = file == null, interrupted = seq == 1, file = file, mimeType = file?.let { "audio/mp4" },
    )

    private fun audioFile() = File.createTempFile("chunk", ".m4a", context.cacheDir).apply { writeBytes(byteArrayOf(9)) }

    @Test fun keepsSessionsAndChunksAcrossReopening() = runTest {
        outbox.addSession(session("a"))
        outbox.addSession(session("a")) // a repeat is ignored
        val file = audioFile()
        outbox.addChunk(chunk("a", 0, file))
        outbox.addChunk(chunk("a", 1, null))
        outbox.markStopped("a", 2, "2026-03-02T09:02:00Z")
        outbox.setCreated("a", true)

        val stored = outbox.sessions().single()
        val expected = session("a").copy(
            chunkCount = 2,
            endedAt = "2026-03-02T09:02:00Z",
            created = true,
            chunksFiled = 2,
            filedUntil = "2026-03-02T09:02:00Z",
        )
        assertEquals(expected, stored)
        outbox.setCreated("a", false)
        assertFalse(outbox.sessions().single().created)
        val chunks = outbox.pendingChunks("a")
        assertEquals(listOf(0, 1), chunks.map { it.seq })
        assertEquals(file.absolutePath, chunks[0].file?.absolutePath)
        assertTrue(chunks[1].silent)
        assertTrue(chunks[1].interrupted)
        assertNull(chunks[1].file)
    }

    @Test fun anAcknowledgedChunkLeavesWithItsFile() = runTest {
        outbox.addSession(session("a"))
        val file = audioFile()
        outbox.addChunk(chunk("a", 0, file))
        outbox.ackChunk("a", 0)
        assertTrue(outbox.pendingChunks("a").isEmpty())
        assertFalse(file.exists())
        outbox.markFinished("a")
        assertTrue(outbox.sessions().single().finished)
    }

    @Test fun anEarlierChunkFiledLateDoesNotMoveTheFiledMarkBack() = runTest {
        outbox.addSession(session("a"))
        outbox.addChunk(chunk("a", 1, null))
        outbox.addChunk(chunk("a", 0, null))
        val stored = outbox.sessions().single()
        assertEquals(2, stored.chunksFiled)
        assertEquals("2026-03-02T09:02:00Z", stored.filedUntil)
    }

    @Test fun refusingKeepsTheAudioAndRemovingDropsIt() = runTest {
        outbox.addSession(session("a"))
        outbox.addSession(session("b"))
        val a = audioFile()
        val b = audioFile()
        outbox.addChunk(chunk("a", 0, a))
        outbox.addChunk(chunk("b", 0, b))

        outbox.markRefused("a", "chunk 0 is past the recording's declared chunk count")
        assertTrue(a.exists())
        assertEquals(1, outbox.pendingChunks("a").size)
        assertEquals("chunk 0 is past the recording's declared chunk count", outbox.sessions().first { it.id == "a" }.refusal)

        outbox.remove("b")
        assertFalse(b.exists())
        outbox.remove("a")
        assertFalse(a.exists())
        assertTrue(outbox.sessions().isEmpty())
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * [VoiceNoteRecorder] against a scripted microphone: every chunk reaches the file, the
 * attached recognizer gets the same samples without being able to stall the recording,
 * pausing resumes the same file, and the size cap stops it growing.
 */
class VoiceNoteRecorderTest {

    /** Hands out queued chunks; blocks briefly when empty, like a microphone between buffers. */
    private class ScriptedSource : PcmSource {
        val chunks = LinkedBlockingQueue<ByteArray>()
        var opens = true
        var started = 0
        @Volatile var recording = false

        override val sampleRateHz = 16_000
        override fun start(): Boolean {
            if (!opens) return false
            started++
            recording = true
            return true
        }
        override fun read(buffer: ByteArray): Int {
            if (!recording) return 0
            val chunk = chunks.poll(20, TimeUnit.MILLISECONDS) ?: return 0
            chunk.copyInto(buffer)
            return chunk.size
        }
        override fun stop() {
            recording = false
        }
        override fun release() {
            recording = false
        }
    }

    private lateinit var dir: File
    private val source = ScriptedSource()

    @Before fun setUp() {
        dir = Files.createTempDirectory("recorder").toFile()
    }

    @After fun tearDown() {
        dir.deleteRecursively()
    }

    private fun chunk(value: Short, samples: Int = 100): ByteArray =
        ByteBuffer.allocate(samples * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
            repeat(samples) { putShort(value) }
        }.array()

    private fun awaitDrained() {
        val deadline = System.currentTimeMillis() + 2_000
        while (source.chunks.isNotEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(5)
        Thread.sleep(50)
    }

    private fun pcmOf(file: File): ByteArray = file.readBytes().copyOfRange(WavWriter.HEADER_BYTES, file.length().toInt())

    @Test
    fun records_every_chunk_into_a_wav_file_and_reports_peaks() {
        val file = File(dir, "a.wav")
        val peaks = LinkedBlockingQueue<Pair<Int, Long>>()
        val recorder = VoiceNoteRecorder(source, file, 0, 60_000, onPeak = { p, t -> peaks.add(p to t) })
        val first = chunk(1_000)
        val second = chunk(-12_000)
        source.chunks.addAll(listOf(first, second))

        assertTrue(recorder.start())
        awaitDrained()
        assertTrue(recorder.finish())

        assertArrayEquals(first + second, pcmOf(file))
        val header = ByteBuffer.wrap(file.readBytes(), 0, WavWriter.HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(400, header.getInt(40))
        assertEquals(436, header.getInt(4))
        assertEquals(16_000, header.getInt(24))
        assertEquals(1_000 to 6L, peaks.poll())
        assertEquals(12_000 to 12L, peaks.poll())
    }

    @Test
    fun the_attached_recognizer_gets_the_same_samples() {
        val file = File(dir, "b.wav")
        val recorder = VoiceNoteRecorder(source, file, 0, 60_000)
        val sink = ByteArrayOutputStream()
        assertTrue(recorder.start())
        recorder.attachSink(sink)
        val spoken = chunk(4_000)
        source.chunks.add(spoken)
        awaitDrained()
        recorder.finish()
        assertArrayEquals(spoken, sink.toByteArray())
        assertArrayEquals(spoken, pcmOf(file))
    }

    @Test
    fun a_recognizer_that_stops_reading_never_stalls_the_recording() {
        val file = File(dir, "c.wav")
        val recorder = VoiceNoteRecorder(source, file, 0, 60_000)
        val blocked = CountDownLatch(1)
        val stuck = object : OutputStream() {
            override fun write(b: Int) = Unit
            override fun write(b: ByteArray, off: Int, len: Int) {
                blocked.await(10, TimeUnit.SECONDS)
            }
        }
        assertTrue(recorder.start())
        recorder.attachSink(stuck)
        val chunks = List(200) { chunk(2_000) }
        source.chunks.addAll(chunks)
        awaitDrained()
        recorder.finish()
        blocked.countDown()
        assertEquals(200 * 200L, pcmOf(file).size.toLong())
    }

    @Test
    fun a_recognizer_that_closes_its_end_is_dropped_and_recording_continues() {
        val file = File(dir, "d.wav")
        val recorder = VoiceNoteRecorder(source, file, 0, 60_000)
        val closed = object : OutputStream() {
            override fun write(b: Int) = throw IOException("EPIPE")
            override fun write(b: ByteArray, off: Int, len: Int) = throw IOException("EPIPE")
        }
        assertTrue(recorder.start())
        recorder.attachSink(closed)
        source.chunks.addAll(listOf(chunk(1), chunk(2), chunk(3)))
        awaitDrained()
        assertTrue(recorder.finish())
        assertEquals(600, pcmOf(file).size)
    }

    @Test
    fun pausing_stops_the_microphone_and_resuming_appends_to_the_same_file() {
        val file = File(dir, "e.wav")
        val recorder = VoiceNoteRecorder(source, file, 0, 60_000)
        assertTrue(recorder.start())
        source.chunks.add(chunk(10))
        awaitDrained()
        recorder.pause()
        assertFalse(source.recording)
        source.chunks.add(chunk(20))
        Thread.sleep(80)
        assertTrue(recorder.resume())
        awaitDrained()
        recorder.finish()
        assertEquals(2, source.started)
        assertArrayEquals(chunk(10) + chunk(20), pcmOf(file))
    }

    @Test
    fun the_size_cap_stops_the_file_growing_and_says_so() {
        val file = File(dir, "f.wav")
        val capped = CountDownLatch(1)
        // Room for 300 bytes of samples after the header.
        val recorder = VoiceNoteRecorder(
            source,
            file,
            maxFileBytes = WavWriter.HEADER_BYTES + 300L,
            maxDurationMs = 60_000,
            onLimitReached = { capped.countDown() },
        )
        assertTrue(recorder.start())
        source.chunks.addAll(listOf(chunk(5), chunk(6), chunk(7)))
        assertTrue(capped.await(2, TimeUnit.SECONDS))
        awaitDrained()
        recorder.finish()
        assertEquals(300, pcmOf(file).size)
    }

    @Test
    fun discard_deletes_the_file_and_a_closed_microphone_does_not_start() {
        val file = File(dir, "g.wav")
        val recorder = VoiceNoteRecorder(source, file, 0, 60_000)
        assertTrue(recorder.start())
        source.chunks.add(chunk(9))
        awaitDrained()
        recorder.discard()
        assertFalse(file.exists())

        source.opens = false
        assertFalse(VoiceNoteRecorder(source, File(dir, "h.wav"), 0, 60_000).start())
    }

    @Test
    fun peak_is_the_largest_absolute_sample() {
        val pcm = chunk(-300, 1) + chunk(250, 1) + chunk(Short.MIN_VALUE, 1)
        assertEquals(300, VoiceNoteRecorder.peakOf(pcm, 4))
        assertEquals(Short.MAX_VALUE.toInt(), VoiceNoteRecorder.peakOf(pcm, 6))
    }
}

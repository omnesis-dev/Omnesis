// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Records the microphone into a WAV file and, at the same time, feeds the same samples
 * to a speech recognizer through [attachSink] — the phone keeps its live transcript while
 * the gateway gets the audio. Only one process can hold the microphone, which is why the
 * app records and the recognizer is handed a copy rather than opening it itself.
 *
 * One reader thread pulls from [source]. The file always gets every chunk (until the
 * size or duration cap); the sink gets them through its own bounded queue and thread, so
 * a recognizer that stops reading can never stall the recording.
 *
 * Pausing stops the microphone and resumes appending to the same file, so one note's
 * audio spans every stretch the person spoke.
 */
class VoiceNoteRecorder(
    private val source: PcmSource,
    private val file: File,
    /** The largest file the gateway takes, header included; 0 for no size cap. */
    maxFileBytes: Long,
    maxDurationMs: Long,
    /** Peak amplitude (0–32767) of each chunk and the audio time so far; called on the reader thread. */
    private val onPeak: (peak: Int, elapsedMs: Long) -> Unit = { _, _ -> },
    /** The cap was reached and the file stopped growing; called on the reader thread. */
    private val onLimitReached: () -> Unit = {},
) {
    private val bytesPerSecond = source.sampleRateHz * WavWriter.BYTES_PER_SAMPLE
    private val dataByteCap: Long = run {
        val byDuration = maxDurationMs * bytesPerSecond / 1000
        if (maxFileBytes > 0) minOf(byDuration, maxFileBytes - WavWriter.HEADER_BYTES) else byDuration
    }

    private val lock = Object()
    private var writer: WavWriter? = null
    private var thread: Thread? = null
    private var running = false
    private var paused = false
    private var capped = false
    private var sink: SinkPump? = null

    /** Opens the microphone and starts recording. False when the microphone cannot be opened. */
    fun start(): Boolean {
        if (!source.start()) {
            source.release()
            return false
        }
        writer = WavWriter(file, source.sampleRateHz)
        running = true
        thread = Thread(::readLoop, "voice-note-recorder").apply { start() }
        return true
    }

    /** Stops the microphone; [resume] appends to the same file. */
    fun pause() {
        synchronized(lock) {
            if (!running || paused) return
            paused = true
        }
        source.stop()
    }

    /** Reopens the microphone after [pause]. False when it cannot be reopened. */
    fun resume(): Boolean {
        synchronized(lock) {
            if (!running || !paused) return running
        }
        if (!source.start()) return false
        synchronized(lock) {
            paused = false
            lock.notifyAll()
        }
        return true
    }

    /** From now on the samples also go to [out], replacing any earlier sink (which is closed). */
    fun attachSink(out: OutputStream) {
        val next = SinkPump(out)
        val previous = synchronized(lock) { sink.also { sink = next } }
        previous?.close()
    }

    fun detachSink() {
        synchronized(lock) { sink.also { sink = null } }?.close()
    }

    /**
     * Stops recording and completes the file. True when it holds any audio; the caller
     * owns the file either way.
     */
    fun finish(): Boolean {
        stopReading()
        val w = writer ?: return false
        writer = null
        w.close()
        return w.dataBytes > 0
    }

    /** Stops recording and deletes the file. */
    fun discard() {
        stopReading()
        writer?.close()
        writer = null
        file.delete()
    }

    private fun stopReading() {
        synchronized(lock) {
            running = false
            lock.notifyAll()
        }
        // Unblocks a read waiting on the microphone before joining the thread.
        source.stop()
        thread?.join(JOIN_TIMEOUT_MS)
        thread = null
        source.release()
        detachSink()
    }

    private fun readLoop() {
        val buffer = ByteArray(CHUNK_BYTES)
        while (true) {
            synchronized(lock) {
                while (running && paused) lock.wait()
                if (!running) return
            }
            val read = source.read(buffer)
            if (read <= 0) {
                // Stopped under us (pause or finish), or a transient error; the flags decide.
                Thread.sleep(IDLE_BACKOFF_MS)
                continue
            }
            val w = writer ?: return
            if (!capped) {
                val room = (dataByteCap - w.dataBytes).coerceAtLeast(0).toInt()
                w.write(buffer, 0, minOf(read, room))
                if (w.dataBytes >= dataByteCap) {
                    capped = true
                    onLimitReached()
                }
            }
            synchronized(lock) { sink }?.offer(buffer.copyOf(read))
            onPeak(peakOf(buffer, read), w.dataBytes * 1000 / bytesPerSecond)
        }
    }

    /**
     * Writes chunks to one recognizer on its own thread. A full queue drops the chunk —
     * the recognizer falling behind costs it audio, never the recording. A write error
     * (the recognizer closed its end) ends the pump.
     */
    private class SinkPump(private val out: OutputStream) {
        private val queue = ArrayBlockingQueue<ByteArray>(QUEUE_CHUNKS)
        @Volatile private var open = true
        private val thread = Thread(::pump, "voice-note-sink").apply { start() }

        fun offer(chunk: ByteArray) {
            if (open) queue.offer(chunk)
        }

        fun close() {
            open = false
            thread.interrupt()
            runCatching { out.close() }
        }

        private fun pump() {
            try {
                while (open) {
                    val chunk = queue.poll(POLL_MS, TimeUnit.MILLISECONDS) ?: continue
                    out.write(chunk)
                    out.flush()
                }
            } catch (_: IOException) {
                open = false
            } catch (_: InterruptedException) {
                open = false
            }
        }
    }

    companion object {
        /** A tenth of a second at 16 kHz mono. */
        const val CHUNK_BYTES = 3_200
        private const val QUEUE_CHUNKS = 64
        private const val POLL_MS = 100L
        private const val IDLE_BACKOFF_MS = 10L
        private const val JOIN_TIMEOUT_MS = 2_000L

        internal fun peakOf(pcm: ByteArray, length: Int): Int {
            var peak = 0
            var i = 0
            while (i + 1 < length) {
                val sample = (pcm[i].toInt() and 0xFF) or (pcm[i + 1].toInt() shl 8)
                peak = maxOf(peak, abs(sample.toShort().toInt()))
                i += 2
            }
            return peak.coerceAtMost(Short.MAX_VALUE.toInt())
        }
    }
}

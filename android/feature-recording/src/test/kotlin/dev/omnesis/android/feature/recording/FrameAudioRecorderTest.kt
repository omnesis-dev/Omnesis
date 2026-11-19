// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import java.io.File
import java.nio.file.Files
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameAudioRecorderTest {
    private val dir: File = Files.createTempDirectory("frames").toFile()
    private val chunks = mutableListOf<RecordedChunk>()
    private var inputLost = 0
    private val input = FakeWearable()
    /** Samples each chunk file received, by name. */
    private val written = mutableMapOf<String, Int>()
    /** Chunk files whose encoder fails to open. */
    private val unopenable = mutableSetOf<String>()
    private var decoderAvailable = true

    private val recorder = FrameAudioRecorder(
        directory = dir,
        input = input,
        onChunk = { chunks += it },
        onInputLost = { inputLost++ },
        decoders = { check(decoderAvailable) { "no Opus decoder" }; FakeDecoder() },
        encoders = { file ->
            if (unopenable.remove(file.name)) throw java.io.IOException("cannot open ${file.name}")
            FakeEncoder(file)
        },
        worker = DirectExecutor(),
        postToMain = { it.run() },
    )

    /** Send [count] frames 20 ms apart, the first arriving at [fromMs]. */
    private fun frames(count: Int, fromMs: Long) {
        repeat(count) { input.sink!!.onFrame(byteArrayOf(1), fromMs + it * 20L) }
    }

    @Test fun aSteadyStreamIsOneChunkTimedFromItsFirstFrame() {
        assertTrue(recorder.start())
        frames(100, fromMs = 10_020)
        recorder.stop()

        assertEquals(1, chunks.size)
        assertEquals(RecordedChunk(0, 10_000, 2_000, File(dir, "chunk-00000.m4a"), interrupted = false), chunks[0])
        assertEquals(100 * 320, written["chunk-00000.m4a"])
        assertFalse(input.streaming)
    }

    @Test fun aChunkClosesAtTheTargetLengthAndTheNextFollowsOnWithoutAGap() {
        recorder.start()
        frames(3_001, fromMs = 20)
        recorder.stop()

        assertEquals(listOf(0, 1), chunks.map { it.seq })
        assertEquals(ChunkPolicy.TARGET_CHUNK_MS, chunks[0].durationMs)
        assertEquals(chunks[0].startedAtMs + chunks[0].durationMs, chunks[1].startedAtMs)
        assertEquals(20L, chunks[1].durationMs)
    }

    @Test fun aLateFrameIsPrecededBySilenceSoTheAudioKeepsTime() {
        recorder.start()
        frames(10, fromMs = 20) // audio up to 200 ms
        input.sink!!.onFrame(byteArrayOf(1), 1_220) // starts at 1200: one second late
        recorder.stop()

        assertEquals(1, chunks.size)
        assertEquals(1_220L, chunks[0].durationMs)
        assertEquals(1_220 * 16, written["chunk-00000.m4a"])
    }

    @Test fun jitterWithinTheLinksOwnBurstsIsNotPadded() {
        recorder.start()
        frames(10, fromMs = 20)
        input.sink!!.onFrame(byteArrayOf(1), 420) // 200 ms late
        recorder.stop()

        assertEquals(11 * 320, written["chunk-00000.m4a"])
    }

    @Test fun aLongPauseClosesTheChunkAndIsFiledAsAnEmptyChunk() {
        recorder.start()
        frames(50, fromMs = 20) // 0..1000
        frames(50, fromMs = 6_020) // 6000..7000
        recorder.stop()

        assertEquals(listOf(0, 1, 2), chunks.map { it.seq })
        assertEquals(1_000L, chunks[0].durationMs)
        assertEquals(1_000L to 5_000L, chunks[1].startedAtMs to chunks[1].durationMs)
        assertEquals(0L, chunks[1].file.length())
        assertEquals(6_000L to 1_000L, chunks[2].startedAtMs to chunks[2].durationMs)
        assertEquals(listOf(false, true, false), chunks.map { it.silence })
        assertEquals(3, recorder.chunksRecorded)
    }

    @Test fun aLostLinkClosesTheChunkAsInterruptedAndStartResumes() {
        recorder.start()
        frames(50, fromMs = 20)
        input.sink!!.onLinkLost()

        assertEquals(1, inputLost)
        assertFalse(recorder.isRecording)
        assertTrue(chunks.single().interrupted)

        assertTrue(recorder.start())
        frames(10, fromMs = 60_020)
        recorder.stop()
        assertEquals(listOf(0, 1), chunks.map { it.seq })
        assertFalse(chunks[1].interrupted)
        assertEquals(60_000L, chunks[1].startedAtMs)
    }

    @Test fun framesAfterAPauseAreDropped() {
        recorder.start()
        val stale = input.sink!!
        frames(10, fromMs = 20)
        recorder.pause()
        stale.onFrame(byteArrayOf(1), 300)
        stale.onLinkLost()

        assertEquals(1, chunks.size)
        assertEquals(0, inputLost)
        assertEquals(1, recorder.chunksRecorded)
    }

    @Test fun aChunkThatCannotBeOpenedLeavesNoHoleInTheNumbers() {
        unopenable += "chunk-00000.m4a"
        recorder.start()
        frames(10, fromMs = 20)
        recorder.stop()
        // The first frame was lost with the file; the next one opened chunk 0.
        assertEquals(listOf(0), chunks.map { it.seq })
        assertEquals(1, recorder.chunksRecorded)
    }

    @Test fun aDecoderThatCannotStartRefusesTheStart() {
        decoderAvailable = false
        assertFalse(recorder.start())
        assertFalse(input.streaming)
        recorder.stop()
        assertTrue(chunks.isEmpty())
    }

    @Test fun aLinkLostBetweenChunksMarksNothingInterrupted() {
        recorder.start()
        input.sink!!.onLinkLost() // nothing written yet
        recorder.start()
        frames(10, fromMs = 20)
        recorder.stop()
        assertFalse(chunks.single().interrupted)
    }

    @Test fun anInputThatIsNotReadyDoesNotStart() {
        input.accept = false
        assertFalse(recorder.start())
        assertFalse(recorder.isRecording)
        recorder.stop()
        assertTrue(chunks.isEmpty())
    }

    @Test fun anUndecodableFrameIsSkipped() {
        recorder.start()
        frames(5, fromMs = 20)
        input.sink!!.onFrame(byteArrayOf(), 120)
        frames(5, fromMs = 140)
        recorder.stop()
        assertEquals(10 * 320, written["chunk-00000.m4a"])
    }

    private class FakeWearable : WearableAudio {
        var accept = true
        var sink: WearableAudio.FrameSink? = null
        var streaming = false
        override val name = "Pendant"
        override val ready = MutableStateFlow(true)
        override fun startStreaming(sink: WearableAudio.FrameSink): Boolean {
            if (!accept) return false
            this.sink = sink
            streaming = true
            return true
        }
        override fun stopStreaming() {
            streaming = false
        }
    }

    /** A 20 ms frame of PCM per input frame; an empty frame does not decode. */
    private class FakeDecoder : OpusDecoder {
        override fun decode(frame: ByteArray): ShortArray {
            require(frame.isNotEmpty()) { "corrupt frame" }
            return ShortArray(320) { 100 }
        }
        override fun close() = Unit
    }

    private inner class FakeEncoder(private val file: File) : PcmChunkEncoder {
        private var samples = 0
        override fun write(pcm: ShortArray, length: Int) {
            samples += length
        }
        override fun finish() {
            written[file.name] = samples
            file.writeBytes(if (samples > 0) byteArrayOf(1) else byteArrayOf())
        }
    }

    private class DirectExecutor : AbstractExecutorService() {
        private var down = false
        override fun execute(command: Runnable) {
            if (down) throw java.util.concurrent.RejectedExecutionException()
            command.run()
        }
        override fun shutdown() {
            down = true
        }
        override fun shutdownNow(): MutableList<Runnable> = mutableListOf<Runnable>().also { down = true }
        override fun isShutdown() = down
        override fun isTerminated() = down
        override fun awaitTermination(timeout: Long, unit: TimeUnit) = true
    }
}

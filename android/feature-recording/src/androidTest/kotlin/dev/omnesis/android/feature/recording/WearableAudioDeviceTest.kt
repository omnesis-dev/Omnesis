// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The platform codecs a wearable's audio goes through, on a device: speech is
 * encoded to 20 ms Opus frames at 16 kHz mono (what a wearable sends),
 * decoded by [MediaCodecOpusDecoder], written by [MediaCodecAacChunkEncoder],
 * and the resulting chunk must read as speech to the recorder's own check.
 */
@RunWith(AndroidJUnit4::class)
class WearableAudioDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val detector = SileroSpeechDetector {
        instrumentation.targetContext.assets.open(SileroSpeechDetector.MODEL_ASSET).use { it.readBytes() }
    }

    @After fun close() = detector.close()

    @Test fun opusFramesBecomeAChunkThatHoldsSpeech() = runBlocking {
        val speech = speech()
        val frames = opusFrames(speech)
        Log.i(TAG, "${speech.size} samples -> ${frames.size} Opus frames, largest ${frames.maxOf { it.size }} bytes")

        val decoded = MediaCodecOpusDecoder().use { decoder ->
            frames.fold(ShortArray(0)) { acc, frame -> acc + decoder.decode(frame) }
        }
        Log.i(TAG, "decoded ${decoded.size} samples")
        // The decoder may hold back its last frame or two.
        assertTrue("decoded ${decoded.size} of ${speech.size}", abs(decoded.size - speech.size) <= 3 * FRAME_SAMPLES)
        assertTrue("decoded audio is silent", decoded.maxOf { abs(it.toInt()) } > 1_000)

        val file = File(instrumentation.targetContext.cacheDir, "wearable.m4a").apply { delete() }
        MediaCodecAacChunkEncoder(file).apply { write(decoded); finish() }
        assertTrue(file.length() > 0)

        val verdict = ChunkSpeechScanner(detector).scan(file)
        assertEquals(SpeechVerdict.Speech, verdict.verdict)
    }

    @Test fun aChunkWithoutAudioIsLeftEmpty() {
        val file = File(instrumentation.targetContext.cacheDir, "empty.m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        MediaCodecAacChunkEncoder(file).finish()
        assertEquals(0L, file.length())
    }

    /** The same invented sentence the JVM speech tests use (Piper, LJ Speech voice), 16 kHz mono 16-bit. */
    private fun speech(): ShortArray {
        val bytes = instrumentation.context.assets.open("vad/speech_16k.wav").use { it.readBytes() }
        val wav = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var at = 12
        while (String(bytes, at, 4, Charsets.US_ASCII) != "data") at += 8 + wav.getInt(at + 4)
        val data = ByteBuffer.wrap(bytes, at + 8, wav.getInt(at + 4)).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        return ShortArray(data.remaining()).also { data.get(it) }
    }

    /** The platform Opus encoder (Android 10+), standing in for the pendant's firmware encoder. */
    private fun opusFrames(pcm: ShortArray): List<ByteArray> {
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, ChunkPolicy.SAMPLE_RATE_HZ, 1)
        format.setInteger(MediaFormat.KEY_BIT_RATE, 32_000)
        format.setInteger(MediaFormat.KEY_COMPLEXITY, 3)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        val info = MediaCodec.BufferInfo()
        val frames = mutableListOf<ByteArray>()
        var at = 0
        var ended = false
        while (true) {
            if (!ended) {
                val index = codec.dequeueInputBuffer(10_000)
                if (index >= 0) {
                    val n = minOf(FRAME_SAMPLES, pcm.size - at)
                    if (n <= 0) {
                        codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        ended = true
                    } else {
                        val buffer = codec.getInputBuffer(index)!!.order(ByteOrder.LITTLE_ENDIAN)
                        buffer.clear()
                        buffer.asShortBuffer().put(pcm, at, n)
                        codec.queueInputBuffer(index, 0, n * 2, at * 1_000_000L / ChunkPolicy.SAMPLE_RATE_HZ, 0)
                        at += n
                    }
                }
            }
            val out = codec.dequeueOutputBuffer(info, 10_000)
            if (out >= 0) {
                val buffer = codec.getOutputBuffer(out)!!
                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
                    buffer.position(info.offset).limit(info.offset + info.size)
                    frames += ByteArray(info.size).also { buffer.get(it) }
                }
                codec.releaseOutputBuffer(out, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
            }
        }
        codec.stop()
        codec.release()
        return frames
    }

    private companion object {
        const val TAG = "Omnesis:WearableAudioTest"
        const val FRAME_SAMPLES = 320 // 20 ms at 16 kHz
    }
}

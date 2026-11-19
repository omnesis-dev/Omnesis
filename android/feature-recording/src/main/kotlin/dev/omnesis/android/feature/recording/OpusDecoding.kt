// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.media.MediaCodec
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Turns the Opus frames a wearable sends into mono 16-bit PCM at
 * [ChunkPolicy.SAMPLE_RATE_HZ]. Output may lag the input by a frame or so:
 * [decode] returns whatever the codec has produced so far.
 */
interface OpusDecoder : AutoCloseable {
    fun decode(frame: ByteArray): ShortArray
}

/**
 * Low-pass filter and keep every [factor]th sample: the codec's 48 kHz output
 * down to 16 kHz. A windowed-sinc FIR whose cutoff sits below the new Nyquist,
 * carrying its history across calls so frame boundaries leave no clicks.
 */
class Decimator(private val factor: Int, taps: Int = 63) {
    private val kernel: FloatArray
    private val history: FloatArray
    private var phase = 0

    init {
        require(factor >= 1 && taps % 2 == 1)
        val cutoff = 0.9 / (2.0 * factor) // fraction of the input rate
        val mid = taps / 2
        val k = DoubleArray(taps) { i ->
            val n = (i - mid).toDouble()
            val sinc = if (n == 0.0) 2 * cutoff else sin(2 * PI * cutoff * n) / (PI * n)
            sinc * (0.54 - 0.46 * cos(2 * PI * i / (taps - 1))) // Hamming
        }
        val sum = k.sum()
        kernel = FloatArray(taps) { (k[it] / sum).toFloat() }
        history = FloatArray(taps)
    }

    fun process(input: ShortArray, length: Int = input.size): ShortArray {
        if (factor == 1) return input.copyOf(length)
        val out = ShortArray((length + phase) / factor + 1)
        var n = 0
        for (i in 0 until length) {
            System.arraycopy(history, 1, history, 0, history.size - 1)
            history[history.size - 1] = input[i].toFloat()
            if (phase == 0) {
                var acc = 0f
                for (t in kernel.indices) acc += kernel[t] * history[t]
                out[n++] = acc.roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
            }
            phase = (phase + 1) % factor
        }
        return out.copyOf(n)
    }
}

/**
 * The platform's Opus decoder (present since Android 5). It always decodes to
 * 48 kHz, so its output goes through a [Decimator]; should a device hand back
 * another whole multiple of 16 kHz, the factor follows the format it reports.
 */
class MediaCodecOpusDecoder(
    private val frameDurationUs: Long = 20_000,
) : OpusDecoder {
    private val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
    private val info = MediaCodec.BufferInfo()
    private var decimator = Decimator(DECODE_RATE / ChunkPolicy.SAMPLE_RATE_HZ)
    private var frames = 0L

    init {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, DECODE_RATE, 1)
        format.setByteBuffer("csd-0", opusHead(ChunkPolicy.SAMPLE_RATE_HZ))
        format.setByteBuffer("csd-1", nanos(0)) // codec delay
        format.setByteBuffer("csd-2", nanos(80_000_000)) // seek pre-roll
        codec.configure(format, null, null, 0)
        codec.start()
    }

    override fun decode(frame: ByteArray): ShortArray {
        var out = ShortArray(0)
        // A codec with no free input buffer is drained until it takes the frame.
        repeat(MAX_INPUT_WAITS) {
            val index = codec.dequeueInputBuffer(TIMEOUT_US)
            if (index >= 0) {
                val buffer = codec.getInputBuffer(index)!!
                buffer.clear()
                buffer.put(frame)
                codec.queueInputBuffer(index, 0, frame.size, frames++ * frameDurationUs, 0)
                return out + drain()
            }
            out += drain()
        }
        error("Opus decoder took no input")
    }

    private fun drain(): ShortArray {
        var out = ShortArray(0)
        while (true) {
            val index = codec.dequeueOutputBuffer(info, 0)
            when {
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val rate = codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    check(rate % ChunkPolicy.SAMPLE_RATE_HZ == 0) { "Opus decoder output at $rate Hz" }
                    decimator = Decimator(rate / ChunkPolicy.SAMPLE_RATE_HZ)
                }
                index >= 0 -> {
                    val buffer = codec.getOutputBuffer(index)!!
                    buffer.position(info.offset).limit(info.offset + info.size)
                    val pcm = ShortArray(info.size / 2)
                    buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(pcm)
                    codec.releaseOutputBuffer(index, false)
                    out += decimator.process(pcm)
                }
                else -> return out
            }
        }
    }

    override fun close() {
        runCatching { codec.stop() }
        codec.release()
    }

    private companion object {
        const val DECODE_RATE = 48_000
        const val TIMEOUT_US = 10_000L
        const val MAX_INPUT_WAITS = 20

        /** RFC 7845 identification header: version 1, mono, no pre-skip, family 0. */
        fun opusHead(inputRate: Int): ByteBuffer = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("OpusHead".toByteArray(Charsets.US_ASCII))
            put(1); put(1); putShort(0); putInt(inputRate); putShort(0); put(0)
            flip()
        }

        fun nanos(value: Long): ByteBuffer =
            ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(value).apply { flip() }
    }
}

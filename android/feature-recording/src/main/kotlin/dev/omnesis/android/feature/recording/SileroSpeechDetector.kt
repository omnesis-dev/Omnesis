// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * [SpeechDetector] backed by Silero VAD (MIT, bundled as
 * [MODEL_ASSET]) on ONNX Runtime, on one CPU thread. The model is loaded on
 * the first frame, from [loadModel]. Each call feeds the frame with the last
 * [CONTEXT_SAMPLES] samples of the previous one and carries the model's
 * recurrent state forward, as Silero's own wrapper does.
 */
class SileroSpeechDetector(private val loadModel: () -> ByteArray) : SpeechDetector, AutoCloseable {
    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private var session: OrtSession? = null
    private val input = FloatArray(CONTEXT_SAMPLES + ChunkPolicy.FRAME_SAMPLES)
    private var state = FloatArray(STATE_SIZE)

    override fun reset() {
        input.fill(0f)
        state = FloatArray(STATE_SIZE)
    }

    override fun probability(frame: FloatArray): Float {
        require(frame.size == ChunkPolicy.FRAME_SAMPLES) { "A frame is ${ChunkPolicy.FRAME_SAMPLES} samples, not ${frame.size}" }
        val s = session ?: open().also { session = it }
        // input = the previous frame's last samples, then this frame.
        frame.copyInto(input, CONTEXT_SAMPLES)
        val probability = OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, input.size.toLong())).use { x ->
            OnnxTensor.createTensor(env, FloatBuffer.wrap(state), longArrayOf(2, 1, 128)).use { h ->
                OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(ChunkPolicy.SAMPLE_RATE_HZ.toLong())), longArrayOf()).use { sr ->
                    s.run(mapOf("input" to x, "state" to h, "sr" to sr)).use { out ->
                        @Suppress("UNCHECKED_CAST")
                        val next = out[1].value as Array<Array<FloatArray>>
                        state = FloatArray(STATE_SIZE).also { flat ->
                            var i = 0
                            for (plane in next) for (row in plane) for (v in row) flat[i++] = v
                        }
                        @Suppress("UNCHECKED_CAST")
                        (out[0].value as Array<FloatArray>)[0][0]
                    }
                }
            }
        }
        input.copyInto(input, 0, input.size - CONTEXT_SAMPLES, input.size)
        return probability
    }

    private fun open(): OrtSession {
        val options = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(1)
            setInterOpNumThreads(1)
        }
        return options.use { env.createSession(loadModel(), it) }
    }

    override fun close() {
        session?.close()
        session = null
    }

    companion object {
        /** Silero VAD v6.2.3, the 16 kHz-only export (`silero_vad_16k_op15.onnx`). */
        const val MODEL_ASSET = "silero_vad.onnx"
        const val CONTEXT_SAMPLES = 64
        private const val STATE_SIZE = 2 * 1 * 128
    }
}

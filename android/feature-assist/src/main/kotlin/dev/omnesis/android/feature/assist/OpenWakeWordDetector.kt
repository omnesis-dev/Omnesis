// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import java.io.IOException
import java.nio.FloatBuffer

/** The ONNX models openWakeWord runs in turn, as bytes. */
class OpenWakeWordModels(
    val melspectrogram: ByteArray,
    val embedding: ByteArray,
    /** One classifier per wake word, such as `hey_jarvis`, in the order the detector scores them. */
    val classifiers: List<ByteArray>,
)

/**
 * [WakeWordDetector] on openWakeWord's streaming pipeline, run on ONNX
 * Runtime on one CPU thread, as its Python reference does it:
 *
 * 1. every 80 ms of audio, with 30 ms of the frame before it, becomes rows of
 *    a 32-band mel spectrogram (scaled `x / 10 + 2`);
 * 2. the last 76 rows (775 ms) become one 96-value speech embedding;
 * 3. the last 16 embeddings (1.28 s) are scored by each wake word's classifier.
 *
 * The first two steps are the costly ones and are shared: listening for
 * another word adds one small classifier run per frame.
 *
 * Until 16 embeddings of real audio have been heard every score is 0, so a
 * fresh or [reset] detector never fires on its own padding. The models are
 * opened on the first frame, from [loadModels], which must hold [words]
 * classifiers.
 */
class OpenWakeWordDetector(
    override val words: Int,
    private val loadModels: () -> OpenWakeWordModels,
) : WakeWordDetector, AutoCloseable {
    override val frameSamples = FRAME_SAMPLES

    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private var sessions: Sessions? = null

    private class Sessions(val mel: OrtSession, val embedding: OrtSession, val classifiers: List<OrtSession>) {
        fun close() {
            mel.close()
            embedding.close()
            classifiers.forEach { it.close() }
        }
    }

    /** The previous frame's last [CONTEXT_SAMPLES], then this frame, as floats in the int16 range. */
    private val audio = FloatArray(CONTEXT_SAMPLES + FRAME_SAMPLES)
    private val mel = ArrayDeque<FloatArray>()
    private val embeddings = ArrayDeque<FloatArray>()
    private var heard = 0

    override fun reset() {
        audio.fill(0f)
        mel.clear()
        embeddings.clear()
        heard = 0
    }

    override fun score(frame: ShortArray): FloatArray {
        require(frame.size == FRAME_SAMPLES) { "A frame is $FRAME_SAMPLES samples, not ${frame.size}" }
        val s = sessions ?: open().also { sessions = it }
        if (mel.isEmpty()) repeat(EMBEDDING_ROWS) { mel.addLast(FloatArray(MEL_BANDS) { 1f }) }

        for (i in frame.indices) audio[CONTEXT_SAMPLES + i] = frame[i].toFloat()
        for (row in melRows(s.mel)) mel.addLast(row)
        while (mel.size > EMBEDDING_ROWS) mel.removeFirst()
        audio.copyInto(audio, 0, audio.size - CONTEXT_SAMPLES, audio.size)

        embeddings.addLast(embed(s.embedding))
        while (embeddings.size > CLASSIFIER_FRAMES) embeddings.removeFirst()
        heard++
        if (heard < CLASSIFIER_FRAMES) return FloatArray(words)
        val window = classifierInput()
        return FloatArray(words) { classify(s.classifiers[it], window) }
    }

    private fun melRows(session: OrtSession): List<FloatArray> =
        OnnxTensor.createTensor(env, FloatBuffer.wrap(audio), longArrayOf(1, audio.size.toLong())).use { x ->
            session.run(mapOf(session.inputNames.first() to x)).use { out ->
                val flat = (out[0] as OnnxTensor).floatBuffer
                val rows = flat.remaining() / MEL_BANDS
                List(rows) { FloatArray(MEL_BANDS) { flat.get() / 10f + 2f } }
            }
        }

    private fun embed(session: OrtSession): FloatArray {
        val input = FloatArray(EMBEDDING_ROWS * MEL_BANDS)
        mel.forEachIndexed { r, row -> row.copyInto(input, r * MEL_BANDS) }
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, EMBEDDING_ROWS.toLong(), MEL_BANDS.toLong(), 1)).use { x ->
            session.run(mapOf(session.inputNames.first() to x)).use { out ->
                val flat = (out[0] as OnnxTensor).floatBuffer
                FloatArray(flat.remaining()).also { flat.get(it) }
            }
        }
    }

    private fun classifierInput(): FloatArray {
        val width = embeddings.first().size
        val input = FloatArray(CLASSIFIER_FRAMES * width)
        embeddings.forEachIndexed { r, row -> row.copyInto(input, r * width) }
        return input
    }

    private fun classify(session: OrtSession, input: FloatArray): Float {
        val width = input.size / CLASSIFIER_FRAMES
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, CLASSIFIER_FRAMES.toLong(), width.toLong())).use { x ->
            session.run(mapOf(session.inputNames.first() to x)).use { out ->
                (out[0] as OnnxTensor).floatBuffer.get(0)
            }
        }
    }

    private fun open(): Sessions {
        val models = loadModels()
        require(models.classifiers.size == words) { "Expected $words classifiers, got ${models.classifiers.size}" }
        return options().use {
            Sessions(
                env.createSession(models.melspectrogram, it),
                env.createSession(models.embedding, it),
                models.classifiers.map { bytes -> env.createSession(bytes, it) },
            )
        }
    }

    override fun close() {
        sessions?.close()
        sessions = null
    }

    companion object {
        private fun options() = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(1)
            setInterOpNumThreads(1)
        }

        /**
         * Throws [IOException] unless [bytes] is an ONNX model shaped like an
         * openWakeWord classifier: one float input of 16 embeddings of 96 values.
         */
        fun checkClassifier(bytes: ByteArray) {
            val env = OrtEnvironment.getEnvironment()
            try {
                options().use { o ->
                    env.createSession(bytes, o).use { session ->
                        val info = session.inputInfo.values.singleOrNull()?.info as? TensorInfo
                            ?: throw IOException("not a wake-word classifier: it needs one input")
                        val shape = info.shape
                        if (shape.size != 3 || shape[1] != CLASSIFIER_FRAMES.toLong() || shape[2] != EMBEDDING_WIDTH.toLong()) {
                            throw IOException("not a wake-word classifier: its input is ${shape.joinToString("×")}")
                        }
                    }
                }
            } catch (e: OrtException) {
                throw IOException("not an ONNX model the phone can run: ${e.message}")
            }
        }

        /** 80 ms at 16 kHz, the step openWakeWord's models were trained on. */
        const val FRAME_SAMPLES = 1_280
        const val CONTEXT_SAMPLES = 480
        const val MEL_BANDS = 32
        const val EMBEDDING_ROWS = 76
        const val CLASSIFIER_FRAMES = 16
        const val EMBEDDING_WIDTH = 96
    }
}

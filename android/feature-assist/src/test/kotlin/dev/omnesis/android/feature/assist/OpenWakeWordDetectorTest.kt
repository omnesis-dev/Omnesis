// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random

/**
 * The detector on the real openWakeWord models. They are not in the
 * repository (see [WakeWordModelCatalog]); point `OMNESIS_OWW_MODELS` at a
 * directory holding the catalogue's files to run it.
 */
class OpenWakeWordDetectorTest {
    private val dir = System.getenv("OMNESIS_OWW_MODELS")?.let(::File)

    private fun detector(vararg words: WakeWord = arrayOf(WakeWordModelCatalog.HEY_JARVIS)): OpenWakeWordDetector {
        assumeTrue("OMNESIS_OWW_MODELS not set", dir?.isDirectory == true)
        assumeTrue("models missing", words.all { File(dir, it.fileName).isFile })
        return OpenWakeWordDetector(words.size) {
            OpenWakeWordModels(
                melspectrogram = File(dir, WakeWordModelCatalog.MELSPECTROGRAM.fileName).readBytes(),
                embedding = File(dir, WakeWordModelCatalog.EMBEDDING.fileName).readBytes(),
                classifiers = words.map { File(dir, it.fileName).readBytes() },
            )
        }
    }

    private fun frames(seconds: Int, sample: (Int) -> Short): List<ShortArray> =
        List(seconds * 16_000 / 1_280) { f -> ShortArray(1_280) { i -> sample(f * 1_280 + i) } }

    @Test fun theModelsRunAndStaySilentUntilEnoughIsHeard() {
        val d = detector()
        val scores = frames(3) { 0 }.map { d.score(it).single() }
        assertEquals(List(15) { 0f }, scores.take(15))
        assertTrue(scores.all { it in 0f..1f })
        d.close()
    }

    @Test fun silenceNoiseAndToneNeverFire() {
        val d = detector()
        val random = Random(7)
        val audio = frames(5) { 0 } +
            frames(10) { (random.nextGaussian() * 2_000).toInt().toShort() } +
            frames(10) { (sin(2 * PI * 440 * it / 16_000) * 6_000).toInt().toShort() }
        val max = audio.maxOf { d.score(it).single() }
        assertTrue("highest score $max", max < 0.5f)
        d.close()
    }

    @Test fun resetForgetsWhatWasHeard() {
        val d = detector()
        frames(3) { 0 }.forEach { d.score(it) }
        d.reset()
        assertEquals(0f, d.score(ShortArray(1_280)).single())
        d.close()
    }

    @Test fun severalWordsShareOneDetectorAndScoreLikeEachAlone() {
        val words = arrayOf(WakeWordModelCatalog.OK_HOME, WakeWordModelCatalog.HEY_JARVIS, WakeWordModelCatalog.ALEXA)
        val both = detector(*words)
        val alone = words.map { detector(it) }
        val random = Random(3)
        val audio = frames(2) { 0 } + frames(4) { (random.nextGaussian() * 3_000).toInt().toShort() }
        for (frame in audio) {
            val together = both.score(frame)
            assertEquals(words.size, together.size)
            alone.forEachIndexed { i, d -> assertEquals(d.score(frame).single(), together[i], 1e-5f) }
        }
        both.close()
        alone.forEach { it.close() }
    }

    @Test fun everyCatalogueClassifierPassesTheImportCheckAndTheSharedModelsDoNot() {
        assumeTrue("OMNESIS_OWW_MODELS not set", dir?.isDirectory == true)
        val present = WakeWordModelCatalog.words.filter { File(dir, it.fileName).isFile }
        assumeTrue("no catalogue classifier present", present.isNotEmpty())
        present.forEach { OpenWakeWordDetector.checkClassifier(File(dir, it.fileName).readBytes()) }
        try {
            OpenWakeWordDetector.checkClassifier(File(dir, WakeWordModelCatalog.EMBEDDING.fileName).readBytes())
            org.junit.Assert.fail("the embedding model is not a classifier")
        } catch (_: java.io.IOException) {
        }
    }

    @Test fun bytesThatAreNotAModelFailTheImportCheck() {
        try {
            OpenWakeWordDetector.checkClassifier(ByteArray(64) { it.toByte() })
            org.junit.Assert.fail("expected a refusal")
        } catch (_: java.io.IOException) {
        }
    }

    /**
     * With `OMNESIS_OWW_SAMPLES` pointing at 16 kHz mono 16-bit WAVs, each
     * `jarvis*.wav` must fire and each other WAV must not, with a second of
     * silence before and after so the detector has heard enough.
     */
    @Test fun recordedSamplesFireOnlyOnTheWakeWord() {
        val samples = System.getenv("OMNESIS_OWW_SAMPLES")?.let(::File)
        assumeTrue("OMNESIS_OWW_SAMPLES not set", samples?.isDirectory == true)
        val wavs = samples!!.listFiles { f -> f.name.endsWith(".wav") }!!.sortedBy { it.name }
        assumeTrue("no samples", wavs.isNotEmpty())
        for (wav in wavs) {
            val d = detector()
            val pcm = ShortArray(16_000) + readPcm16(wav) + ShortArray(16_000)
            val max = (0 until pcm.size / 1_280).maxOf { d.score(pcm.copyOfRange(it * 1_280, (it + 1) * 1_280)).single() }
            d.close()
            println("${wav.name}: highest score $max")
            if (wav.name.startsWith("jarvis")) {
                assertTrue("${wav.name} did not fire ($max)", max >= 0.5f)
            } else {
                assertTrue("${wav.name} fired ($max)", max < 0.5f)
            }
        }
    }

    /** The samples of a 16-bit mono WAV, skipping its header chunks. */
    private fun readPcm16(file: File): ShortArray {
        val bytes = file.readBytes()
        var at = 12
        while (at + 8 <= bytes.size) {
            val id = String(bytes, at, 4, Charsets.US_ASCII)
            val size = java.nio.ByteBuffer.wrap(bytes, at + 4, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int
            if (id == "data") {
                val data = java.nio.ByteBuffer.wrap(bytes, at + 8, minOf(size, bytes.size - at - 8)).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                return ShortArray(data.remaining()).also { data.get(it) }
            }
            at += 8 + size
        }
        error("${file.name} has no data chunk")
    }

    private fun Random.nextGaussian(): Double {
        // Box–Muller, enough for test noise.
        val u = nextDouble().coerceAtLeast(1e-12)
        val v = nextDouble()
        return kotlin.math.sqrt(-2 * kotlin.math.ln(u)) * kotlin.math.cos(2 * PI * v)
    }
}

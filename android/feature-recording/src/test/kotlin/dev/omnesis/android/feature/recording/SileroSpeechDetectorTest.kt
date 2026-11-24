// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.random.Random
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bundled Silero model on the desktop ONNX Runtime (same `ai.onnxruntime`
 * API as the Android build). The positive case matters most: a mis-wired
 * tensor that always scores 0 would pass every silence and noise case.
 */
class SileroSpeechDetectorTest {
    private val model = File("src/main/assets/${SileroSpeechDetector.MODEL_ASSET}")
    private val detector = SileroSpeechDetector { model.readBytes() }

    @After fun close() = detector.close()

    @Test fun theBundledModelIsThePinnedRelease() {
        val digest = MessageDigest.getInstance("SHA-256").digest(model.readBytes()).joinToString("") { "%02x".format(it) }
        assertEquals("7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49", digest)
    }

    @Test fun hearsSpeech() {
        val scan = scanForSpeech(pcmOf(speech()), detector)
        assertEquals(SpeechVerdict.Speech, scan.verdict)
        assertTrue("found within the first two seconds, not ${scan.speechAtMs} ms", scan.speechAtMs!! < 2_000)
    }

    @Test fun hearsAQuietVoiceFarBelowTheOldPeakGate() {
        // 2% of full scale: a peak around 600 of 32767, where the amplitude gate stopped at 500.
        val quiet = speech().map { (it * 0.02).toInt().toShort() }.toShortArray()
        assertEquals(SpeechVerdict.Speech, scanForSpeech(pcmOf(quiet), detector).verdict)
    }

    @Test fun silenceNoiseAndClicksAreNotSpeech() {
        val seconds = 5 * ChunkPolicy.SAMPLE_RATE_HZ
        val random = Random(7)
        val silence = ShortArray(seconds)
        val noise = ShortArray(seconds) { (random.nextGaussian() * 3_000).toInt().toShort() }
        val clicks = ShortArray(seconds) { if (random.nextDouble() < 0.001) 30_000 else 0 }
        for (audio in listOf(silence, noise, clicks)) {
            val scan = scanForSpeech(pcmOf(audio), detector)
            assertEquals(SpeechVerdict.NoSpeech, scan.verdict)
            assertTrue(scan.maxProbability < ChunkPolicy.SPEECH_THRESHOLD)
        }
    }

    @Test fun stateDoesNotLeakFromOneChunkToTheNext() {
        assertEquals(SpeechVerdict.Speech, scanForSpeech(pcmOf(speech()), detector).verdict)
        assertEquals(SpeechVerdict.NoSpeech, scanForSpeech(pcmOf(ShortArray(ChunkPolicy.SAMPLE_RATE_HZ)), detector).verdict)
    }

    /** An invented sentence from a public-domain-trained voice (Piper, LJ Speech), 16 kHz mono 16-bit. */
    private fun speech(): ShortArray {
        val bytes = javaClass.getResourceAsStream("/vad/speech_16k.wav")!!.use { it.readBytes() }
        val wav = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var at = 12 // after "RIFF", the size and "WAVE"
        while (String(bytes, at, 4, Charsets.US_ASCII) != "data") at += 8 + wav.getInt(at + 4)
        val data = ByteBuffer.wrap(bytes, at + 8, wav.getInt(at + 4)).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        return ShortArray(data.remaining()).also { data.get(it) }
    }

    private fun pcmOf(samples: ShortArray): PcmSource {
        var at = 0
        return PcmSource { into ->
            if (at >= samples.size) return@PcmSource -1
            val n = minOf(into.size, samples.size - at)
            samples.copyInto(into, 0, at, at + n)
            at += n
            n
        }
    }

    private fun Random.nextGaussian(): Double {
        val u = nextDouble().coerceAtLeast(1e-12)
        return kotlin.math.sqrt(-2 * kotlin.math.ln(u)) * kotlin.math.cos(2 * Math.PI * nextDouble())
    }
}

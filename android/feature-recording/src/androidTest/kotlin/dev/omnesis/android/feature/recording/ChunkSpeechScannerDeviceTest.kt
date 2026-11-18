// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The part of the speech check a JVM test cannot reach: the platform AAC
 * decoder and the Android ONNX Runtime, on chunks in the recorder's format
 * (AAC in MPEG-4, 16 kHz mono, 32 kbit/s). The speech fixture is an invented
 * sentence from a voice trained on public-domain recordings.
 */
@RunWith(AndroidJUnit4::class)
class ChunkSpeechScannerDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val detector = SileroSpeechDetector {
        instrumentation.targetContext.assets.open(SileroSpeechDetector.MODEL_ASSET).use { it.readBytes() }
    }
    private val scanner = ChunkSpeechScanner(detector)

    @After fun close() = detector.close()

    private fun chunk(name: String): File =
        File(instrumentation.targetContext.cacheDir, name).also { out ->
            instrumentation.context.assets.open("vad/$name").use { input -> out.outputStream().use { input.copyTo(it) } }
        }

    @Test fun aChunkWhoseSpeechRunsToTheEndKeepsTheNextOne() = runBlocking {
        // One second of silence, then speech up to the last moment.
        assertEquals(ChunkSpeech(SpeechVerdict.Speech, speechAtEnd = true), scanner.scan(chunk("speech.m4a")))
    }

    @Test fun aChunkWhoseSpeechEndsEarlyDoesNot() = runBlocking {
        // The same speech, then four seconds of silence: the last two hold none.
        assertEquals(ChunkSpeech(SpeechVerdict.Speech, speechAtEnd = false), scanner.scan(chunk("speech_then_silence.m4a")))
    }

    @Test fun aSilentChunkIsNoSpeech() = runBlocking {
        assertEquals(ChunkSpeech(SpeechVerdict.NoSpeech, speechAtEnd = false), scanner.scan(chunk("silence.m4a")))
    }

    @Test fun aFileThatIsNotAudioIsUnknown() = runBlocking {
        val garbage = File(instrumentation.targetContext.cacheDir, "garbage.m4a").apply { writeBytes(ByteArray(4_096) { it.toByte() }) }
        assertEquals(ChunkSpeech(SpeechVerdict.Unknown, speechAtEnd = true), scanner.scan(garbage))
    }
}

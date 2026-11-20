// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import dev.omnesis.android.feature.recording.SpeechDetector
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class CommandListenerTest {
    /**
     * Word i fires on a frame at least half [WAKE] + i, so a wake word across
     * two frames fires once; [loud] words score higher than the others.
     */
    private class FakeWake(override val words: Int = 1, private val loud: Set<Int> = emptySet()) : WakeWordDetector {
        override val frameSamples = 1_280
        var resets = 0
        override fun reset() {
            resets++
        }

        override fun score(frame: ShortArray): FloatArray = FloatArray(words) { w ->
            val heard = frame.count { it == (WAKE + w).toShort() } >= frame.size / 2
            when {
                !heard -> 0.01f
                w in loud -> 0.95f
                else -> 0.9f
            }
        }
    }

    /** Speech is anything loud. */
    private class FakeSpeech : SpeechDetector {
        override fun reset() = Unit
        override fun probability(frame: FloatArray): Float = if (frame.map { abs(it) }.average() > 0.1) 0.95f else 0.05f
    }

    private val events = mutableListOf<String>()
    private val commands = mutableListOf<ShortArray>()
    private val words = mutableListOf<Int>()
    private var wake = FakeWake()

    private fun listener(
        policy: CommandListenerPolicy = CommandListenerPolicy(),
        thresholds: FloatArray = FloatArray(wake.words) { 0.5f },
    ) = CommandListener(
        wake = wake,
        speech = FakeSpeech(),
        thresholds = thresholds,
        onWake = { events += "wake" },
        onCommand = { word, pcm -> events += "command"; words += word; commands += pcm },
        onDiscarded = { events += "discarded" },
        policy = policy,
    )

    private fun ms(n: Long) = (n * 16).toInt()
    private fun silence(msLong: Long) = ShortArray(ms(msLong))
    private fun speech(msLong: Long) = ShortArray(ms(msLong)) { SPEECH }
    private fun wakeWord(word: Int = 0) = ShortArray(1_280) { (WAKE + word).toShort() }

    @Test fun theWakeWordThenSpeechThenQuietSendsTheCommand() {
        val l = listener()
        l.accept(silence(400))
        l.accept(wakeWord())
        assertEquals(listOf("wake"), events)
        l.accept(speech(1_500))
        l.accept(silence(1_200))
        assertEquals(listOf("wake", "command"), events)
        // The command holds the frame that fired, the speech and the quiet that ended it.
        val command = commands.single()
        assertEquals(1_280, command.count { it == WAKE })
        assertEquals(ms(1_500), command.count { it == SPEECH })
        assertTrue(command.size < ms(1_500 + 1_200))
    }

    @Test fun audioFedInOddPiecesIsTheSame() {
        val l = listener()
        val all = silence(300) + wakeWord() + speech(1_000) + silence(1_200)
        var at = 0
        var step = 1
        while (at < all.size) {
            val n = minOf(step, all.size - at)
            l.accept(all.copyOfRange(at, at + n))
            at += n
            step = step % 997 + 37
        }
        assertEquals(listOf("wake", "command"), events)
        assertEquals(ms(1_000), commands.single().count { it == SPEECH })
    }

    @Test fun aWakeWordWithNoSpeechAfterItSendsNothing() {
        val l = listener()
        l.accept(wakeWord())
        l.accept(silence(3_200))
        assertEquals(listOf("wake", "discarded"), events)
        assertTrue(commands.isEmpty())
    }

    @Test fun aLongCommandIsCutAtTheLimit() {
        val l = listener(CommandListenerPolicy(maxCommandMs = 2_000))
        l.accept(wakeWord())
        l.accept(speech(5_000))
        assertEquals(listOf("wake", "command"), events)
        assertEquals(ms(2_000), commands.single().size)
    }

    @Test fun theWakeWordIsIgnoredJustAfterACommand() {
        val l = listener(CommandListenerPolicy(cooldownMs = 2_000))
        l.accept(wakeWord())
        l.accept(speech(500))
        l.accept(silence(1_000))
        assertEquals(listOf("wake", "command"), events)
        l.accept(wakeWord())
        assertEquals(listOf("wake", "command"), events)
        l.accept(silence(2_000))
        l.accept(wakeWord())
        l.accept(silence(200))
        assertEquals(listOf("wake", "command", "wake"), events)
    }

    @Test fun theWakeDetectorStartsFreshAfterEachCommand() {
        val l = listener()
        val before = wake.resets
        l.accept(wakeWord())
        l.accept(speech(500))
        l.accept(silence(1_000))
        assertTrue(wake.resets > before)
    }

    @Test fun losingTheAudioMidCommandSendsNothing() {
        val l = listener()
        l.accept(wakeWord())
        l.accept(speech(700))
        l.reset()
        assertEquals(listOf("wake", "discarded"), events)
        l.accept(silence(2_000))
        assertTrue(commands.isEmpty())
    }

    @Test fun eachCommandCarriesTheWordThatStartedIt() {
        wake = FakeWake(words = 3)
        val l = listener()
        l.accept(wakeWord(2))
        l.accept(speech(500))
        l.accept(silence(3_000))
        l.accept(wakeWord(1))
        l.accept(speech(500))
        l.accept(silence(1_000))
        assertEquals(listOf("wake", "command", "wake", "command"), events)
        assertEquals(listOf(2, 1), words)
    }

    @Test fun aWordFiresOnlyAtItsOwnThreshold() {
        wake = FakeWake(words = 2)
        val l = listener(thresholds = floatArrayOf(0.5f, 0.92f))
        l.accept(wakeWord(1))
        l.accept(silence(200))
        assertTrue(events.isEmpty())
        l.accept(wakeWord(0))
        l.accept(speech(300))
        l.accept(silence(1_000))
        assertEquals(listOf(0), words)
    }

    @Test fun whenTwoWordsFireTheHigherScoreWins() {
        wake = FakeWake(words = 2, loud = setOf(1))
        val l = listener()
        // Half the frame is each word: both reach their threshold, word 1 scores higher.
        l.accept(ShortArray(1_280) { if (it < 640) WAKE else (WAKE + 1).toShort() })
        l.accept(speech(300))
        l.accept(silence(1_000))
        assertEquals(listOf(1), words)
    }

    @Test fun speechWithoutTheWakeWordIsNeverACommand() {
        val l = listener()
        l.accept(speech(10_000))
        l.accept(silence(2_000))
        assertTrue(events.isEmpty())
    }

    private companion object {
        const val WAKE: Short = 1_234
        const val SPEECH: Short = 8_000
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import dev.omnesis.android.feature.recording.OpusDecoder
import dev.omnesis.android.feature.recording.SpeechDetector
import dev.omnesis.android.feature.recording.WearableAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit
import kotlin.math.abs

class VoiceCommandsTest {
    /** Runs every task at once on the calling thread. */
    private class Inline : AbstractExecutorService() {
        private var down = false
        override fun execute(command: Runnable) {
            if (down) throw java.util.concurrent.RejectedExecutionException()
            command.run()
        }
        override fun shutdown() { down = true }
        override fun shutdownNow(): MutableList<Runnable> = mutableListOf<Runnable>().also { down = true }
        override fun isShutdown() = down
        override fun isTerminated() = down
        override fun awaitTermination(timeout: Long, unit: TimeUnit) = true
    }

    private class Pendant : WearableAudio {
        override val name = "Pendant"
        override val ready: StateFlow<Boolean> = MutableStateFlow(true)
        var sink: WearableAudio.FrameSink? = null
        var stops = 0
        override fun startStreaming(sink: WearableAudio.FrameSink): Boolean {
            this.sink = sink
            return true
        }
        override fun stopStreaming() {
            stops++
            sink = null
        }

        /** 20 ms frames whose one byte says what they hold. */
        fun say(kind: Byte, ms: Int) = repeat(ms / 20) { sink!!.onFrame(byteArrayOf(kind), 0) }
    }

    /** A "frame" decodes to 20 ms of samples all equal to its byte times 100. */
    private class Decoder : OpusDecoder {
        var closed = false
        override fun decode(frame: ByteArray) = ShortArray(320) { (frame[0] * 100).toShort() }
        override fun close() { closed = true }
    }

    /** Word i is heard in frames of byte [WAKE] + i. */
    private class Wake(override val words: Int) : WakeWordDetector {
        override val frameSamples = 1_280
        override fun reset() = Unit
        override fun score(frame: ShortArray) = FloatArray(words) { w ->
            if (frame.count { it == ((WAKE + w) * 100).toShort() } >= 640) 0.9f else 0f
        }
    }

    private class Speech : SpeechDetector {
        override fun reset() = Unit
        override fun probability(frame: FloatArray) = if (frame.map { abs(it) }.average() > 0.1) 0.9f else 0f
    }

    private val feedback = mutableListOf<CommandFeedback>()
    private val sent = mutableListOf<ShortArray>()
    private val sentTo = mutableListOf<String>()
    private var answer: AssistOutcome = AssistOutcome.Done("ok")
    private val decoder = Decoder()
    private var detectorsMade = 0

    private fun commands() = VoiceCommands(
        decoders = { decoder },
        wakeDetectors = { words -> detectorsMade++; Wake(words.size) },
        speechDetectors = { Speech() },
        send = { route, pcm -> sentTo += route.id; sent += pcm; answer },
        scope = CoroutineScope(Dispatchers.Unconfined),
        workers = { Inline() },
    )

    private fun route(id: String, word: WakeWord, destination: Destination = Destination.HomeAssistant) =
        ActiveRoute(CommandRoute(id, word.id, destination), word)

    private val home = listOf(route("home", WakeWordModelCatalog.OK_HOME))

    @Test fun aSpokenCommandReachesItsRouteAndTheOutcomeIsFelt() {
        val pendant = Pendant()
        val c = commands()
        assertTrue(c.start(pendant, home) { feedback += it })
        pendant.say(0, 400)
        pendant.say(WAKE, 80)
        pendant.say(SPEECH, 1_000)
        pendant.say(0, 1_200)
        assertEquals(listOf(CommandFeedback.LISTENING, CommandFeedback.DONE), feedback)
        assertEquals(1, sent.size)
        assertEquals(listOf("home"), sentTo)
    }

    @Test fun eachWakeWordSendsToItsOwnRoute() {
        val pendant = Pendant()
        val c = commands()
        c.start(
            pendant,
            listOf(
                route("home", WakeWordModelCatalog.OK_HOME),
                route("hook", WakeWordModelCatalog.HEY_MYCROFT, Destination.Webhook("https://hooks.example.com/a")),
            ),
        ) { feedback += it }
        assertEquals(listOf("“ok home”", "“hey mycroft”"), c.phrases.map { "“$it”" })
        pendant.say((WAKE + 1).toByte(), 80)
        pendant.say(SPEECH, 600)
        pendant.say(0, 3_200)
        pendant.say(WAKE, 80)
        pendant.say(SPEECH, 600)
        pendant.say(0, 1_200)
        assertEquals(listOf("hook", "home"), sentTo)
    }

    @Test fun startingAgainWithOtherRoutesStartsOver() {
        val pendant = Pendant()
        val c = commands()
        c.start(pendant, home) { feedback += it }
        assertTrue(c.start(pendant, home) { feedback += it })
        assertEquals(1, detectorsMade)
        c.start(pendant, home + route("phone", WakeWordModelCatalog.ALEXA, Destination.PhoneAction)) { feedback += it }
        assertEquals(2, detectorsMade)
        assertEquals(1, pendant.stops)
        assertTrue(c.listening)
    }

    @Test fun aCommandHomeAssistantDidNotUnderstandIsFeltAsAFailure() {
        answer = AssistOutcome.NotUnderstood("no_intent_match")
        val pendant = Pendant()
        val c = commands()
        c.start(pendant, home) { feedback += it }
        pendant.say(WAKE, 80)
        pendant.say(SPEECH, 600)
        pendant.say(0, 1_200)
        assertEquals(listOf(CommandFeedback.LISTENING, CommandFeedback.FAILED), feedback)
    }

    @Test fun aWakeWordWithNothingSaidSendsNothing() {
        val pendant = Pendant()
        val c = commands()
        c.start(pendant, home) { feedback += it }
        pendant.say(WAKE, 80)
        pendant.say(0, 4_000)
        assertEquals(listOf(CommandFeedback.LISTENING), feedback)
        assertTrue(sent.isEmpty())
    }

    @Test fun stoppingClosesTheStreamAndTheDecoder() {
        val pendant = Pendant()
        val c = commands()
        c.start(pendant, home) { feedback += it }
        c.stop()
        assertEquals(1, pendant.stops)
        assertNull(pendant.sink)
        assertTrue(decoder.closed)
        assertFalse(c.listening)
    }

    @Test fun aLostLinkEndsListeningSoItCanStartAgain() {
        val pendant = Pendant()
        val c = commands()
        c.start(pendant, home) { feedback += it }
        pendant.say(WAKE, 80)
        pendant.sink!!.onLinkLost()
        assertFalse(c.listening)
        assertTrue(c.start(pendant, home) { feedback += it })
        assertTrue(sent.isEmpty())
    }

    private companion object {
        const val WAKE: Byte = 12
        const val SPEECH: Byte = 80
    }
}

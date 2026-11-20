// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.util.Log
import dev.omnesis.android.feature.recording.OpusDecoder
import dev.omnesis.android.feature.recording.SpeechDetector
import dev.omnesis.android.feature.recording.WearableAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException

/** What the wearer feels. */
enum class CommandFeedback {
    /** The wake word was heard; say the command. */
    LISTENING,

    /** Its destination carried it out. */
    DONE,

    /** It was not understood, or its destination could not be reached. */
    FAILED,
}

/**
 * Listens to a wearable for the routes' wake words and hands each command
 * that follows one to [send] with its route. [start] opens the wearable's
 * audio through its own view, so a recording running at the same time is
 * untouched; the audio is decoded and scored on [worker] and never leaves the
 * phone except as the command sent to its destination. A wake word with
 * nothing said after it sends nothing and gives no feedback beyond the first
 * pulse.
 */
class VoiceCommands(
    private val decoders: () -> OpusDecoder,
    private val wakeDetectors: (List<WakeWord>) -> WakeWordDetector,
    private val speechDetectors: () -> SpeechDetector,
    private val send: suspend (CommandRoute, ShortArray) -> AssistOutcome,
    private val scope: CoroutineScope,
    private val workers: () -> ExecutorService,
) {
    private var audio: WearableAudio? = null
    private var routes: List<ActiveRoute> = emptyList()
    private var worker: ExecutorService? = null
    @Volatile private var run = 0

    // Worker-thread state.
    private var decoder: OpusDecoder? = null
    private var listener: CommandListener? = null
    private var closeables: List<AutoCloseable> = emptyList()

    val listening: Boolean get() = audio != null

    /** The wake words heard now, as said. */
    val phrases: List<String> get() = routes.map { it.word.phrase }

    /**
     * Start listening to [input] for [active]'s wake words; false when it is
     * not streaming now. Safe to call again: the same input and routes keep
     * listening as they are, anything else starts over.
     */
    @Synchronized
    fun start(input: WearableAudio, active: List<ActiveRoute>, feedback: (CommandFeedback) -> Unit): Boolean {
        require(active.isNotEmpty()) { "Nothing to listen for" }
        if (audio === input && routes == active) return true
        stop()
        val thisRun = ++run
        val w = workers().also { worker = it }
        w.execute {
            try {
                val wake = wakeDetectors(active.map { it.word })
                val speech = speechDetectors()
                decoder = decoders()
                closeables = listOfNotNull(wake as? AutoCloseable, speech as? AutoCloseable)
                listener = CommandListener(
                    wake = wake,
                    speech = speech,
                    thresholds = FloatArray(active.size) { active[it].route.threshold },
                    onWake = { feedback(CommandFeedback.LISTENING) },
                    onCommand = { word, pcm ->
                        val route = active[word].route
                        scope.launch {
                            val outcome = send(route, pcm)
                            Log.i(TAG, "Voice command for ${active[word].word.phrase}: ${outcome::class.simpleName} (${pcm.size / 16} ms of audio)")
                            feedback(if (outcome is AssistOutcome.Done) CommandFeedback.DONE else CommandFeedback.FAILED)
                        }
                    },
                    onDiscarded = { Log.d(TAG, "Wake word with no command after it") },
                )
            } catch (e: Exception) {
                Log.w(TAG, "Voice commands could not start: ${e.message}")
            }
        }
        val sink = object : WearableAudio.FrameSink {
            override fun onFrame(frame: ByteArray, receivedAtMs: Long) {
                if (run == thisRun) post(w) { if (run == thisRun) hear(frame) }
            }

            override fun onLinkLost() {
                post(w) { listener?.reset() }
                synchronized(this@VoiceCommands) {
                    if (run == thisRun) {
                        audio = null
                        routes = emptyList()
                    }
                }
            }
        }
        if (!input.startStreaming(sink)) {
            shutdown(w)
            worker = null
            return false
        }
        audio = input
        routes = active
        Log.i(TAG, "Listening for ${phrases.joinToString { "“$it”" }} on ${input.name}")
        return true
    }

    @Synchronized
    fun stop() {
        run++
        audio?.stopStreaming()
        audio = null
        routes = emptyList()
        worker?.let(::shutdown)
        worker = null
    }

    private fun hear(frame: ByteArray) {
        val pcm = try {
            decoder?.decode(frame) ?: return
        } catch (e: Exception) {
            Log.w(TAG, "Dropped an undecodable frame: ${e.message}")
            return
        }
        try {
            listener?.accept(pcm)
        } catch (e: Exception) {
            Log.w(TAG, "Wake-word listener failed: ${e.message}")
            listener?.reset()
        }
    }

    private fun shutdown(w: ExecutorService) {
        post(w) {
            listener?.reset()
            listener = null
            decoder?.let { runCatching { it.close() } }
            decoder = null
            closeables.forEach { runCatching { it.close() } }
            closeables = emptyList()
        }
        w.shutdown()
    }

    private fun post(w: ExecutorService, block: () -> Unit) {
        try {
            w.execute {
                try {
                    block()
                } catch (e: Exception) {
                    Log.w(TAG, "Voice command worker: ${e.message}")
                }
            }
        } catch (_: RejectedExecutionException) {
        }
    }

    private companion object {
        const val TAG = "Omnesis:Assist"
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import dev.omnesis.android.feature.recording.ChunkPolicy
import dev.omnesis.android.feature.recording.SpeechDetector

/**
 * Scores mono 16-bit PCM at 16 kHz for [words] wake words, [frameSamples]
 * samples at a time. Stateful across calls; [reset] forgets what it heard.
 */
interface WakeWordDetector {
    val frameSamples: Int

    /** How many wake words each [score] covers. */
    val words: Int

    fun reset()

    /** For each wake word, the score, 0..1, that it just ended. */
    fun score(frame: ShortArray): FloatArray
}

/** How the listener decides; durations are audio time. */
data class CommandListenerPolicy(
    /** No speech this long after the wake word: a false trigger, nothing is sent. */
    val noSpeechTimeoutMs: Long = 3_000,
    /** Quiet this long after speech ends the command. */
    val endSilenceMs: Long = 900,
    /** The longest command kept. */
    val maxCommandMs: Long = 8_000,
    /** After a command, the wake word is not listened for this long. */
    val cooldownMs: Long = 2_000,
)

/**
 * Listens to a stream of decoded wearable audio for its wake words and keeps
 * the command spoken after one, with which word it was. Fed in order from one thread, any number of
 * samples at a time; time is counted in samples, so it follows the audio and
 * not the clock.
 *
 * Listening, the [wake] detector scores every frame for every word. Once a
 * word's score reaches its own entry in [thresholds] (the highest, when
 * several do), [onWake] is called with the word's index and the audio from that frame on is kept while the [speech]
 * detector scores it: the command ends after [CommandListenerPolicy.endSilenceMs]
 * of quiet following speech, or at [CommandListenerPolicy.maxCommandMs], and
 * goes to [onCommand]. A wake word with no speech after it within
 * [CommandListenerPolicy.noSpeechTimeoutMs] ends in [onDiscarded] and sends
 * nothing. Every wake word is ignored for [CommandListenerPolicy.cooldownMs]
 * after a command so its own tail cannot fire again.
 */
class CommandListener(
    private val wake: WakeWordDetector,
    private val speech: SpeechDetector,
    /** One per word the detector scores. */
    private val thresholds: FloatArray,
    private val onWake: (word: Int) -> Unit,
    private val onCommand: (word: Int, pcm: ShortArray) -> Unit,
    private val onDiscarded: () -> Unit,
    private val policy: CommandListenerPolicy = CommandListenerPolicy(),
) {
    init {
        require(thresholds.size == wake.words) { "${wake.words} words, ${thresholds.size} thresholds" }
    }

    private enum class State { LISTENING, CAPTURING }

    private var state = State.LISTENING
    private var now = 0L

    /** The word that started the command being captured. */
    private var word = -1

    /** The sample before which the wake word is ignored. */
    private var quietUntil = 0L

    private val wakeFrame = ShortArray(wake.frameSamples)
    private var wakeFilled = 0

    private val speechFrame = FloatArray(ChunkPolicy.FRAME_SAMPLES)
    private var speechFilled = 0

    private var command = ShortArray(0)
    private var commandLength = 0
    private var heardSpeech = false
    private var quietSamples = 0L

    /** Feed the next [length] samples of [pcm]. */
    fun accept(pcm: ShortArray, length: Int = pcm.size) {
        var i = 0
        while (i < length) {
            when (state) {
                State.LISTENING -> {
                    wakeFrame[wakeFilled++] = pcm[i++]
                    now++
                    if (wakeFilled == wakeFrame.size) {
                        wakeFilled = 0
                        val fired = fired(wake.score(wakeFrame))
                        if (now >= quietUntil && fired >= 0) {
                            startCommand(fired)
                            // The frame that fired may already hold the first word of a command said in one breath.
                            for (sample in wakeFrame) keep(sample)
                        }
                    }
                }
                State.CAPTURING -> {
                    val sample = pcm[i++]
                    now++
                    keep(sample)
                    speechFrame[speechFilled++] = sample / 32768f
                    if (speechFilled == speechFrame.size) {
                        speechFilled = 0
                        scoreSpeech()
                    }
                    if (state == State.CAPTURING && commandLength >= samplesOf(policy.maxCommandMs)) finishCommand()
                }
            }
        }
    }

    /** The audio stopped (link lost, listening switched off): forget any command in progress, unsent. */
    fun reset() {
        if (state == State.CAPTURING) onDiscarded()
        state = State.LISTENING
        wake.reset()
        wakeFilled = 0
        command = ShortArray(0)
        commandLength = 0
    }

    /** The word with the highest score among those at their threshold; -1 when none is. */
    private fun fired(scores: FloatArray): Int {
        var best = -1
        for (i in scores.indices) {
            if (scores[i] >= thresholds[i] && (best < 0 || scores[i] > scores[best])) best = i
        }
        return best
    }

    private fun startCommand(fired: Int) {
        state = State.CAPTURING
        word = fired
        speech.reset()
        speechFilled = 0
        command = ShortArray(samplesOf(policy.maxCommandMs).toInt())
        commandLength = 0
        heardSpeech = false
        quietSamples = 0
        onWake(fired)
    }

    private fun keep(sample: Short) {
        if (commandLength < command.size) command[commandLength++] = sample
    }

    private fun scoreSpeech() {
        val p = speech.probability(speechFrame)
        if (p >= ChunkPolicy.SPEECH_THRESHOLD) {
            heardSpeech = true
            quietSamples = 0
        } else if (p < ChunkPolicy.SPEECH_END_THRESHOLD || !heardSpeech) {
            quietSamples += speechFrame.size
        }
        when {
            heardSpeech && quietSamples >= samplesOf(policy.endSilenceMs) -> finishCommand()
            !heardSpeech && quietSamples >= samplesOf(policy.noSpeechTimeoutMs) -> {
                endCommand()
                onDiscarded()
            }
        }
    }

    private fun finishCommand() {
        val kept = command.copyOf(commandLength)
        val spoke = heardSpeech
        val by = word
        endCommand()
        if (spoke) onCommand(by, kept) else onDiscarded()
    }

    private fun endCommand() {
        state = State.LISTENING
        quietUntil = now + samplesOf(policy.cooldownMs)
        wake.reset()
        wakeFilled = 0
        command = ShortArray(0)
        commandLength = 0
    }

    private fun samplesOf(ms: Long): Long = ms * ChunkPolicy.SAMPLE_RATE_HZ / 1000
}

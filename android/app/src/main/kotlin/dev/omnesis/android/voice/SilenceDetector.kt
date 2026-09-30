// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

/**
 * Decides from microphone peak amplitudes when a hands-free speaker has finished:
 * speech first has to be heard (enough loud samples that a single click does not
 * count), then [trailingSilenceMs] of quiet ends it. A recording that never hears
 * speech gives up after [noSpeechTimeoutMs]. Pure, so the thresholds are testable
 * without a microphone.
 */
class SilenceDetector(
    private val speechThreshold: Int = SPEECH_THRESHOLD,
    private val minLoudSamples: Int = 3,
    private val trailingSilenceMs: Long = 1_800,
    private val noSpeechTimeoutMs: Long = 8_000,
) {
    enum class Verdict { LISTENING, SPEECH_ENDED, NO_SPEECH }

    private var loudSamples = 0
    private var lastLoudAtMs = 0L

    /** [amplitude] is the peak (0–32767) since the previous sample; [elapsedMs] counts from the recording's start. */
    fun onSample(amplitude: Int, elapsedMs: Long): Verdict {
        if (amplitude >= speechThreshold) {
            loudSamples++
            lastLoudAtMs = elapsedMs
        }
        val speechHeard = loudSamples >= minLoudSamples
        return when {
            speechHeard && elapsedMs - lastLoudAtMs >= trailingSilenceMs -> Verdict.SPEECH_ENDED
            !speechHeard && elapsedMs >= noSpeechTimeoutMs -> Verdict.NO_SPEECH
            else -> Verdict.LISTENING
        }
    }

    companion object {
        /** Above room tone, below conversational speech at arm's length. */
        const val SPEECH_THRESHOLD = 1_800
    }
}

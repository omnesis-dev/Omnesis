// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * How the watch encodes a recording: mono AAC in an MPEG-4 container at a
 * speech bit rate, small enough to cross the Data Layer quickly. The iOS
 * counterpart is `WatchVoiceFormat` in `WatchVoice.swift`.
 */
object RecordingFormat {
    const val SAMPLE_RATE_HZ = 16_000
    const val BIT_RATE = 24_000
    const val CHANNELS = 1
    const val CONTENT_TYPE = "audio/mp4"
    const val FILE_EXTENSION = "m4a"

    /** The longest recording the watch makes. */
    val MAX_DURATION: Duration = 120.seconds

    /** The share of the gateway's byte limit a recording may fill, leaving room for the container. */
    private const val BYTE_BUDGET = 0.9

    /**
     * How long a recording may run to stay inside [maxAudioBytes] at the
     * nominal bit rate, capped at [MAX_DURATION]; null when the limit leaves
     * less than a second.
     */
    fun recordingLimit(maxAudioBytes: Long): Duration? {
        if (maxAudioBytes <= 0) return null
        val byBytes = (maxAudioBytes * BYTE_BUDGET / (BIT_RATE / 8.0)).seconds
        return minOf(MAX_DURATION, byBytes).takeIf { it >= 1.seconds }
    }
}

/** Which send buttons the unified recorder offers. */
enum class CaptureButtons {
    /** One "Send": the phone decides whether it is a question or a note. */
    SEND,

    /** "Ask" and "Tell": the person decides. */
    ASK_AND_TELL,

    /** "Ask" alone: the recording follows up an answer, so it is a question. */
    ASK_ONLY,

    /** The phone cannot process recordings; the recorder reports that instead of recording. */
    UNSUPPORTED,
}

/** Whether the phone refreshed this gate recently enough to act on. */
fun DictationGate.isFresh(now: EpochMillis): Boolean = (now - updatedAt).milliseconds < DictationGate.STALE_AFTER

/**
 * How long the note screen may record for the gateway, or null when it should
 * dictate text instead: the gate is off, stale, or leaves no room.
 */
fun DictationGate.recordingLimit(now: EpochMillis): Duration? =
    if (active && isFresh(now)) RecordingFormat.recordingLimit(maxAudioBytes) else null

/**
 * How long the unified recorder may record. It records whenever the phone
 * supports capture, so without a usable byte limit it runs to the format's cap.
 */
fun captureRecordingLimit(gate: DictationGate?, now: EpochMillis): Duration =
    gate?.recordingLimit(now) ?: RecordingFormat.MAX_DURATION

/**
 * The buttons the unified recorder shows. [gate] is the last one the phone
 * published, or null when there is none; [followUp] says the recording
 * follows up an answer on screen.
 */
fun captureButtons(gate: DictationGate?, now: EpochMillis, followUp: Boolean): CaptureButtons = when {
    gate?.captureSupported != true -> CaptureButtons.UNSUPPORTED
    followUp -> CaptureButtons.ASK_ONLY
    gate.decisionGate && gate.isFresh(now) -> CaptureButtons.SEND
    else -> CaptureButtons.ASK_AND_TELL
}

/**
 * When the phone tells the watch about the gate, and what it tells it. The
 * phone only speaks from knowledge: an unknown gateway status publishes
 * nothing, and a known one is published when it changes, or once a day so the
 * watch can tell a phone that stopped refreshing from one whose answer held.
 * The iOS counterpart is `WatchGatePublishing` in `WatchDictationGateStore.swift`.
 */
object GatePublishing {
    /** How often an unchanged gate is published again, to keep it fresh on the watch. */
    val REFRESH_INTERVAL: Duration = 24.hours

    /**
     * The gate the phone's knowledge implies, or null while the gateway's
     * status is unknown. Unpaired, the answer is known without any status.
     *
     * @param gatewayMaxAudioBytes the gateway's recording limit when it
     *   transcribes voice notes, null when it does not.
     */
    fun gate(
        paired: Boolean,
        statusKnown: Boolean,
        gatewayMaxAudioBytes: Long?,
        now: EpochMillis,
        decisionGate: Boolean = false,
        captureSupported: Boolean = false,
    ): DictationGate? {
        if (!paired) return DictationGate(active = false, maxAudioBytes = 0, updatedAt = now)
        if (!statusKnown) return null
        return DictationGate(
            active = gatewayMaxAudioBytes != null,
            maxAudioBytes = gatewayMaxAudioBytes ?: 0,
            updatedAt = now,
            decisionGate = decisionGate,
            captureSupported = captureSupported,
        )
    }

    /** Whether [gate] should replace [last], the gate last published. */
    fun shouldPublish(gate: DictationGate, last: DictationGate?, now: EpochMillis): Boolean =
        last == null ||
            gate.copy(updatedAt = last.updatedAt) != last ||
            (now - last.updatedAt).milliseconds >= REFRESH_INTERVAL
}

/**
 * When the watch app leaves the screen by itself after a note is sent, so
 * tap, speak, send reads as one gesture. It leaves only while the
 * confirmation is still showing, something durable carries the note, and
 * nothing else is under way.
 */
object CaptureDismissal {
    /** How long the confirmation stays on screen before the app leaves. */
    val CONFIRMATION_DELAY: Duration = 1.8.seconds

    fun shouldLeave(showingSent: Boolean, carried: Boolean, otherWorkInFlight: Boolean): Boolean =
        showingSent && carried && !otherWorkInFlight
}

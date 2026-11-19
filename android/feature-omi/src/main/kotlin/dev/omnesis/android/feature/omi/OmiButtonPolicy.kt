// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi

import dev.omnesis.android.feature.recording.RecordingInput
import dev.omnesis.android.feature.recording.RecordingState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * What the pendant's button does. A tap with nothing recording starts a
 * recording from the pendant, confirmed by one short pulse once it is really
 * running, or one long pulse if it did not start in [startTimeoutMs]. A tap
 * while a recording runs, from either input, stops it with two short pulses.
 * Every other event is ignored; a long press switches the pendant off in its
 * own firmware.
 */
class OmiButtonPolicy(
    private val recording: StateFlow<RecordingState>,
    /** False when the system refused to start the recording service. */
    private val startRecording: () -> Boolean,
    private val stopRecording: () -> Unit,
    private val vibrate: (Haptic) -> Unit,
    private val scope: CoroutineScope,
    private val startTimeoutMs: Long = 10_000,
) {
    private var starting: Job? = null

    fun onButton(event: OmiButton) {
        if (event != OmiButton.TAP) return
        if (starting?.isActive == true) return
        if (recording.value is RecordingState.Active) {
            stopRecording()
            vibrate(Haptic.STOPPED)
            return
        }
        if (!startRecording()) {
            vibrate(Haptic.FAILED)
            return
        }
        starting = scope.launch {
            val started = withTimeoutOrNull(startTimeoutMs) {
                recording.first { it is RecordingState.Active && it.input == RecordingInput.WEARABLE }
            }
            vibrate(if (started != null) Haptic.STARTED else Haptic.FAILED)
        }
    }
}

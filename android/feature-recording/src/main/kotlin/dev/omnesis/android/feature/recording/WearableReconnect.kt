// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Waits for a wearable whose link dropped mid-recording. When the link is back
 * and the recording is still paused by the loss, not by the user, it resumes;
 * when the link stays away for [goneAfterMs], the recording is given up and
 * filed. A ready flag that has not yet cleared belongs to the old link, so the
 * wait first sees it go false, then true.
 */
class WearableReconnect(
    private val ready: StateFlow<Boolean>,
    private val scope: CoroutineScope,
    private val goneAfterMs: Long,
    /** The recording is still paused by the lost link. */
    private val pausedByLoss: () -> Boolean,
    private val resume: () -> Unit,
    private val giveUp: () -> Unit,
) {
    private var waiting: Job? = null

    val isWaiting: Boolean get() = waiting?.isActive == true

    /** Start waiting, unless already waiting. */
    fun await() {
        if (isWaiting) return
        waiting = scope.launch {
            val back = withTimeoutOrNull(goneAfterMs) {
                ready.first { !it }
                ready.first { it }
            }
            // Done waiting before acting, so a resume that fails can wait again.
            waiting = null
            when {
                back == null -> giveUp()
                pausedByLoss() -> resume()
            }
        }
    }

    fun cancel() {
        waiting?.cancel()
        waiting = null
    }
}

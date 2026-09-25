// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.delivery

import android.util.Log
import dev.omnesis.android.transport.DeliveryReporter
import dev.omnesis.android.transport.PushHealth
import dev.omnesis.android.transport.PushHealthSnapshot
import dev.omnesis.android.transport.RetryOutcome
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val TAG = "Omnesis:delivery"

/** Everything the delivery-health banner renders, and where a retry is in its cycle. */
data class PushHealthUiState(
    val snapshot: PushHealthSnapshot = PushHealthSnapshot(),
    val retryPhase: PushHealth.RetryPhase = PushHealth.RetryPhase.Idle,
)

/**
 * Holds "is this phone's data getting through?" for every surface that asks.
 *
 * One instance for the whole app rather than one per screen, because a retry
 * started on one screen is the same operation as a retry started on another:
 * two holders would disagree about whether one is running, and a holder living
 * in a composable would lose the phase — and with it the report the retry
 * exists to deliver — the moment its row scrolled out of a lazy container.
 *
 * [reporters] is read on each pass rather than captured, so a pairing rebuilt
 * underneath this holder is picked up without it having to observe the session.
 */
class PushHealthCoordinator(
    private val reporters: () -> List<DeliveryReporter>,
    private val scope: CoroutineScope,
    private val clock: () -> Instant = Instant::now,
) {
    private val _state = MutableStateFlow(PushHealthUiState())
    val state: StateFlow<PushHealthUiState> = _state.asStateFlow()

    /** Re-read every source's evidence, off the caller's thread. */
    fun refresh() {
        scope.launch { refreshNow() }
    }

    /**
     * Re-read every source's evidence.
     *
     * Any pass other than a running retry retires that retry's report: it
     * described counts that have since moved, and a stale "couldn't reach
     * Omnesis" sitting under freshly-changed numbers is worse than no line.
     */
    suspend fun refreshNow() {
        val evidence = reporters().mapNotNull { reporter ->
            runCatching { reporter.deliveryEvidence() }
                .onFailure { Log.w(TAG, "Could not read delivery evidence: $it") }
                .getOrNull()
        }
        val snapshot = PushHealth.summarize(evidence, clock())
        _state.update { current ->
            val phase = if (current.retryPhase is PushHealth.RetryPhase.Reported) {
                PushHealth.RetryPhase.Idle
            } else {
                current.retryPhase
            }
            current.copy(snapshot = snapshot, retryPhase = phase)
        }
    }

    /**
     * Run one pass across every source because the user asked, and report what
     * it achieved.
     *
     * A tap landing while a retry runs is dropped rather than queued: a queued
     * second pass would find every source busy, come back with nothing, and
     * overwrite the answer the first one is about to produce. The phase is
     * claimed before this returns, so two taps in one frame cannot both pass
     * the check.
     */
    fun retry() {
        if (!claimRetry()) return
        scope.launch {
            val outcomes = reporters().map { reporter ->
                runCatching { reporter.retryDelivery() }
                    .onFailure { Log.w(TAG, "Retry failed for a source: $it") }
                    .getOrDefault(RetryOutcome.FAILED)
            }
            val outcome = PushHealth.combine(outcomes)
            refreshNow()
            _state.update { it.copy(retryPhase = PushHealth.RetryPhase.Reported(outcome)) }
            Log.i(TAG, "Retry finished across ${outcomes.size} source(s): $outcome")
        }
    }

    /**
     * Drop what every source has given up on. Irreversible, so the caller is
     * expected to have confirmed it.
     */
    fun discardUndelivered() {
        scope.launch {
            reporters().forEach { reporter ->
                runCatching { reporter.discardUndelivered() }
                    .onFailure { Log.w(TAG, "Could not discard undelivered data: $it") }
            }
            refreshNow()
        }
    }

    private fun claimRetry(): Boolean {
        while (true) {
            val current = _state.value
            if (current.retryPhase is PushHealth.RetryPhase.Running) return false
            val claimed = current.copy(retryPhase = PushHealth.RetryPhase.Running)
            if (_state.compareAndSet(current, claimed)) return true
        }
    }
}

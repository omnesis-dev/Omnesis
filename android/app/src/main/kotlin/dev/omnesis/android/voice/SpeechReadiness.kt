// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.session.SessionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * What a dictation started right after a cold start would otherwise go without: the
 * gateway's status, which says whether it transcribes voice notes and offers a speech
 * vocabulary, and the vocabulary itself.
 */
fun interface SpeechReadiness {
    /**
     * Suspends until both are known for the current pairing, or known to be unavailable.
     * Returns at once in a warm app and while unpaired. An unreachable gateway keeps this
     * waiting for as long as its status read takes to fail, so the caller bounds the wait.
     */
    suspend fun await()
}

/** The app's [SpeechReadiness]: the session's first status read, then the vocabulary fetches it started. */
class GatewaySpeechReadiness(
    private val session: SessionManager,
    private val vocabulary: SpeechVocabulary,
) : SpeechReadiness {
    override suspend fun await() {
        session.awaitStatusProbe()
        vocabulary.cache.awaitFetches()
    }
}

/**
 * The bounded wait a dictation makes before it opens the microphone. The tile, a
 * shortcut and the Assistant often start the app cold, before the gateway has said
 * whether it transcribes voice notes or offers a speech vocabulary; a dictation that
 * started at once would be a phone-transcribed note without vocabulary hints. So the
 * first one waits for [SpeechReadiness] and the recognizer's own preparation, for at most
 * [TIMEOUT_MS] from the moment its screen's model was created, and goes ahead without
 * them past that. In a warm app both are known and the wait is over before it is asked
 * about.
 */
class SpeechWarmUp(scope: CoroutineScope, readiness: SpeechReadiness, prepare: suspend () -> Unit) {
    // Only the wait is bounded. The preparation runs on, so a dictation started later on
    // the same screen still gets what a slow gateway eventually said.
    private val preparation: Job = scope.launch {
        readiness.await()
        prepare()
    }
    private val wait: Job = scope.launch { withTimeoutOrNull(TIMEOUT_MS) { preparation.join() } }

    /** Whether the wait is still under way, so the microphone should not open yet. */
    val isActive: Boolean get() = wait.isActive

    /** Suspends until the wait is over, however it ended. */
    suspend fun join() = wait.join()

    companion object {
        /** Long enough for a status read and a vocabulary fetch on a home network, short enough to wait through. */
        const val TIMEOUT_MS = 1_000L
    }
}

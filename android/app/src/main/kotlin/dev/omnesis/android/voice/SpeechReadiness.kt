// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.session.SessionManager

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

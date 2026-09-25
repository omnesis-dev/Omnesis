// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import kotlinx.coroutines.flow.StateFlow

/** The pending request to use the push relay, and the two answers to it. */
interface RelayConsentActions {
    /** The request waiting for an answer, or null; it clears once answered or no longer needed. */
    val relayConsentPrompt: StateFlow<SessionManager.RelayConsentPrompt?>

    /**
     * Allows the relay. The call runs on beyond the screen that asked: the
     * request clears once enrollment starts, or carries an error.
     */
    fun allowRelayConsent()

    /** Declines for now; the request is asked again on a later visit. */
    fun dismissRelayConsent()
}

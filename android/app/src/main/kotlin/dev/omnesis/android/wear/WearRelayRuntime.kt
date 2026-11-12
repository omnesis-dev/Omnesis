// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dagger.Lazy
import dev.omnesis.android.session.SessionManager
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** What the phone knows that a watch's gate depends on, read from the session as it stands. */
internal fun gateKnowledge(sessions: SessionManager): GateKnowledge = GateKnowledge(
    paired = sessions.state.value is SessionManager.AppState.Paired,
    status = sessions.watchRelayStatus.value?.let { status ->
        RelayGatewayStatus(
            dictationMaxAudioBytes = status.dictation?.takeIf { it.active && it.maxAudioBytes > 0 }?.maxAudioBytes,
            decisionGate = status.capture.active,
        )
    },
)

/**
 * Starts the relay's part of every app process: keeping the watch's gate in
 * step with the pairing and the gateway's status, and finishing recordings an
 * earlier process left.
 *
 * On a phone without the Wearable Data Layer nothing here runs. With it, a
 * phone that has no watch does one thing: it writes the gate as a DataItem
 * when the gate changes, which is what lets a watch paired later learn it.
 */
@Singleton
class WearRelayRuntime @Inject constructor(
    // Resolved only once the Data Layer is known to exist, so a phone without one never builds the relay.
    private val relay: Lazy<WearRelay>,
    private val sessions: Lazy<SessionManager>,
    private val gateway: WearGateway,
    @WearRelayScope private val scope: CoroutineScope,
) {
    fun start() {
        scope.launch {
            if (!gateway.available()) return@launch
            val relay = relay.get()
            val sessions = sessions.get()
            relay.ensureGateRefresh()
            if (relay.waitingRecordings() > 0) relay.retryRecordings()
            combine(sessions.state, sessions.watchRelayStatus) { _, _ -> }.collect { relay.refreshGate() }
        }
    }
}

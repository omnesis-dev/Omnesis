// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject

/**
 * Thin screen-scoped wrapper over the app-singleton [AgentCoordinator]. The
 * coordinator owns the long-lived SSE stream + accumulated transcript so that
 * navigating away from the agent screen and back doesn't drop the conversation; the
 * ViewModel just re-exposes its [AgentCoordinator.state] and forwards user intents.
 */
@HiltViewModel
class AgentViewModel @Inject constructor(
    private val coordinator: AgentCoordinator,
    /** Source-meta resolver for rendering document refs in tool cards (encapsulation rule). */
    val catalog: SourceCatalog,
    session: SessionManager,
) : ViewModel() {

    val state = coordinator.state

    /**
     * Whether the gateway runs in experimental mode, forwarded to the
     * composer for any future experimental slash commands. Deep Research is
     * available in either mode.
     */
    val experimentalEnabled: StateFlow<Boolean> = session.experimentalEnabled

    fun send(text: String, deepResearch: Boolean = false) = coordinator.send(text, deepResearch)

    /** The transcript surface is showing [id], or has stopped showing it. */
    fun conversationSurfaceVisible(id: String, visible: Boolean) =
        coordinator.conversationSurfaceVisible(id, visible)

    /** The composer consumed a rejected send's restored text — clear the one-shot. */
    fun ackSendRejected() = coordinator.ackSendRejected()

    fun ackLastTurnError() = coordinator.ackLastTurnError()

    fun cancelTurn() = coordinator.cancelTurn()

    fun retry() = coordinator.retry()
    fun retryLiveSession() = coordinator.retryLiveSession()

    fun newConversation() = coordinator.newConversation()

    fun resumeConversation(id: String) = coordinator.resumeConversation(id)

    fun loadOlderMessages() = coordinator.loadOlderMessages()

    fun deleteConversation(id: String) = coordinator.deleteConversation(id)

    fun togglePin(id: String, pinned: Boolean) = coordinator.togglePin(id, pinned)

    fun ackConversationActionError() = coordinator.ackConversationActionError()

    fun flushEphemeralTail(toolCallId: String) = coordinator.flushEphemeralTail(toolCallId)
}

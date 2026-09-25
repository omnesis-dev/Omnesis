// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.BriefOriginSnapshot
import dev.omnesis.android.transport.dto.ConversationOrigin
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The new-conversation button is hidden exactly when pressing it would land on the state the
 * surface is already in. Everything that makes a surface *not* blank has to keep it visible —
 * including the states that have no turns of their own.
 */
class BlankNewConversationTest {

    @Test
    fun a_surface_with_nothing_on_it_is_already_a_new_conversation() {
        assertTrue(isBlankNewConversation(AgentCoordinator.UiState(hasClient = true)))
    }

    @Test
    fun a_conversation_that_has_been_spoken_in_is_not_blank() {
        val state = AgentCoordinator.UiState(
            hasClient = true,
            sessionId = "s_live",
            chat = AgentChatState(turns = listOf(AgentTurn.User("u1", "Something asked"))),
        )

        assertFalse(isBlankNewConversation(state))
    }

    /** A minted session with nothing said in it yet is still a conversation, not the landing. */
    @Test
    fun a_minted_session_is_not_blank() {
        assertFalse(
            isBlankNewConversation(AgentCoordinator.UiState(hasClient = true, sessionId = "s_live")),
        )
    }

    /**
     * The cases with no turns at all, where the button is the only way out. An anchored thread
     * nobody has replied to shows its card and no turns; a resume in flight shows a skeleton;
     * a failed start shows an error.
     */
    @Test
    fun the_turnless_states_that_are_still_not_a_new_conversation() {
        val blank = AgentCoordinator.UiState(hasClient = true)

        assertFalse(
            isBlankNewConversation(
                blank.copy(
                    conversationOrigin = ConversationOrigin(
                        kind = "brief",
                        brief = BriefOriginSnapshot(title = "An invented brief", description = "Why."),
                        seedMessageCount = 2,
                    ),
                ),
            ),
        )
        assertFalse(isBlankNewConversation(blank.copy(transcriptLoading = true)))
        assertFalse(isBlankNewConversation(blank.copy(fatalError = IllegalStateException("fictional"))))
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.ConversationSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentConversationActionsTest {
    @get:Rule val compose = createComposeRule()

    private val catalog = SourceCatalog()

    private fun setAgentContent(
        state: AgentCoordinator.UiState,
        onTogglePin: (String, Boolean) -> Unit = { _, _ -> },
        onDeleteConversation: (String) -> Unit = {},
        onDismissConversationActionError: () -> Unit = {},
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AgentContent(
                    state = state,
                    catalog = catalog,
                    onOpenMenu = {},
                    onSend = { _, _ -> },
                    onStop = {},
                    onRetry = {},
                    onNewConversation = {},
                    onFlushEphemeral = {},
                    onOpenDocument = {},
                    onTogglePin = onTogglePin,
                    onDeleteConversation = onDeleteConversation,
                    onDismissConversationActionError = onDismissConversationActionError,
                )
            }
        }
    }

    @Test
    fun `fresh chat has no conversation menu`() {
        setAgentContent(AgentCoordinator.UiState(hasClient = true))
        compose.onNodeWithContentDescription("Conversation options").assertDoesNotExist()
    }

    @Test
    fun `existing chat menu pins the active id`() {
        var pinRequest: Pair<String, Boolean>? = null
        setAgentContent(
            state = AgentCoordinator.UiState(
                sessionId = "chat-active",
                hasClient = true,
                conversations = listOf(
                    ConversationSummary(sessionId = "chat-active", title = "Invented planning chat"),
                ),
            ),
            onTogglePin = { id, pinned -> pinRequest = id to pinned },
        )

        compose.onNodeWithContentDescription("Conversation options").assertIsDisplayed().performClick()
        compose.onNodeWithText("Pin this chat").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("chat-active" to true, pinRequest) }
        compose.onNodeWithContentDescription("New conversation").assertIsDisplayed()
    }

    @Test
    fun `pinned chat offers unpin`() {
        var pinRequest: Pair<String, Boolean>? = null
        setAgentContent(
            state = AgentCoordinator.UiState(
                sessionId = "chat-pinned",
                hasClient = true,
                conversations = listOf(
                    ConversationSummary(
                        sessionId = "chat-pinned",
                        title = "Invented pinned chat",
                        pinned = true,
                    ),
                ),
            ),
            onTogglePin = { id, pinned -> pinRequest = id to pinned },
        )

        compose.onNodeWithContentDescription("Conversation options").performClick()
        compose.onNodeWithText("Unpin this chat").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("chat-pinned" to false, pinRequest) }
    }

    @Test
    fun `delete requires confirmation and targets the active chat`() {
        var deletedId: String? = null
        setAgentContent(
            state = AgentCoordinator.UiState(sessionId = "chat-delete", hasClient = true),
            onDeleteConversation = { deletedId = it },
        )

        compose.onNodeWithContentDescription("Conversation options").performClick()
        compose.onNodeWithText("Delete this chat").performClick()
        compose.onNodeWithText("Delete this chat?").assertIsDisplayed()
        compose.runOnIdle { assertNull(deletedId) }

        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertNull(deletedId) }

        compose.onNodeWithContentDescription("Conversation options").performClick()
        compose.onNodeWithText("Delete this chat").performClick()
        compose.onNodeWithText("Delete").performClick()
        compose.runOnIdle { assertEquals("chat-delete", deletedId) }
    }

    @Test
    fun `conversation action failure is visible and dismissible on the chat`() {
        var dismissed = false
        val message = "Could not pin this chat: the gateway is unavailable."
        setAgentContent(
            state = AgentCoordinator.UiState(
                sessionId = "chat-error",
                hasClient = true,
                conversationActionError = message,
                conversationActionErrorSessionId = "chat-error",
            ),
            onDismissConversationActionError = { dismissed = true },
        )

        compose.onNodeWithText(message).assertIsDisplayed()
        compose.onNodeWithContentDescription("Dismiss error").performClick()
        compose.runOnIdle { assertEquals(true, dismissed) }
    }
}

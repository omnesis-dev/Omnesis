// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** When the conversation's composer asks for the keyboard as the screen comes up. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h720dp-xxhdpi")
class AgentComposerFocusTest {
    @get:Rule
    val compose = createComposeRule()

    private val question = AgentTurn.User("u-pending-example", "When does the marathon entry close?")

    /** A question handed over by the capture screen: asked, and its conversation not yet created. */
    private val askedFromCapture = AgentCoordinator.UiState(
        hasClient = true,
        chat = AgentChatState(turns = listOf(question), busy = true),
    )

    private fun show(state: AgentCoordinator.UiState) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                Box(Modifier.fillMaxSize()) {
                    AgentContent(
                        state = state,
                        catalog = SourceCatalog(),
                        onOpenMenu = {},
                        onSend = { _, _ -> },
                        onStop = {},
                        onRetry = {},
                        onNewConversation = {},
                        onFlushEphemeral = {},
                        onOpenDocument = {},
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun a_blank_chat_takes_the_keyboard() {
        assertTrue(composerTakesFocus(AgentCoordinator.UiState(hasClient = true)))

        show(AgentCoordinator.UiState(hasClient = true))

        compose.onNode(hasSetTextAction()).assertIsFocused()
    }

    @Test
    fun a_question_asked_from_the_capture_screen_leaves_the_keyboard_down() {
        assertFalse(composerTakesFocus(askedFromCapture))

        show(askedFromCapture)

        compose.onNodeWithText(question.text).assertIsDisplayed()
        compose.onAllNodes(isFocused()).assertCountEquals(0)
    }

    @Test
    fun a_conversation_already_under_way_leaves_the_keyboard_down() {
        assertFalse(
            composerTakesFocus(
                AgentCoordinator.UiState(hasClient = true, sessionId = "session-example", chat = askedFromCapture.chat),
            ),
        )
    }

    @Test
    fun editing_a_sent_prompt_takes_the_keyboard() {
        assertTrue(
            composerTakesFocus(
                AgentCoordinator.UiState(
                    hasClient = true,
                    sessionId = "session-example",
                    chat = askedFromCapture.chat,
                    composer = ComposerRecord(editingPrompt = true),
                ),
            ),
        )
    }
}

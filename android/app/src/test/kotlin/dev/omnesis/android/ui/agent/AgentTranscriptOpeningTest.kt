// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.UserPart
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A conversation opens at the top of a finished reply taller than the screen, so the reader
 * starts where the answer begins; a pending reply still opens at the bottom. Fixtures are invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentTranscriptOpeningTest {

    @get:Rule val compose = createComposeRule()

    private var state by mutableStateOf(AgentCoordinator.UiState())

    private fun longAnswer(topic: String) = (1..40).joinToString("\n\n") { n ->
        when (n) {
            1 -> "Opening line about $topic."
            40 -> "Closing line about $topic."
            else -> "Paragraph $n covers one more clause of the invented $topic."
        }
    }

    private val history = listOf(
        ChatMessage.User(listOf(UserPart.Text("Which invoices are still open?"))),
        ChatMessage.Assistant(listOf(AssistantPart.Text("Two are open: the print shop and the venue."))),
        ChatMessage.User(listOf(UserPart.Text("Walk me through the venue contract."))),
        ChatMessage.Assistant(listOf(AssistantPart.Text(longAnswer("the venue contract")))),
    )

    private fun show(messages: List<ChatMessage>) {
        state = AgentCoordinator.UiState(hasClient = true, sessionId = "s_contract", chat = AgentTurnBuilder.stateFrom(messages))
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
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
        compose.waitForIdle()
    }

    /** A reload rebuilds the transcript from storage, renumbering its turn ids. */
    private fun reload(messages: List<ChatMessage>, idPrefix: String) {
        state = state.copy(chat = AgentTurnBuilder.stateFrom(messages, idPrefix = idPrefix))
        compose.waitForIdle()
    }

    private fun text(value: String) = compose.onNode(hasText(value, substring = true), useUnmergedTree = true)

    private fun top(value: String) = text(value).getUnclippedBoundsInRoot().top

    /** The reply starting [opening] is the first item, just below the floating top controls. */
    private fun assertOpensAt(opening: String, closing: String) {
        val top = top(opening)
        val closingTop = top(closing)
        val screen = compose.onRoot().getUnclippedBoundsInRoot().bottom
        assertTrue("reply top at $top, its end at $closingTop, screen $screen", top > 100.dp && top < 220.dp && closingTop > screen)
    }

    @Test
    fun a_tall_last_reply_opens_at_its_top() {
        show(history)

        text("Opening line about the venue contract.").assertIsDisplayed()
        assertOpensAt("Opening line about the venue contract.", "Closing line about the venue contract.")
        compose.onNodeWithContentDescription("Scroll to latest").assertIsDisplayed()
    }

    @Test
    fun a_pending_reply_opens_at_the_bottom() {
        show(history + ChatMessage.User(listOf(UserPart.Text("And when is the deposit due?"))))

        text("And when is the deposit due?").assertIsDisplayed()
        val top = top("Opening line about the venue contract.")
        assertTrue("previous reply top at $top", top < 0.dp)
    }

    @Test
    fun scroll_to_latest_reaches_the_end_of_the_reply() {
        show(history)

        compose.onNodeWithContentDescription("Scroll to latest").performClick()
        compose.waitForIdle()

        text("Closing line about the venue contract.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Scroll to latest").assertDoesNotExist()
    }

    @Test
    fun a_reload_keeps_the_place_on_a_reply_already_read_and_opens_a_new_one_at_its_top() {
        show(history)
        compose.onNodeWithContentDescription("Scroll to latest").performClick()
        compose.waitForIdle()

        reload(history, idPrefix = "reload-")
        text("Closing line about the venue contract.").assertIsDisplayed()

        val later = history +
            ChatMessage.User(listOf(UserPart.Text("Now the catering quote."))) +
            ChatMessage.Assistant(listOf(AssistantPart.Text(longAnswer("the catering quote"))))
        reload(later, idPrefix = "later-")
        assertOpensAt("Opening line about the catering quote.", "Closing line about the catering quote.")
    }
}

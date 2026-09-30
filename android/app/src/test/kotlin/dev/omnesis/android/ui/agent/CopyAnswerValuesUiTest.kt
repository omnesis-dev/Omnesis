// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.AssistantPart
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@Suppress("DEPRECATION")
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class CopyAnswerValuesUiTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun reopened_history_value_copies_without_label_and_reports_success() {
        lateinit var clipboard: ClipboardManager
        val history = AgentTurnBuilder.turns(listOf(ChatMessage.Assistant(listOf(AssistantPart.Text("Reference: `0012  3456`."))))).single() as AgentTurn.Assistant
        assertEquals(null, history.stopReason)
        compose.setContent {
            clipboard = LocalClipboardManager.current
            OmnesisTheme(darkTheme = false) {
                AssistantTurn(
                    history,
                    SourceCatalog(), {}, {},
                )
            }
        }
        compose.onNodeWithContentDescription("Copy value: 0012  3456", useUnmergedTree = true).performClick()
        compose.runOnIdle { assertEquals("0012  3456", clipboard.getText()?.text) }
        compose.onNodeWithContentDescription("Copied value: 0012  3456", useUnmergedTree = true).assertExists()
    }

    @Test
    fun completed_block_copies_blank_lines_trailing_spaces_and_final_newline() {
        lateinit var clipboard: ClipboardManager
        compose.setContent {
            clipboard = LocalClipboardManager.current
            OmnesisTheme(darkTheme = false) {
                AssistantTurn(
                    AgentTurn.Assistant("a1", listOf(AgentPart.Text("```\n\n42 Example Street  \nExampleville\n```")), stopReason = "stop"),
                    SourceCatalog(), {}, {},
                )
            }
        }
        compose.onNodeWithContentDescription("Copy value: \n42 Example Street  \nExampleville\n", useUnmergedTree = true).performClick()
        compose.runOnIdle { assertEquals("\n42 Example Street  \nExampleville\n", clipboard.getText()?.text) }
    }

    @Test
    fun streaming_turn_has_no_value_buttons_even_for_finished_markdown() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AssistantTurn(
                    AgentTurn.Assistant("a1", listOf(AgentPart.Text("`0012`\n\n```\n42 Example Street\n```"))),
                    SourceCatalog(), {}, {}, isStreaming = true,
                )
            }
        }
        compose.onAllNodesWithContentDescription("Copy value: 0012", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Copy value: 42 Example Street\n", useUnmergedTree = true).assertCountEquals(0)
    }
    @Test
    fun explicit_language_block_keeps_code_copy_control() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AssistantTurn(
                    AgentTurn.Assistant("a1", listOf(AgentPart.Text("```kotlin\nval reference = 12\n```"))),
                    SourceCatalog(), {}, {},
                )
            }
        }
        compose.onNodeWithContentDescription("Copy code block", useUnmergedTree = true).assertExists()
    }

    @Test
    fun user_values_have_no_copy_controls() {
        compose.setContent { OmnesisTheme(darkTheme = false) { UserBubble("My reference is `0012`.") } }
        compose.onAllNodesWithContentDescription("Copy value: 0012", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun busy_history_excludes_only_trailing_active_assistant() {
        val turns = AgentTurnBuilder.turns(listOf(
            ChatMessage.Assistant(listOf(AssistantPart.Text("Old reference: `0012`."))),
            ChatMessage.User(listOf(dev.omnesis.android.transport.dto.UserPart.Text("Find the new reference."))),
            ChatMessage.Assistant(listOf(AssistantPart.Text("New reference: `0034`."))),
        ))
        val history = turns.first() as AgentTurn.Assistant
        val active = turns.last() as AgentTurn.Assistant
        val busy = AgentChatState(turns = turns, busy = true)
        assertEquals(false, busy.isTurnStreaming(history))
        assertEquals(true, busy.isTurnStreaming(active))
        assertEquals(false, busy.copy(busy = false).isTurnStreaming(active))
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                androidx.compose.foundation.layout.Column {
                    AssistantTurn(history, SourceCatalog(), {}, {}, isStreaming = busy.isTurnStreaming(history))
                    AssistantTurn(active, SourceCatalog(), {}, {}, isStreaming = busy.isTurnStreaming(active))
                }
            }
        }
        compose.onNodeWithContentDescription("Copy value: 0012", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithContentDescription("Copy value: 0034", useUnmergedTree = true).assertCountEquals(0)
    }

}

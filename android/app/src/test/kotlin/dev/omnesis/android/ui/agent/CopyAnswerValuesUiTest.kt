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
    fun completed_inline_value_copies_without_label_and_reports_success() {
        lateinit var clipboard: ClipboardManager
        compose.setContent {
            clipboard = LocalClipboardManager.current
            OmnesisTheme(darkTheme = false) {
                AssistantTurn(
                    AgentTurn.Assistant("a1", listOf(AgentPart.Text("Reference: `0012  3456`.")), stopReason = "stop"),
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
        compose.onNodeWithContentDescription("Copy code block", useUnmergedTree = true).performClick()
        compose.runOnIdle { assertEquals("\n42 Example Street  \nExampleville\n", clipboard.getText()?.text) }
    }

    @Test
    fun streaming_turn_has_no_value_buttons_even_for_finished_markdown() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AssistantTurn(
                    AgentTurn.Assistant("a1", listOf(AgentPart.Text("`0012`\n\n```\n42 Example Street\n```"))),
                    SourceCatalog(), {}, {},
                )
            }
        }
        compose.onAllNodesWithContentDescription("Copy value: 0012", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Copy code block", useUnmergedTree = true).assertCountEquals(0)
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import java.util.Locale
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyWorkingDotsUiTest {
    @get:Rule val compose = createComposeRule()

    private val running = PrivacyExchangePresentation(
        taskId = "task-example",
        question = "When is the invented review?",
        status = "running",
        outcome = "checking",
    )

    @Test
    fun feed_dots_disappear_when_the_answer_waits_for_a_person() {
        val exchange = mutableStateOf(running)
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    PrivacyFeedRow(exchange.value, Locale.UK, true, {})
                }
            }
        }
        compose.onAllNodesWithContentDescription("Answer in progress", useUnmergedTree = true).assertCountEquals(1)
        repeat(3) { compose.onAllNodesWithTag("agentWaveDot$it", useUnmergedTree = true).assertCountEquals(1) }
        compose.runOnIdle { exchange.value = running.copy(status = "pending", outcome = "needs_review") }
        compose.onAllNodesWithContentDescription("Answer in progress", useUnmergedTree = true).assertCountEquals(0)
        repeat(3) { compose.onAllNodesWithTag("agentWaveDot$it", useUnmergedTree = true).assertCountEquals(0) }
    }

    @Test
    fun conversation_moves_dots_from_drafting_to_checking_then_removes_them() {
        val exchange = mutableStateOf(running)
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    PrivacyExchangeSpine(exchange.value, events = emptyList())
                }
            }
        }
        compose.onAllNodesWithContentDescription("Drafting answer", useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodesWithContentDescription("Checking answer", useUnmergedTree = true).assertCountEquals(0)
        compose.runOnIdle { exchange.value = running.copy(draftAnswer = "The invented review is tomorrow.") }
        compose.onAllNodesWithContentDescription("Drafting answer", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Checking answer", useUnmergedTree = true).assertCountEquals(1)
        compose.runOnIdle { exchange.value = exchange.value.copy(status = "done", outcome = "shared") }
        compose.onAllNodesWithContentDescription("Checking answer", useUnmergedTree = true).assertCountEquals(0)
        repeat(3) { compose.onAllNodesWithTag("agentWaveDot$it", useUnmergedTree = true).assertCountEquals(0) }
    }
}

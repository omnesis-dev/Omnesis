// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.client.ConversationCapabilities
import dev.omnesis.android.transport.client.ConversationControls
import dev.omnesis.android.transport.client.ConversationSubmission
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ConversationMessageActionsTest {
    @get:Rule val compose = createComposeRule()
    private val queue = listOf(
        ConversationSubmission("first", "Include totals", "queued"),
        ConversationSubmission("failed", "Failed message", "failed"),
        ConversationSubmission("second", "Keep it concise", "queued"),
    )

    @Test fun userActionsOnlyAppearOnLongPress() {
        var edited = false
        compose.setContent { OmnesisTheme {
            ConversationMessageActions("Original question", "Edit and resend", { edited = true }, alignMenuEnd = true) { UserBubble("Original question") }
        } }
        compose.onNodeWithText("Edit and resend").assertDoesNotExist()
        compose.onNodeWithText("Original question").performTouchInput { longClick() }
        compose.onNodeWithText("Copy").assertExists()
        compose.onNodeWithText("Edit and resend").performClick()
        compose.runOnIdle { assertEquals(true, edited) }
    }

    @Test fun assistantMenuOnlyOffersCopy() {
        compose.setContent { OmnesisTheme {
            ConversationMessageActions("Answer text") { Text("Answer text") }
        } }
        compose.onNodeWithText("Answer text").performTouchInput { longClick() }
        compose.onNodeWithText("Copy").assertExists()
        compose.onNodeWithText("Edit and resend").assertDoesNotExist()
    }

    @Test fun queueIsOneBubbleAndSendNowUsesOriginalIds() {
        var sent = emptyList<String>()
        val state = AgentCoordinator.UiState(hasClient = true, controlsAvailable = true,
            controls = ConversationControls(queuedMessages = queue, capabilities = ConversationCapabilities(coalescedQueue = true, queueSendNow = true)))
        compose.setContent { OmnesisTheme { QueuedConversationBubble(state) { sent = it } } }
        compose.onNodeWithText("Include totals\n\nKeep it concise").assertExists().performTouchInput { longClick() }
        compose.onNodeWithText("Failed message").assertDoesNotExist()
        compose.onNodeWithText("Send now").performClick()
        compose.runOnIdle { assertEquals(listOf("first", "second"), sent) }
    }

    @Test fun olderControlsGatewayNeverOffersUnsafeSendNow() {
        val state = AgentCoordinator.UiState(hasClient = true, controlsAvailable = true,
            controls = ConversationControls(queuedMessages = queue))
        compose.setContent { OmnesisTheme { QueuedConversationBubble(state) {} } }
        compose.onNodeWithText("Include totals\n\nKeep it concise").assertDoesNotExist()
        compose.onNodeWithText("Keep it concise").assertExists()
        compose.onNodeWithText("Include totals").performTouchInput { longClick() }
        compose.onNodeWithText("Copy").assertExists()
        compose.onNodeWithText("Send now").assertDoesNotExist()
    }
}

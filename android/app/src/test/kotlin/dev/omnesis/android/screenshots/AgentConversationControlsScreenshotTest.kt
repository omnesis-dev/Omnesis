// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.material3.Text
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.client.ConversationCapabilities
import dev.omnesis.android.transport.client.ConversationChoice
import dev.omnesis.android.transport.client.ConversationClarification
import dev.omnesis.android.transport.client.ConversationControls
import dev.omnesis.android.transport.client.ConversationSubmission
import dev.omnesis.android.transport.client.ConversationSubmissionBody
import dev.omnesis.android.ui.agent.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentConversationControlsScreenshotTest {
    @get:Rule val compose = createComposeRule()
    @Test fun choicesLight() = capture("conversation_choices_light", false, choices())
    @Test fun choicesDark() = capture("conversation_choices_dark", true, choices())
    @Test fun queueLight() = capture("conversation_queue_light", false, queued())
    @Test fun queueDark() = capture("conversation_queue_dark", true, queued())
    @Test fun restoredDraftLight() = capture("conversation_draft_light", false, base().copy(composer = ComposerRecord("Compare the annual totals instead")))
    @Test fun restoredDraftDark() = capture("conversation_draft_dark", true, base().copy(composer = ComposerRecord("Compare the annual totals instead")))
    @Test fun editLight() = capture("conversation_edit_light", false, base().copy(composer = ComposerRecord("Compare the approved budgets instead", editingPrompt = true)))
    @Test fun editDark() = capture("conversation_edit_dark", true, base().copy(composer = ComposerRecord("Compare the approved budgets instead", editingPrompt = true)))
    @Test fun retryLight() = capture("conversation_retry_light", false, retry())
    @Test fun retryDark() = capture("conversation_retry_dark", true, retry())

    @Test fun userMenuLight() = menu("conversation_user_menu_light", false, "user")
    @Test fun userMenuDark() = menu("conversation_user_menu_dark", true, "user")
    @Test fun assistantMenuLight() = menu("conversation_assistant_menu_light", false, "assistant")
    @Test fun assistantMenuDark() = menu("conversation_assistant_menu_dark", true, "assistant")
    @Test fun queueMenuLight() = menu("conversation_queue_menu_light", false, "queue")
    @Test fun queueMenuDark() = menu("conversation_queue_menu_dark", true, "queue")

    private fun menu(name: String, dark: Boolean, kind: String) {
        val text = when (kind) { "queue" -> "Include a comparison table\n\nKeep the summary concise"; "user" -> "Compare the project estimates"; else -> "Here is the comparison." }
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    when (kind) {
                        "queue" -> QueuedConversationBubble(queued()) {}
                        "user" -> ConversationMessageActions(text, "Edit and resend", {}) { UserBubble(text) }
                        else -> ConversationMessageActions(text) { Text(text) }
                    }
                }
            }
        }
        compose.onNodeWithText(text).performTouchInput { longClick() }
        compose.onNode(isPopup()).captureRoboImage("src/test/roborazzi/$name.png")
    }

    private fun base() = AgentCoordinator.UiState(hasClient = true, sessionId = "conversation-example", title = "Compare project estimates", controlsAvailable = true,
        chat = AgentChatState(turns = listOf(AgentTurn.User("user-example", "Compare the project estimates"))))
    private fun choices() = base().copy(controls = ConversationControls(pendingClarification = ConversationClarification("question-example", "Which period should I compare?", listOf(
        ConversationChoice("This quarter", "Compare the latest quarterly estimates"), ConversationChoice("This year", "Compare annual totals across projects")))))
    private fun queued() = base().copy(chat = base().chat.copy(busy = true), composer = ComposerRecord("Use the approved budget instead"), controls = ConversationControls(busy = true,
        queuedMessages = listOf(ConversationSubmission("queued-example", "Include a comparison table", "queued"), ConversationSubmission("queued-second", "Keep the summary concise", "queued")),
        capabilities = ConversationCapabilities(coalescedQueue = true, queueSendNow = true)))
    private fun retry() = base().copy(composer = ComposerRecord(pending = listOf(ConversationSubmissionBody("pending-example", "Use the annual totals"))), controls = ConversationControls(
        queuedMessages = listOf(ConversationSubmission("failed-example", "Compare estimates", "failed", "Could not start this message"))))
    private fun capture(name: String, dark: Boolean, state: AgentCoordinator.UiState) {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    AgentContent(state = state, catalog = SourceCatalog(), onOpenMenu = {}, onSend = { _, _ -> }, onStop = {}, onRetry = {}, onNewConversation = {}, onFlushEphemeral = {}, onOpenDocument = {}, onInterruptAndSend = { _, _ -> })
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/roborazzi/$name.png")
    }
}

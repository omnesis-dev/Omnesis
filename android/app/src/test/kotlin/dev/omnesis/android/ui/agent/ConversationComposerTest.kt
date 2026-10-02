// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import android.content.Context
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.client.ConversationSubmissionBody
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ConversationComposerTest {
    @get:Rule val compose = createComposeRule()

    @Test fun draftsAndAmbiguousSubmissionsSurviveStoreRecreationWithoutCrossingAccounts() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val request = ConversationSubmissionBody("submission-one", "Use the annual totals", "interrupt")
        val record = ComposerRecord("Compare the estimates", "deep-research", pending = listOf(request))
        AgentComposerStore(context).write("gateway-one", "conversation-one", record)
        val restored = AgentComposerStore(context)
        assertEquals(record, restored.read("gateway-one", "conversation-one"))
        assertEquals(ComposerRecord(), restored.read("gateway-two", "conversation-one"))
        assertEquals(ComposerRecord(), restored.read("gateway-one", "conversation-two"))
        restored.remove("gateway-one", "conversation-one")
        assertEquals(ComposerRecord(), AgentComposerStore(context).read("gateway-one", "conversation-one"))
    }

    @Test fun busyImeQueuesFollowUpAndClearsPersistedDraft() {
        val sent = mutableListOf<String>()
        var persisted = "Use annual totals"
        compose.setContent {
            OmnesisTheme {
                AgentComposer(busy = true, enabled = true, initialText = persisted,
                    onSend = { text, _ -> sent += text }, onStop = {},
                    onDraftChanged = { text, _ -> persisted = text })
            }
        }
        compose.onNodeWithText("Use annual totals").performImeAction()
        compose.runOnIdle {
            assertEquals(listOf("Use annual totals"), sent)
            assertEquals("", persisted)
        }
    }

    @Test fun stopRemainsAvailableWhileDraftingBusyFollowUp() {
        var stopped = false
        val sent = mutableListOf<String>()
        compose.setContent {
            OmnesisTheme {
                AgentComposer(busy = true, enabled = true, initialText = "Keep this draft",
                    onSend = { text, _ -> sent += text }, onStop = { stopped = true })
            }
        }
        compose.onNodeWithContentDescription("Stop").performClick()
        compose.onNodeWithText("Keep this draft").assertExists()
        compose.runOnIdle { assertEquals(true, stopped); assertEquals(emptyList<String>(), sent) }
    }

    @Test fun legacyRejectedSendRestoresResearchCommandAlongsideText() {
        var restoredCommand: String? = null
        compose.setContent {
            OmnesisTheme {
                AgentComposer(busy = false, enabled = true, onSend = { _, _ -> }, onStop = {},
                    pendingRestore = "Compare the annual totals", pendingRestoreCommandId = "deep-research",
                    onDraftChanged = { _, command -> restoredCommand = command })
            }
        }
        compose.waitForIdle()
        compose.onNodeWithText("Compare the annual totals").assertExists()
        compose.runOnIdle { assertEquals("deep-research", restoredCommand) }
    }

    @Test fun interruptionRequiresItsExplicitActionAndPreservesCommand() {
        val sent = mutableListOf<String>()
        var correction = ""
        var research = false
        compose.setContent {
            OmnesisTheme {
                AgentComposer(busy = true, enabled = true, initialText = "Use a shorter period",
                    initialArmedCommand = SlashCommand.byId("deep-research"),
                    onSend = { text, _ -> sent += text }, onStop = {},
                    onInterruptAndSend = { text, command -> correction = text; research = command?.deepResearch == true })
            }
        }
        compose.onNodeWithText("Interrupt & send").performClick()
        compose.runOnIdle {
            assertEquals(emptyList<String>(), sent)
            assertEquals("Use a shorter period", correction)
            assertEquals(true, research)
        }
    }
}

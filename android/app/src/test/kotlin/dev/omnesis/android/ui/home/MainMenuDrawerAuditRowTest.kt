// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.click
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.ConversationSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Privacy is a standard control surface: an Answer integration can require an operator
 * decision in normal operation, so the menu row is there on a stock gateway. Watches stays
 * behind the experimental gate. Tasks needs no gate beyond the gateway serving it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class MainMenuDrawerAuditRowTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun modelWarningOpensModelsAndDisappearsAfterRecovery() {
        val unhealthy = mutableStateOf(true)
        var openedModels = false
        var openedSettings = false
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent", conversations = emptyList(), conversationsLoading = false,
                    onNewConversation = {}, onNavigate = {}, onResumeConversation = {}, onDeleteConversation = {},
                    onOpenSettings = { openedSettings = true }, modelsNeedAttention = unhealthy.value,
                    onOpenModelWarnings = { openedModels = true },
                )
            }
        }
        val settings = compose.onNodeWithContentDescription("Settings").assertIsDisplayed()
        val warning = compose.onNodeWithContentDescription("Show model capability errors").assertIsDisplayed()
        val settingsBounds = settings.fetchSemanticsNode().boundsInRoot
        val warningBounds = warning.fetchSemanticsNode().boundsInRoot
        assertTrue("The warning must overlap the Settings target, rather than occupy another menu slot",
            warningBounds.left < settingsBounds.right && warningBounds.right > settingsBounds.left)
        assertEquals(settingsBounds.right, warningBounds.right, 0.5f)
        assertEquals(settingsBounds.top, warningBounds.top, 0.5f)
        assertTrue("The warning must stay above the gear center", warningBounds.bottom < settingsBounds.center.y)
        // Physical taps also catch an expanded warning touch target stealing the gear center.
        settings.performTouchInput { click(center) }
        compose.runOnIdle { assertEquals(true, openedSettings); assertEquals(false, openedModels); openedSettings = false }
        warning.performTouchInput { click(center) }
        compose.runOnIdle { assertEquals(true, openedModels); assertEquals(false, openedSettings) }
        compose.runOnIdle { unhealthy.value = false }
        compose.onNodeWithContentDescription("Show model capability errors").assertDoesNotExist()
        assertEquals(settingsBounds, settings.fetchSemanticsNode().boundsInRoot)
        settings.performTouchInput { click(center) }
        compose.runOnIdle { assertEquals(true, openedSettings) }
    }

    @Test
    fun privacyIsReachableOnAStockGatewayWhileWatchesIsNot() {
        var navigated: String? = null
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    onNewConversation = {},
                    onNavigate = { navigated = it },
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    experimental = false,
                )
            }
        }

        compose.onNodeWithText("Watches").assertDoesNotExist()
        compose.onNodeWithText("Audit").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("privacy", navigated) }
    }

    @Test
    fun watchesJoinsPrivacyOnlyUnderTheExperimentalGate() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    onNewConversation = {},
                    onNavigate = {},
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    experimental = true,
                )
            }
        }

        compose.onNodeWithText("Watches").assertIsDisplayed()
        compose.onNodeWithText("Audit").assertIsDisplayed()
    }

    @Test
    fun tasksIsOfferedWheneverTheGatewayServesItWithoutTheExperimentalGate() {
        var navigated: String? = null
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    onNewConversation = {},
                    onNavigate = { navigated = it },
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    experimental = false,
                    tasksAvailable = true,
                )
            }
        }

        compose.onNodeWithText("Tasks").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("tasks", navigated) }
    }

    @Test
    fun tasksStaysHiddenOnAGatewayThatDoesNotServeIt() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    onNewConversation = {},
                    onNavigate = {},
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    experimental = true,
                    tasksAvailable = false,
                )
            }
        }

        compose.onNodeWithText("Tasks").assertDoesNotExist()
    }

    /** The gateway refuses to delete the Morning brief conversation, so its menu never offers it. */
    @Test
    fun theMorningBriefConversationOffersPinButNotDelete() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = listOf(
                        ConversationSummary(
                            sessionId = "conv_brief",
                            title = "Morning brief",
                            pinned = true,
                            origin = ConversationOrigin(kind = "daily_brief", runId = "run_example"),
                        ),
                        ConversationSummary(sessionId = "conv_plain", title = "Q4 budget recap"),
                    ),
                    conversationsLoading = false,
                    onNewConversation = {},
                    onNavigate = {},
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                )
            }
        }

        compose.onNodeWithText("Morning brief").performTouchInput { longClick() }
        compose.onNodeWithText("Unpin").assertIsDisplayed()
        compose.onNodeWithText("Delete").assertDoesNotExist()
        compose.onNodeWithText("Unpin").performClick()

        compose.onNodeWithText("Q4 budget recap").performTouchInput { longClick() }
        compose.onNodeWithText("Delete").assertIsDisplayed()
    }

    /**
     * The rows read Search, Tasks, Tell Omnesis, Sources, People, Audit, then the experimental
     * rows: Tell Omnesis sits under Tasks because telling Omnesis is how a task is added.
     */
    @Test
    fun rowsFollowTheMenuOrderWithTellOmnesisUnderTasks() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    onNewConversation = {},
                    onNavigate = {},
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    experimental = true,
                    tasksAvailable = true,
                    tasksTodayCount = 3,
                )
            }
        }

        val labels = listOf("Search", "Tasks (3)", "Tell Omnesis", "Sources", "People", "Audit", "Watches")
        val tops = labels.map { label ->
            compose.onNodeWithText(label).assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top
        }
        assertEquals(tops.sorted(), tops)
    }
}

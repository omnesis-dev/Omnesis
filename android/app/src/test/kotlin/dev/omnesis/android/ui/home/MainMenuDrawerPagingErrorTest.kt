// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.common.CursorPagingState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class MainMenuDrawerPagingErrorTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun firstPageConversationFailureHasAVisibleContextualRetry() {
        var retries = 0
        val refresh = CursorPagingState().beginRefresh()
        val failed = refresh.state.failRefresh(
            refresh.request,
            IllegalStateException("fictional drawer failure"),
        )

        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    conversationsPaging = failed,
                    conversationsError = "Could not load conversations: fictional failure",
                    onNewConversation = {},
                    onNavigate = {},
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    onRefreshConversations = { retries += 1 },
                )
            }
        }

        compose.onNodeWithText("Could not load conversations: fictional failure")
            .assertIsDisplayed()
        compose.onNodeWithText("Retry loading conversations")
            .assertIsDisplayed()
            .performClick()
        compose.runOnIdle { assertEquals(1, retries) }
    }

    @Test
    fun conversationActionFailureIsVisibleAndDismissibleWithoutAListRetry() {
        var dismissals = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    conversationActionError = "Could not delete this chat: fictional failure",
                    onNewConversation = {},
                    onNavigate = {},
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    onDismissConversationActionError = { dismissals += 1 },
                )
            }
        }

        compose.onNodeWithText("Could not delete this chat: fictional failure")
            .assertIsDisplayed()
        compose.onNodeWithText("Retry loading conversations").assertDoesNotExist()
        compose.onNodeWithContentDescription("Dismiss error").performClick()
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test
    fun tellOmnesisWarningIsExperimentalAndHasAnIndependentTapTarget() {
        var captures = 0
        var diagnostics = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    onNewConversation = {},
                    onNavigate = {},
                    onTellBrain = { captures += 1 },
                    queuedNotesNeedAttention = true,
                    onQueuedNotesWarning = { diagnostics += 1 },
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    experimental = true,
                )
            }
        }

        compose.onNodeWithContentDescription("Show notes waiting to sync")
            .assertIsDisplayed()
            .performClick()
        compose.runOnIdle {
            assertEquals(0, captures)
            assertEquals(1, diagnostics)
        }

        compose.onNodeWithText("Tell Omnesis").performClick()
        compose.runOnIdle {
            assertEquals(1, captures)
            assertEquals(1, diagnostics)
        }
    }

    @Test
    fun tellOmnesisRemainsAvailableOutsideExperimentalMode() {
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
                    queuedNotesNeedAttention = true,
                    experimental = false,
                )
            }
        }

        compose.onNodeWithText("Tell Omnesis").assertIsDisplayed()
        compose.onNodeWithContentDescription("Show notes waiting to sync").assertIsDisplayed()
    }

    @Test
    fun modelAndDeviceManagementLiveUnderSettingsInsteadOfTheDrawer() {
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
                )
            }
        }

        compose.onNodeWithContentDescription("Settings").assertIsDisplayed()
        compose.onNodeWithText("Models").assertDoesNotExist()
        compose.onNodeWithText("Devices").assertDoesNotExist()
    }
}

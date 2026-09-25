// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.BriefsMenuEntry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Privacy is a standard control surface: an Answer integration can require an operator
 * decision in normal operation, so the menu row is there on a stock gateway. Watches stays
 * behind the experimental gate.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class MainMenuDrawerAuditRowTest {
    @get:Rule
    val compose = createComposeRule()

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
    fun briefsNeedingAModelStillOpensItsFeedAndHasASeparateRepairAction() {
        var navigated: String? = null
        var repairCount = 0
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
                    briefsMenuEntry = BriefsMenuEntry.NEEDS_ATTENTION,
                    onConfigureBackgroundAgent = { repairCount += 1 },
                )
            }
        }

        compose.onNodeWithText("Briefs").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals("briefs", navigated)
            assertEquals(0, repairCount)
        }

        compose.onNodeWithContentDescription("Configure the Background agent model")
            .assertIsDisplayed()
            .performClick()
        compose.runOnIdle { assertEquals(1, repairCount) }
    }
}

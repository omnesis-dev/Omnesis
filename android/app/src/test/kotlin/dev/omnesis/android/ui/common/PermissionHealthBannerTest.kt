// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.PermissionCapability
import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionHealthEntry
import dev.omnesis.android.transport.PermissionHealthSnapshot
import dev.omnesis.android.transport.PermissionRepairAction
import dev.omnesis.android.transport.PermissionRequirement
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PermissionHealthBannerTest {
    @get:Rule val compose = createComposeRule()

    @Test fun source_row_invokes_its_generic_repair_key() {
        var repaired: Pair<String, String>? = null
        val entry = PermissionHealthEntry(
            sourceId = "fictional-source:local",
            snapshot = PermissionHealthSnapshot(
                checkedAt = 1,
                capabilities = listOf(
                    PermissionCapability(
                        id = "background",
                        label = "Background updates",
                        state = PermissionCapabilityState.BACKGROUND_ACCESS_MISSING,
                        requirement = PermissionRequirement.OPTIONAL,
                        repairAction = PermissionRepairAction.OPEN_SOURCE_SETTINGS,
                    ),
                ),
            ),
        )
        compose.setContent {
            OmnesisTheme {
                PermissionHealthBanner(listOf(entry), { "Fictional source" }) { sourceId, capabilityId ->
                    repaired = sourceId to capabilityId
                }
            }
        }

        compose.onNodeWithText("Fictional source · Background updates").performClick()
        assertEquals("fictional-source:local" to "background", repaired)
    }

    @Test fun notification_warning_invokes_repair() {
        var repairs = 0
        compose.setContent {
            OmnesisTheme { NotificationHealthBanner("permission-denied") { repairs += 1 } }
        }
        compose.onNodeWithText("Notifications are disabled").performClick()
        assertEquals(1, repairs)
    }

    @Test fun healthy_notification_state_has_no_chrome() {
        compose.setContent {
            OmnesisTheme { NotificationHealthBanner("healthy") {} }
        }
        compose.onNodeWithText("Notifications are disabled").assertDoesNotExist()
    }

    @Test fun global_banner_dismiss_cross_calls_back() {
        var dismissed = 0
        compose.setContent {
            OmnesisTheme {
                GlobalHealthWarningBanner(
                    notificationNeedsAttention = true,
                    permissionIssueCount = 0,
                    onOpenSettings = {},
                    onDismissNotification = { dismissed += 1 },
                )
            }
        }
        compose.onNodeWithText("Notifications need review.").assertExists()
        compose.onNodeWithContentDescription("Dismiss notifications warning").performClick()
        assertEquals(1, dismissed)
    }

    @Test fun global_banner_hides_cross_without_callback() {
        compose.setContent {
            OmnesisTheme {
                GlobalHealthWarningBanner(
                    notificationNeedsAttention = true,
                    permissionIssueCount = 0,
                    onOpenSettings = {},
                )
            }
        }
        compose.onNodeWithContentDescription("Dismiss notifications warning").assertDoesNotExist()
    }

}

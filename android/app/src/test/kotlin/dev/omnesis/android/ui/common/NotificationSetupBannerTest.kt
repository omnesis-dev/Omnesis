// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.session.PushPlanState
import dev.omnesis.android.transport.dto.PushPlan
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class NotificationSetupBannerTest {
    @get:Rule val compose = createComposeRule()

    @Test fun only_an_undismissed_permission_issue_shows_app_wide() {
        assertEquals(true, showsNotificationIssueGlobally(NotificationSetupIssue.PERMISSION, dismissed = false))
        assertEquals(false, showsNotificationIssueGlobally(NotificationSetupIssue.PERMISSION, dismissed = true))
        for (setup in NotificationSetupIssue.entries - NotificationSetupIssue.PERMISSION) {
            assertEquals(setup.name, false, showsNotificationIssueGlobally(setup, dismissed = false))
        }
        assertEquals(false, showsNotificationIssueGlobally(null, dismissed = false))
    }

    @Test fun setup_issue_distinguishes_build_gateway_and_permission() {
        assertEquals(NotificationSetupIssue.CLIENT_CONFIG, notificationSetupIssue(false, PushPlanState.Checking, "not-determined"))
        assertEquals(null, notificationSetupIssue(true, PushPlanState.Checking, "not-determined"))
        assertEquals(NotificationSetupIssue.PLAN_FAILED, notificationSetupIssue(true, PushPlanState.Failed, "healthy"))
        assertEquals(
            NotificationSetupIssue.DIRECT_CREDENTIAL,
            notificationSetupIssue(true, PushPlanState.Ready(PushPlan("unavailable", reasonCode = "no-direct-credential")), "healthy"),
        )
        assertEquals(
            NotificationSetupIssue.RELAY_CONSENT,
            notificationSetupIssue(true, PushPlanState.Ready(PushPlan("unavailable", reasonCode = "relay-disabled")), "healthy"),
        )
        assertEquals(
            NotificationSetupIssue.PERMISSION,
            notificationSetupIssue(true, PushPlanState.Ready(PushPlan("direct-fcm")), "permission-denied"),
        )
        assertEquals(null, notificationSetupIssue(true, PushPlanState.Ready(PushPlan("direct-fcm")), "healthy"))
        assertEquals(
            NotificationSetupIssue.REGISTRATION_FAILED,
            notificationSetupIssue(true, PushPlanState.Ready(PushPlan("direct-fcm")), "healthy", registrationFailed = true),
        )
        assertEquals(
            NotificationSetupIssue.PERMISSION,
            notificationSetupIssue(true, PushPlanState.Ready(PushPlan("direct-fcm")), "permission-denied", registrationFailed = true),
        )
    }

    @Test fun missing_gateway_credential_names_actual_package_and_offers_retry_and_help() {
        var retries = 0
        var help = 0
        compose.setContent {
            OmnesisTheme {
                NotificationSetupBanner(
                    NotificationSetupIssue.DIRECT_CREDENTIAL,
                    "dev.example.omnesis",
                    { retries += 1 },
                    { help += 1 },
                )
            }
        }
        compose.onNodeWithText("No direct FCM credential covers dev.example.omnesis on this gateway. Run omnesis push setup for this package, then retry.")
            .assertExists()
        compose.onNodeWithText("Retry").performClick()
        compose.onNodeWithText("Setup guide").performClick()
        assertEquals(1, retries)
        assertEquals(1, help)
    }

    @Test fun missing_client_config_requires_a_rebuild_instead_of_an_in_app_retry() {
        compose.setContent {
            OmnesisTheme {
                NotificationSetupBanner(NotificationSetupIssue.CLIENT_CONFIG, "dev.example.omnesis", {}, {})
            }
        }
        compose.onNodeWithText("Configure Firebase for dev.example.omnesis and rebuild the app. The phone cannot add build settings after installation.")
            .assertExists()
        compose.onNodeWithText("Retry").assertDoesNotExist()
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationWarningDismissalTest {
    @Test fun permissionIssueShowsUntilDismissed() {
        assertTrue(
            NotificationWarningDismissal.shouldShowWarning(NotificationSetupIssue.PERMISSION, false),
        )
        assertFalse(
            NotificationWarningDismissal.shouldShowWarning(NotificationSetupIssue.PERMISSION, true),
        )
    }

    @Test fun setupIssuesAreNeverDismissible() {
        // Dismissal covers only the disabled-delivery case; setup problems
        // keep showing until fixed.
        for (issue in NotificationSetupIssue.entries) {
            if (issue == NotificationSetupIssue.PERMISSION) continue
            assertFalse(
                "$issue must not be treated as the dismissible warning",
                NotificationWarningDismissal.shouldShowWarning(issue, false),
            )
            assertFalse(
                "$issue must not be treated as the dismissible warning",
                NotificationWarningDismissal.shouldShowWarning(issue, true),
            )
        }
        assertFalse(NotificationWarningDismissal.shouldShowWarning(null, false))
    }

    @Test fun onlyHealthyDeliveryOpensANewEpoch() {
        assertTrue(NotificationWarningDismissal.shouldResetDismissal("healthy"))
        for (health in listOf("not-determined", "permission-denied", "scheduled-summary", "alerts-disabled")) {
            assertFalse(
                "$health must not clear the dismissal",
                NotificationWarningDismissal.shouldResetDismissal(health),
            )
        }
    }
}

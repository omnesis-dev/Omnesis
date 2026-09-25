// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrivacyNavigationTest {
    @Test
    fun conversationIdRemainsOneNavigationSegment() {
        assertEquals(
            "privacy/conversations/conversation%2Fexample%3F%23",
            privacyConversationRoute("conversation/example?#"),
        )
    }

    @Test
    fun directSessionIdRemainsOneNavigationSegment() {
        assertEquals(
            "privacy/direct/sessions/direct%2Fsession%3F%23",
            directAuditSessionRoute("direct/session?#"),
        )
    }

    @Test
    fun exchangeRouteKeepsBothIdsAsSingleSegments() {
        assertEquals(
            "privacy/conversations/conversation%2Fexample%3F%23/exchanges/task%2Fexample%3F%23",
            privacyExchangeRoute("conversation/example?#", "task/example?#"),
        )
    }

    @Test
    fun deletionFallsBackToPrivacyWhenDirectEntryHasNoPrivacyBackStackEntry() {
        var navigated = false

        returnToPrivacyAfterDeletion(
            popToPrivacy = { false },
            navigateToTopLevelPrivacy = { navigated = true },
        )

        assertTrue(navigated)
    }

    @Test
    fun deletionDoesNotDuplicatePrivacyWhenItCanPopThere() {
        var navigated = false

        returnToPrivacyAfterDeletion(
            popToPrivacy = { true },
            navigateToTopLevelPrivacy = { navigated = true },
        )

        assertFalse(navigated)
    }
}

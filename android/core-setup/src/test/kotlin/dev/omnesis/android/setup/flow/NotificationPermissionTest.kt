// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPermissionTest {
    @Test
    fun theStateFollowsTheApiLevelTheGrantAndWhetherItWasAsked() {
        assertEquals(NotificationPermissionState.NOT_REQUIRED, notificationPermissionState(32, granted = false, prompted = false))
        assertEquals(NotificationPermissionState.UNDETERMINED, notificationPermissionState(33, granted = false, prompted = false))
        assertEquals(NotificationPermissionState.DENIED, notificationPermissionState(34, granted = false, prompted = true))
        assertEquals(NotificationPermissionState.GRANTED, notificationPermissionState(34, granted = true, prompted = true))
    }

    @Test
    fun aChosenPageOrButtonMayAskOnlyWhileAndroidWouldStillShowThePrompt() {
        assertTrue(notificationPromptAvailable(NotificationPermissionState.UNDETERMINED))
        assertFalse(notificationPromptAvailable(NotificationPermissionState.DENIED))
        assertFalse(notificationPromptAvailable(NotificationPermissionState.GRANTED))
        assertFalse(notificationPromptAvailable(NotificationPermissionState.NOT_REQUIRED))
    }

    @Test
    fun theChooseRowIsHiddenDisabledOrShownAsOn() {
        assertEquals(SetupAvailability.Hidden, notificationRow("n", NotificationPermissionState.NOT_REQUIRED).availability)
        assertEquals(SetupAvailability.Disabled("Off in Settings"), notificationRow("n", NotificationPermissionState.DENIED).availability)
        val granted = notificationRow("n", NotificationPermissionState.GRANTED)
        assertTrue(granted.on)
        assertFalse(granted.selectable)
        assertTrue(notificationRow("n", NotificationPermissionState.UNDETERMINED).selectable)
    }

    @Test
    fun aBuildThatCannotDeliverNotificationsNeverOffersTheRow() {
        assertEquals(
            SetupAvailability.Hidden,
            notificationRow("n", NotificationPermissionState.UNDETERMINED, pushConfigured = false).availability,
        )
    }
}

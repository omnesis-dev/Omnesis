// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.setup

import dev.omnesis.android.feature.photos.PhotosAccess
import dev.omnesis.android.setup.flow.SetupOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotosSetupOutcomeTest {
    @Test
    fun fullAccessIsOnAndASelectionIsLimitedNotAFailure() {
        assertEquals(SetupOutcome.On, photosSetupOutcome(PhotosAccess.FULL))
        assertEquals(SetupOutcome.Limited, photosSetupOutcome(PhotosAccess.LIMITED))
        assertEquals(SetupOutcome.NotAllowed, photosSetupOutcome(PhotosAccess.DENIED))
    }

    @Test
    fun theSettingsStepsNameThePermissionAsTheRunningAndroidShowsIt() {
        assertEquals("In Settings, tap Permissions, then Photos and videos, and choose Allow all.", photosSettingsSteps(34))
        assertEquals("In Settings, tap Permissions, then Photos and videos, and choose Allow.", photosSettingsSteps(33))
        assertEquals("In Settings, tap Permissions, then Storage (or Files and media), and choose Allow.", photosSettingsSteps(32))
    }

    @Test
    fun theDisclosureNamesBackgroundAccessAndTheLimitedOutcomeOffersMore() {
        assertTrue(PhotosSetupCopy.disclosure!!.contains("including while the app is closed"))
        assertNotNull(PhotosSetupCopy.limitedBody)
        assertEquals("Add more photos", PhotosSetupCopy.limitedActionLabel)
        assertEquals(listOf("The photos themselves"), PhotosSetupCopy.ledger!!.stays)
    }
}

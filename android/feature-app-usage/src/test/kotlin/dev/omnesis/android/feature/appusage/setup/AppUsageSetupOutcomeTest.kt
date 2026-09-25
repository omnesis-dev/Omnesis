// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.setup

import dev.omnesis.android.setup.flow.SetupOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUsageSetupOutcomeTest {
    @Test
    fun aGrantIsOnAndItsAbsenceIsNotAllowed() {
        assertEquals(SetupOutcome.On, appUsageSetupOutcome(granted = true))
        assertEquals(SetupOutcome.NotAllowed, appUsageSetupOutcome(granted = false))
    }

    @Test
    fun theDisclosureNamesBackgroundAccess() {
        assertTrue(AppUsageSetupCopy.disclosure!!.contains("including while the app is closed"))
    }

    @Test
    fun agreeingSaysItOpensSettings() {
        assertEquals("Agree & open settings", AppUsageSetupCopy.primaryLabel)
    }
}

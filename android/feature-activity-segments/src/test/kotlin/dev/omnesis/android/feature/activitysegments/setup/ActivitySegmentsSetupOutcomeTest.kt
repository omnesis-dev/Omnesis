// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments.setup

import dev.omnesis.android.feature.activitysegments.ActivitySegmentsAvailability
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivitySegmentsSetupOutcomeTest {
    @Test
    fun choseDisablesTheRowWhenPlayServicesCannotBeFixedFromThePhone() {
        val needsGms = SetupAvailability.Disabled("Needs Google Play services")
        assertEquals(needsGms, activitySegmentsSetupAvailability(ActivitySegmentsAvailability.NotSupported))
        assertEquals(needsGms, activitySegmentsSetupAvailability(ActivitySegmentsAvailability.NotInstalled))
        assertEquals(SetupAvailability.Available, activitySegmentsSetupAvailability(ActivitySegmentsAvailability.UpdateRequired))
        assertEquals(SetupAvailability.Available, activitySegmentsSetupAvailability(ActivitySegmentsAvailability.Available))
    }

    @Test
    fun onlyAnUpdateOffersAnAction() {
        val update = activitySegmentsSetupUnavailable(ActivitySegmentsAvailability.UpdateRequired)!!
        assertEquals("Google Play services needs an update", update.title)
        assertEquals("Update Google Play services", update.actionLabel)

        assertNull(activitySegmentsSetupUnavailable(ActivitySegmentsAvailability.NotInstalled)!!.actionLabel)
        assertNull(activitySegmentsSetupUnavailable(ActivitySegmentsAvailability.NotSupported)!!.actionLabel)
        assertNull(activitySegmentsSetupUnavailable(ActivitySegmentsAvailability.Available))
    }

    @Test
    fun playServicesDecidesBeforeThePermission() {
        listOf(true, false).forEach { granted ->
            assertTrue(activitySegmentsSetupOutcome(ActivitySegmentsAvailability.UpdateRequired, granted) is SetupOutcome.Unavailable)
        }
        assertEquals(SetupOutcome.On, activitySegmentsSetupOutcome(ActivitySegmentsAvailability.Available, granted = true))
        assertEquals(SetupOutcome.NotAllowed, activitySegmentsSetupOutcome(ActivitySegmentsAvailability.Available, granted = false))
    }

    @Test
    fun resumingReDerivesAnEnabledSourceAndReopensAnUpdateThatLanded() {
        val update = activitySegmentsSetupUnavailable(ActivitySegmentsAvailability.UpdateRequired)!!
        assertEquals(
            SetupOutcome.NotAllowed,
            activitySegmentsRefreshedOutcome(on = true, ActivitySegmentsAvailability.Available, granted = false, previous = SetupOutcome.On),
        )
        assertEquals(
            SetupOutcome.On,
            activitySegmentsRefreshedOutcome(on = true, ActivitySegmentsAvailability.Available, granted = true, previous = SetupOutcome.NotAllowed),
        )
        assertNull(activitySegmentsRefreshedOutcome(on = false, ActivitySegmentsAvailability.Available, granted = false, previous = update))
        assertEquals(update, activitySegmentsRefreshedOutcome(on = false, ActivitySegmentsAvailability.UpdateRequired, granted = false, previous = update))
        assertEquals(
            SetupOutcome.NotAllowed,
            activitySegmentsRefreshedOutcome(on = false, ActivitySegmentsAvailability.Available, granted = true, previous = SetupOutcome.NotAllowed),
        )
    }

    @Test
    fun theCopyDisclosesBackgroundAccessAndWhatIsSent() {
        assertTrue(ActivitySegmentsSetupCopy.disclosure!!.contains("including while the app is closed"))
        assertTrue(ActivitySegmentsSetupCopy.ledger!!.sent.isNotEmpty())
        assertTrue(ActivitySegmentsSetupCopy.ledger!!.stays.isNotEmpty())
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivitySegmentsSyncWorkerGatingTest {

    @Test
    fun `runs only when enabled, permitted, available, and a session exists`() {
        assertTrue(
            shouldRunBackgroundSync(
                enabled = true,
                hasPermission = true,
                availability = ActivitySegmentsAvailability.Available,
                hasSession = true,
            ),
        )
    }

    @Test
    fun `does not run when disabled`() {
        assertFalse(
            shouldRunBackgroundSync(
                enabled = false,
                hasPermission = true,
                availability = ActivitySegmentsAvailability.Available,
                hasSession = true,
            ),
        )
    }

    @Test
    fun `does not run without the activity-recognition permission`() {
        assertFalse(
            shouldRunBackgroundSync(
                enabled = true,
                hasPermission = false,
                availability = ActivitySegmentsAvailability.Available,
                hasSession = true,
            ),
        )
    }

    @Test
    fun `does not run when Google Play services is unavailable`() {
        assertFalse(
            shouldRunBackgroundSync(
                enabled = true,
                hasPermission = true,
                availability = ActivitySegmentsAvailability.NotInstalled,
                hasSession = true,
            ),
        )
    }

    @Test
    fun `does not run while unpaired`() {
        assertFalse(
            shouldRunBackgroundSync(
                enabled = true,
                hasPermission = true,
                availability = ActivitySegmentsAvailability.Available,
                hasSession = false,
            ),
        )
    }
}

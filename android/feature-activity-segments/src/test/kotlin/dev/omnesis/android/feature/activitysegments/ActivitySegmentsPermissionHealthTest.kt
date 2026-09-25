// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionRepairAction
import org.junit.Assert.assertEquals
import org.junit.Test

class ActivitySegmentsPermissionHealthTest {
    @Test fun permission_and_provider_availability_are_distinct() {
        val healthy = activitySegmentsPermissionSnapshot(1, ActivitySegmentsAvailability.Available, true).capabilities.single()
        val revoked = activitySegmentsPermissionSnapshot(2, ActivitySegmentsAvailability.Available, false).capabilities.single()
        val unavailable = activitySegmentsPermissionSnapshot(3, ActivitySegmentsAvailability.NotInstalled, true).capabilities.single()
        assertEquals(PermissionCapabilityState.HEALTHY, healthy.state)
        assertEquals(PermissionCapabilityState.PERMISSION_DEGRADED, revoked.state)
        assertEquals(PermissionRepairAction.OPEN_SOURCE_SETTINGS, revoked.repairAction)
        assertEquals(PermissionCapabilityState.UNAVAILABLE, unavailable.state)
        assertEquals(PermissionRepairAction.OPEN_SYSTEM_SETTINGS, unavailable.repairAction)
    }
}

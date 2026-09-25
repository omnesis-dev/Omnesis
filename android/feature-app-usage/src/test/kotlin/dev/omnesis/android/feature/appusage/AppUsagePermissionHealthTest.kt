// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionRepairAction
import org.junit.Assert.assertEquals
import org.junit.Test

class AppUsagePermissionHealthTest {
    @Test fun grant_and_revocation_have_truthful_states_and_repairs() {
        val healthy = appUsagePermissionSnapshot(1, true).capabilities.single()
        val revoked = appUsagePermissionSnapshot(2, false).capabilities.single()
        assertEquals(PermissionCapabilityState.HEALTHY, healthy.state)
        assertEquals(PermissionRepairAction.NONE, healthy.repairAction)
        assertEquals(PermissionCapabilityState.PERMISSION_DEGRADED, revoked.state)
        assertEquals(PermissionRepairAction.OPEN_SOURCE_SETTINGS, revoked.repairAction)
    }
}

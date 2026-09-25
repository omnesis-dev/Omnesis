// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionRepairAction
import org.junit.Assert.assertEquals
import org.junit.Test

class CallLogPermissionHealthTest {
    @Test fun grant_and_revocation_have_truthful_states_and_repairs() {
        val healthy = callLogPermissionSnapshot(1, true).capabilities.single()
        val revoked = callLogPermissionSnapshot(2, false).capabilities.single()
        assertEquals(PermissionCapabilityState.HEALTHY, healthy.state)
        assertEquals(PermissionRepairAction.NONE, healthy.repairAction)
        assertEquals(PermissionCapabilityState.PERMISSION_DEGRADED, revoked.state)
        assertEquals(PermissionRepairAction.OPEN_SOURCE_SETTINGS, revoked.repairAction)
    }
}

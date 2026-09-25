// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivitySegmentsSettingsTest {
    @Test fun `permanent denial survives relaunch and reset clears it`() {
        val store = InMemoryKeyValueStore()
        ActivitySegmentsSettings(store).recordPermissionResult(granted = false, permanentlyDenied = true)

        val relaunched = ActivitySegmentsSettings(store)
        assertTrue(relaunched.permissionPermanentlyDenied)

        relaunched.reset()
        assertFalse(ActivitySegmentsSettings(store).permissionPermanentlyDenied)
    }

    @Test
    fun `grant clears denial so a later OS auto-reset remains requestable after relaunch`() {
        val store = InMemoryKeyValueStore()
        ActivitySegmentsSettings(store).recordPermissionResult(granted = false, permanentlyDenied = true)
        ActivitySegmentsSettings(store).recordPermissionResult(granted = true, permanentlyDenied = false)
        ActivitySegmentsSettings(store).observePermission(granted = false)

        assertFalse(ActivitySegmentsSettings(store).permissionPermanentlyDenied)
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUsageSyncWorkerGatingTest {

    @Test
    fun `runs only when enabled, permitted, and a session exists`() {
        assertTrue(shouldRunBackgroundSync(enabled = true, hasUsageAccess = true, hasSession = true))
    }

    @Test
    fun `does not run when disabled`() {
        assertFalse(shouldRunBackgroundSync(enabled = false, hasUsageAccess = true, hasSession = true))
    }

    @Test
    fun `does not run without usage access`() {
        assertFalse(shouldRunBackgroundSync(enabled = true, hasUsageAccess = false, hasSession = true))
    }

    @Test
    fun `does not run while unpaired`() {
        assertFalse(shouldRunBackgroundSync(enabled = true, hasUsageAccess = true, hasSession = false))
    }
}

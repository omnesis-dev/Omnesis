// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallLogSyncWorkerGatingTest {

    @Test
    fun `runs only when enabled, permitted, and a session exists`() {
        assertTrue(shouldRunBackgroundSync(enabled = true, hasPermission = true, hasSession = true))
    }

    @Test
    fun `does not run when disabled`() {
        assertFalse(shouldRunBackgroundSync(enabled = false, hasPermission = true, hasSession = true))
    }

    @Test
    fun `does not run without the READ_CALL_LOG permission`() {
        assertFalse(shouldRunBackgroundSync(enabled = true, hasPermission = false, hasSession = true))
    }

    @Test
    fun `does not run while unpaired`() {
        assertFalse(shouldRunBackgroundSync(enabled = true, hasPermission = true, hasSession = false))
    }
}

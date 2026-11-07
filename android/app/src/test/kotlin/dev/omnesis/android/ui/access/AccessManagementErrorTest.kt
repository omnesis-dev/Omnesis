// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.GatewayException
import org.junit.Assert.*
import org.junit.Test

class AccessManagementErrorTest {
    @Test fun dependencyNameConflictAndTransientFailuresHaveDifferentRemedies() {
        val dependency = GatewayException.ServerError(409, "{\"error\":\"level-in-use\"}")
        assertEquals("level-in-use", accessManagementErrorCode(dependency))
        assertTrue(accessManagementError(dependency).contains("Move them to another access level"))
        assertFalse(accessManagementError(dependency).contains("Try again"))
        assertTrue(accessManagementError(GatewayException.ServerError(409, null, "level-name-taken")).contains("Choose another"))
        assertTrue(accessManagementError(GatewayException.ServerError(503, "unavailable")).contains("Try again"))
        assertNull(accessManagementErrorCode(GatewayException.ServerError(409, "not-level-in-use")))
    }
}

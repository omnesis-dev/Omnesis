// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import dev.omnesis.android.transport.PermissionHealthEntry
import dev.omnesis.android.transport.PermissionHealthSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsPermissionFocusTest {
    private val first = PermissionHealthEntry(
        sourceId = "fictional-mobile:first",
        snapshot = PermissionHealthSnapshot(checkedAt = 1, capabilities = emptyList()),
    )
    private val second = PermissionHealthEntry(
        sourceId = "fictional-mobile:second",
        snapshot = PermissionHealthSnapshot(checkedAt = 1, capabilities = emptyList()),
    )

    @Test
    fun exactFocusNeverFallsBackToAnUnrelatedSource() {
        assertEquals(emptyList<PermissionHealthEntry>(), permissionHealthForFocus(listOf(first), second.sourceId))
        assertEquals(listOf(second), permissionHealthForFocus(listOf(first, second), second.sourceId))
    }

    @Test
    fun manualSettingsWithoutFocusShowsEverySource() {
        assertEquals(listOf(first, second), permissionHealthForFocus(listOf(first, second), null))
    }
}

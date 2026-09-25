// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.dto.SourceSyncStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SourceSyncStatusReaderTest {
    @Test
    fun `multi-device status selects this phone and never falls back to a sibling`() {
        val local = SourceSyncStatus(sourceId = "photos:local", deviceId = "phone-a", state = "synced")
        val sibling = SourceSyncStatus(sourceId = "photos:local", deviceId = "phone-b", state = "error")
        val aggregate = sibling.copy(members = listOf(local, sibling))

        assertEquals("synced", aggregate.forDevice("phone-a")?.state)
        assertNull(aggregate.forDevice("phone-c"))
        assertNull(sibling.forDevice("phone-a"))
        assertEquals("error", sibling.forDevice("phone-b")?.state)
    }

}

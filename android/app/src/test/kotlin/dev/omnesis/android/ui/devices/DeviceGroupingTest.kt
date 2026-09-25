// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import dev.omnesis.android.transport.dto.DeviceRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic coverage for the Devices screen grouping + status rules. Runs in
 * the JVM logic lane (`scripts/android-logic.sh`) — no emulator / Roborazzi.
 */
class DeviceGroupingTest {
    private fun device(id: String, online: Boolean, lastSeenAt: Long?, revokedAt: Long? = null): DeviceRecord =
        DeviceRecord(id = id, name = id, kind = "cli", pairedAt = 1000, lastSeenAt = lastSeenAt, online = online, revokedAt = revokedAt)

    @Test
    fun pinsThisDeviceAndSplitsTheRest() {
        val devices = listOf(
            device("cli", online = false, lastSeenAt = 100),
            device("collector", online = true, lastSeenAt = 900),
            device("phone", online = false, lastSeenAt = 500),
            device("portal", online = false, lastSeenAt = 950),
        )
        val grouped = DeviceGrouping.group(devices, thisDeviceId = "portal")
        assertEquals("portal", grouped.thisDevice?.id)
        assertEquals(listOf("collector"), grouped.live.map { it.id })
        // other sorted most-recently-active first
        assertEquals(listOf("phone", "cli"), grouped.other.map { it.id })
    }

    @Test
    fun pinsCurrentDeviceEvenWhenOffline() {
        val devices = listOf(
            device("cli", online = false, lastSeenAt = 100),
            device("collector", online = true, lastSeenAt = 900),
        )
        val grouped = DeviceGrouping.group(devices, thisDeviceId = "cli")
        assertEquals("cli", grouped.thisDevice?.id)
        assertEquals(listOf("collector"), grouped.live.map { it.id })
        assertTrue(grouped.other.isEmpty())
    }

    @Test
    fun noThisDeviceMatchLeavesItNull() {
        val devices = listOf(
            device("a", online = true, lastSeenAt = 1),
            device("b", online = false, lastSeenAt = 1),
        )
        val grouped = DeviceGrouping.group(devices, thisDeviceId = null)
        assertNull(grouped.thisDevice)
        assertEquals(1, grouped.live.size)
        assertEquals(1, grouped.other.size)
    }

    @Test
    fun statusLine() {
        val now = 10_000L
        assertEquals(
            "Active now",
            DeviceGrouping.statusLine(
                device("x", online = false, lastSeenAt = null),
                isCurrent = true,
                now = now,
            ),
        )
        assertEquals(
            "Live connection",
            DeviceGrouping.statusLine(device("x", online = true, lastSeenAt = 1), now = now),
        )
        assertTrue(
            DeviceGrouping.statusLine(device("x", online = false, lastSeenAt = 1), now = now)
                .startsWith("Last active "),
        )
        assertEquals(
            "No activity recorded",
            DeviceGrouping.statusLine(device("x", online = false, lastSeenAt = null), now = now),
        )
    }

    @Test
    fun liveConnectionCountUsesOnlyWebSocketPresence() {
        val devices = listOf(
            device("portal", online = false, lastSeenAt = null),
            device("collector", online = true, lastSeenAt = 1),
        )
        assertEquals(1, DeviceGrouping.liveConnectionCount(devices))
    }

    // ── revoked beats online ─────────────────────────────────────────

    @Test
    fun revokedDeviceIsNeverLiveAndSortsAfterPairedOnes() {
        val devices = listOf(
            device("stale", online = false, lastSeenAt = 100),
            device("evicting", online = true, lastSeenAt = 950, revokedAt = 960),
            device("collector", online = true, lastSeenAt = 900),
            device("old", online = false, lastSeenAt = 50, revokedAt = 60),
        )
        val grouped = DeviceGrouping.group(devices, thisDeviceId = null)
        assertEquals(listOf("collector"), grouped.live.map { it.id })
        // Paired first (by activity), then the revoked ones (by activity).
        assertEquals(listOf("stale", "evicting", "old"), grouped.other.map { it.id })
    }

    @Test
    fun revokedStatusOutranksCurrentAndLive() {
        val now = 10_000L
        val revoked = device("x", online = true, lastSeenAt = 9_000, revokedAt = 9_500)
        assertEquals("Revoked just now", DeviceGrouping.statusLine(revoked, isCurrent = true, now = now))
        assertEquals("Revoked just now", DeviceGrouping.statusLine(revoked, now = now))
    }

    @Test
    fun countsExcludeRevokedFromLiveAndCountThemSeparately() {
        val devices = listOf(
            device("collector", online = true, lastSeenAt = 1),
            device("evicting", online = true, lastSeenAt = 1, revokedAt = 2),
            device("old", online = false, lastSeenAt = null, revokedAt = 3),
        )
        assertEquals(1, DeviceGrouping.liveConnectionCount(devices))
        assertEquals(2, DeviceGrouping.revokedCount(devices))
    }
}

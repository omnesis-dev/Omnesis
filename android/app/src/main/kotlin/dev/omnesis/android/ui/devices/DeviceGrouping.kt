// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.ui.common.TimeFormat

/**
 * Pure grouping + status helpers for the Devices screen. Kept free of Compose
 * so the JVM logic lane exercises them without an emulator, and so the This
 * device / Live connections / Other devices rules match the web portal's
 * `device-grouping.js` and the iOS `DeviceGrouping`.
 */
object DeviceGrouping {
    data class Grouped(
        /** Device backing the current app session (pinned), or null when unknown. */
        val thisDevice: DeviceRecord?,
        /** Devices with a live WebSocket (minus this device), newest activity first. */
        val live: List<DeviceRecord>,
        /**
         * Other paired devices (minus this device), newest activity first, with
         * revoked devices after the paired ones.
         */
        val other: List<DeviceRecord>,
    )

    /**
     * Split the device list into the three rendered buckets. The current
     * device is pinned regardless of whether it has a live socket, so the "you are
     * here" anchor never disappears. A revoked device is never live: its socket,
     * if one is still draining, is being evicted.
     */
    fun group(devices: List<DeviceRecord>, thisDeviceId: String?): Grouped {
        var thisDevice: DeviceRecord? = null
        val live = mutableListOf<DeviceRecord>()
        val other = mutableListOf<DeviceRecord>()
        for (device in devices) {
            if (thisDeviceId != null && device.id == thisDeviceId) {
                thisDevice = device
                continue
            }
            if (device.online == true && !device.revoked) live.add(device) else other.add(device)
        }
        val byLastSeen = compareByDescending<DeviceRecord> { it.lastSeenAt ?: 0L }
        val byRevokedLast = compareBy<DeviceRecord> { it.revoked }.then(byLastSeen)
        return Grouped(
            thisDevice = thisDevice,
            live = live.sortedWith(byLastSeen),
            other = other.sortedWith(byRevokedLast),
        )
    }

    /**
     * Loading the list proves the current authenticated client is active.
     * Other live WebSockets are identified as transport connections; devices
     * without one are described by recorded activity, not called offline. A
     * revocation outranks everything: its tokens are gone whatever the socket
     * still says.
     */
    fun statusLine(
        device: DeviceRecord,
        isCurrent: Boolean = false,
        now: Long = System.currentTimeMillis(),
    ): String {
        val revokedAt = device.revokedAt
        val lastSeenAt = device.lastSeenAt
        return when {
            revokedAt != null -> "Revoked ${TimeFormat.relative(revokedAt, now)}"
            isCurrent -> "Active now"
            device.online == true -> "Live connection"
            lastSeenAt != null -> "Last active ${TimeFormat.relative(lastSeenAt, now)}"
            else -> "No activity recorded"
        }
    }

    /** Device WebSockets live in the gateway's current snapshot, revoked ones excluded. */
    fun liveConnectionCount(devices: List<DeviceRecord>): Int =
        devices.count { it.online == true && !it.revoked }

    /** Devices whose access has been revoked; they keep their row and sources. */
    fun revokedCount(devices: List<DeviceRecord>): Int = devices.count { it.revoked }
}

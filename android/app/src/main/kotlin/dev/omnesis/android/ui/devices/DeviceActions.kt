// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import dev.omnesis.android.transport.dto.DeviceRecord

/** Something the owner can do to a paired device from its row. */
enum class DeviceAction(val title: String, val destructive: Boolean) {
    Repair("Repair device", false),
    Revoke("Revoke device", true),
    Forget("Forget device", true),
}

/** One entry of a device's "..." menu. */
data class DeviceMenuItem(val action: DeviceAction, val enabled: Boolean = true)

/**
 * The one list of what a device row offers, in menu order. Every device gets the same actions
 * however it joined: a device that joined by signing in has no extra shortcut. The menu
 * renders this list and nothing else, so changing what a device offers, or in which order, is
 * a change here alone.
 */
object DeviceActions {
    /**
     * Non-portal devices can be repaired while offline. A paired device can be revoked; a
     * revoked device can be repaired or forgotten.
     */
    fun menu(device: DeviceRecord, isThis: Boolean): List<DeviceMenuItem> = buildList {
        if (device.kind != "portal") add(DeviceMenuItem(DeviceAction.Repair, enabled = !isThis && device.online != true))
        add(DeviceMenuItem(if (device.revoked) DeviceAction.Forget else DeviceAction.Revoke))
    }
}

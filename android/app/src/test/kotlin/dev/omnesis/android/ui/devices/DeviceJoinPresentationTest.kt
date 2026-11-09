// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import dev.omnesis.android.transport.dto.DeviceEnrollmentRecord
import dev.omnesis.android.transport.dto.DeviceRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceJoinPresentationTest {
    @Test fun `each way of joining reads plainly`() {
        // A device that joined by signing in reads the same whatever the sign-in was.
        assertEquals("Joined with Omnesis account", deviceJoinLabel(DeviceEnrollmentRecord("automatic", "google")))
        assertEquals("Joined with Omnesis account", deviceJoinLabel(DeviceEnrollmentRecord("automatic", "passkey")))
        assertEquals("Joined with Omnesis account", deviceJoinLabel(DeviceEnrollmentRecord("automatic")))
        assertEquals("Approved", deviceJoinLabel(DeviceEnrollmentRecord("approved", "google")))
        // Any other way in, as a pairing code or QR, has no label.
        assertNull(deviceJoinLabel(DeviceEnrollmentRecord("something-newer")))
        assertEquals("Google", deviceSignInMethod("google"))
        assertEquals("Passkey", deviceSignInMethod("passkey"))
        assertNull(deviceSignInMethod(null))
    }

    @Test fun `every device offers the same actions however it joined`() {
        val phone = DeviceRecord(id = "d", name = "Maya's Phone", kind = "android", pairedAt = 1, online = false)
        val joined = phone.copy(enrollment = DeviceEnrollmentRecord("automatic", "google"))
        val expected = listOf(DeviceMenuItem(DeviceAction.Repair), DeviceMenuItem(DeviceAction.Revoke))
        assertEquals(expected, DeviceActions.menu(phone, isThis = false))
        assertEquals(expected, DeviceActions.menu(joined, isThis = false))
        assertEquals(listOf("Repair device", "Revoke device"), expected.map { it.action.title })
        // This phone and a connected device cannot be repaired; a portal session never is.
        assertEquals(listOf(DeviceMenuItem(DeviceAction.Repair, enabled = false), DeviceMenuItem(DeviceAction.Revoke)), DeviceActions.menu(phone, isThis = true))
        assertEquals(false, DeviceActions.menu(phone.copy(online = true), isThis = false).first().enabled)
        assertEquals(listOf(DeviceMenuItem(DeviceAction.Revoke)), DeviceActions.menu(phone.copy(kind = "portal"), isThis = false))
        assertEquals(DeviceAction.Forget, DeviceActions.menu(phone.copy(revokedAt = 2), isThis = false).last().action)
    }
}

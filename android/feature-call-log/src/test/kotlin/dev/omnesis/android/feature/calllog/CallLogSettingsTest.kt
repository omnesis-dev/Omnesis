// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallLogSettingsTest {

    @Test
    fun `defaults to disabled with no permission request recorded`() {
        val settings = CallLogSettings(InMemoryKeyValueStore())
        assertFalse(settings.callLogEnabled)
        assertFalse(settings.permissionPermanentlyDenied)
    }

    @Test
    fun `enabled and permanent denial round-trip through the store`() {
        val settings = CallLogSettings(InMemoryKeyValueStore())
        settings.callLogEnabled = true
        settings.permissionPermanentlyDenied = true
        assertTrue(settings.callLogEnabled)
        assertTrue(settings.permissionPermanentlyDenied)
    }

    @Test
    fun `reset wipes every setting back to defaults`() {
        val settings = CallLogSettings(InMemoryKeyValueStore())
        settings.callLogEnabled = true
        settings.permissionPermanentlyDenied = true

        settings.reset()

        assertFalse(settings.callLogEnabled)
        assertFalse(settings.permissionPermanentlyDenied)
    }

    @Test
    fun `a fresh CallLogSettings instance reads whatever the backing store already holds`() {
        val store = InMemoryKeyValueStore(
            mapOf(
                CallLogSettings.Keys.ENABLED to "true",
                CallLogSettings.Keys.PERMISSION_PERMANENTLY_DENIED to "true",
            ),
        )
        val settings = CallLogSettings(store)
        assertTrue(settings.callLogEnabled)
        assertTrue(settings.permissionPermanentlyDenied)
    }

    @Test
    fun `grant clears denial so a later OS auto-reset remains requestable after relaunch`() {
        val store = InMemoryKeyValueStore()
        CallLogSettings(store).recordPermissionResult(granted = false, permanentlyDenied = true)
        CallLogSettings(store).recordPermissionResult(granted = true, permanentlyDenied = false)
        CallLogSettings(store).observePermission(granted = false)

        assertFalse(CallLogSettings(store).permissionPermanentlyDenied)
    }
}

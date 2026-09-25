// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUsageSettingsTest {

    @Test
    fun `defaults to disabled`() {
        val settings = AppUsageSettings(InMemoryKeyValueStore())
        assertFalse(settings.appUsageEnabled)
    }

    @Test
    fun `enabled round-trips through the store`() {
        val settings = AppUsageSettings(InMemoryKeyValueStore())
        settings.appUsageEnabled = true
        assertTrue(settings.appUsageEnabled)
    }

    @Test
    fun `reset wipes the setting back to default`() {
        val settings = AppUsageSettings(InMemoryKeyValueStore())
        settings.appUsageEnabled = true
        settings.reset()
        assertFalse(settings.appUsageEnabled)
    }

    @Test
    fun `an agreement to enable is remembered until reset`() {
        val store = InMemoryKeyValueStore()
        AppUsageSettings(store).explicitEnablePending = true
        val settings = AppUsageSettings(store)
        assertTrue(settings.explicitEnablePending)
        settings.reset()
        assertFalse(settings.explicitEnablePending)
    }

    @Test
    fun `a fresh AppUsageSettings instance reads whatever the backing store already holds`() {
        val store = InMemoryKeyValueStore(mapOf(AppUsageSettings.Keys.ENABLED to "true"))
        val settings = AppUsageSettings(store)
        assertTrue(settings.appUsageEnabled)
    }
}

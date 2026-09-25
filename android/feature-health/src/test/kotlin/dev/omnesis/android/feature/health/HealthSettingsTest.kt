// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthSettingsTest {

    @Test
    fun defaultsAreOffWithAllCategoriesEnabled() {
        val settings = HealthSettings(InMemoryKeyValueStore())
        assertFalse(settings.healthConnectEnabled)
        assertFalse(settings.hasRequestedPermissions)
        assertEquals(HealthCategory.entries.toSet(), settings.enabledCategories)
        assertTrue(HealthCategory.entries.all { settings.isCategoryEnabled(it) })
    }

    @Test
    fun flagsRoundTrip() {
        val store = InMemoryKeyValueStore()
        val settings = HealthSettings(store)
        settings.healthConnectEnabled = true
        settings.hasRequestedPermissions = true
        // A fresh instance over the same store sees the persisted values.
        val reloaded = HealthSettings(store)
        assertTrue(reloaded.healthConnectEnabled)
        assertTrue(reloaded.hasRequestedPermissions)
    }

    @Test
    fun categoryToggleRoundTrips() {
        val store = InMemoryKeyValueStore()
        val settings = HealthSettings(store)
        settings.setCategory(HealthCategory.BODY, false)
        settings.setCategory(HealthCategory.SLEEP, false)

        val reloaded = HealthSettings(store)
        assertFalse(reloaded.isCategoryEnabled(HealthCategory.BODY))
        assertFalse(reloaded.isCategoryEnabled(HealthCategory.SLEEP))
        assertTrue(reloaded.isCategoryEnabled(HealthCategory.VITALS))

        reloaded.setCategory(HealthCategory.BODY, true)
        assertTrue(reloaded.isCategoryEnabled(HealthCategory.BODY))
    }

    @Test
    fun resetRestoresDefaults() {
        val store = InMemoryKeyValueStore()
        val settings = HealthSettings(store)
        settings.healthConnectEnabled = true
        settings.hasRequestedPermissions = true
        settings.setCategory(HealthCategory.NUTRITION, false)

        settings.reset()
        assertFalse(settings.healthConnectEnabled)
        assertFalse(settings.hasRequestedPermissions)
        assertEquals(HealthCategory.entries.toSet(), settings.enabledCategories)
    }

    @Test
    fun unknownStoredCategoryNamesAreTolerated() {
        val store = InMemoryKeyValueStore(
            mapOf(HealthSettings.Keys.ENABLED_CATEGORIES to "hc_body,hc_from_the_future, hc_vitals"),
        )
        val settings = HealthSettings(store)
        assertEquals(setOf(HealthCategory.BODY, HealthCategory.VITALS), settings.enabledCategories)
    }

    @Test
    fun unknownStoredFlagValuesReadAsFalse() {
        val store = InMemoryKeyValueStore(mapOf(HealthSettings.Keys.ENABLED to "banana"))
        assertFalse(HealthSettings(store).healthConnectEnabled)
    }
}

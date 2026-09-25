// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.permission.HealthPermission
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalMindfulnessSessionApi::class)
class TypeCatalogTest {

    private val tableNames = HealthSchemas.ALL_SCHEMAS.map { it.tableName }.toSet()

    @Test
    fun catalogIsNonEmpty() {
        assertTrue(HealthTypeCatalog.entries.isNotEmpty())
    }

    @Test
    fun namesAreUnique() {
        val names = HealthTypeCatalog.entries.map { it.name }
        assertEquals(names.size, names.toSet().size)
    }

    @Test
    fun recordTypesAreUnique() {
        val types = HealthTypeCatalog.entries.map { it.recordType }
        assertEquals(types.size, types.toSet().size)
    }

    @Test
    fun slugsAreUniquePerTable() {
        for ((table, entries) in HealthTypeCatalog.entries.groupBy { it.tableName }) {
            val slugs = entries.mapNotNull { it.metricSlug }
            assertEquals("duplicate slug in $table", slugs.size, slugs.toSet().size)
        }
    }

    @Test
    fun everyEntryTargetsAKnownTable() {
        for (entry in HealthTypeCatalog.entries) {
            assertTrue("${entry.name} targets unknown table ${entry.tableName}", entry.tableName in tableNames)
        }
    }

    @Test
    fun bodyComesFirstInTheRotation() {
        assertEquals("hc_body", HealthTypeCatalog.entries.first().tableName)
    }

    @Test
    fun deleteKeyColumnMappingCoversAllSevenTables() {
        assertEquals("record_id", HealthTypeCatalog.deleteKeyColumnFor("hc_body"))
        assertEquals("record_id", HealthTypeCatalog.deleteKeyColumnFor("hc_activity"))
        assertEquals("record_id", HealthTypeCatalog.deleteKeyColumnFor("hc_vitals"))
        assertEquals("record_id", HealthTypeCatalog.deleteKeyColumnFor("hc_nutrition"))
        assertEquals("session_id", HealthTypeCatalog.deleteKeyColumnFor("hc_sleep"))
        assertNull(HealthTypeCatalog.deleteKeyColumnFor("hc_mindfulness"))
        assertNull(HealthTypeCatalog.deleteKeyColumnFor("hc_exercise"))
    }

    @Test
    fun readPermissionsCoverEveryEntry() {
        for (entry in HealthTypeCatalog.entries) {
            val permission = HealthTypeCatalog.readPermissionFor(entry)
            assertTrue(
                "${entry.name} permission missing from perTypeReadPermissions",
                permission in HealthTypeCatalog.perTypeReadPermissions,
            )
            assertTrue(
                "${entry.name} permission has unexpected shape: $permission",
                permission.startsWith("android.permission.health.READ_"),
            )
        }
    }

    @Test
    fun allPermissionsToRequestAddBackgroundAndHistoryReads() {
        val all = HealthTypeCatalog.allPermissionsToRequest
        assertTrue(HealthTypeCatalog.perTypeReadPermissions.all { it in all })
        assertTrue(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in all)
        assertTrue(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in all)
        assertEquals(HealthTypeCatalog.perTypeReadPermissions.size + 2, all.size)
    }

    @Test
    fun permissionsToRequestAreLimitedToExplicitlySelectedCategories() {
        val selected = setOf(HealthCategory.SLEEP)
        val requested = HealthTypeCatalog.permissionsToRequest(selected)
        val sleepPermissions = HealthTypeCatalog.entries
            .filter { it.tableName == HealthCategory.SLEEP.tableName }
            .map(HealthTypeCatalog::readPermissionFor)
            .toSet()

        assertTrue(sleepPermissions.isNotEmpty())
        assertTrue(sleepPermissions.all { it in requested })
        assertTrue(
            HealthTypeCatalog.entries
                .filter { it.tableName != HealthCategory.SLEEP.tableName }
                .map(HealthTypeCatalog::readPermissionFor)
                .none { it in requested },
        )
        assertTrue(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in requested)
        assertTrue(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in requested)
        assertEquals(sleepPermissions.size + 2, requested.size)
    }

    @Test
    fun permissionsToRequestReturnsNothingWhenNoCategoryIsSelected() {
        assertTrue(HealthTypeCatalog.permissionsToRequest(emptySet()).isEmpty())
    }

    @Test
    fun permissionsToRequestOmitsCapabilitiesMissingFromTheInstalledProvider() {
        val unavailable = setOf(
            HealthConnectFeatures.FEATURE_SKIN_TEMPERATURE,
            HealthConnectFeatures.FEATURE_PLANNED_EXERCISE,
            HealthConnectFeatures.FEATURE_MINDFULNESS_SESSION,
            HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND,
            HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY,
        )
        val requested = HealthTypeCatalog.permissionsToRequest(HealthCategory.entries.toSet()) {
            it !in unavailable
        }

        for (entry in HealthTypeCatalog.entries.filter { it.requiredFeature in unavailable }) {
            assertTrue(HealthTypeCatalog.readPermissionFor(entry) !in requested)
        }
        assertTrue(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND !in requested)
        assertTrue(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY !in requested)
    }

    @Test
    fun byRecordTypeIndexesEveryEntry() {
        for (entry in HealthTypeCatalog.entries) {
            assertEquals(entry, HealthTypeCatalog.byRecordType[entry.recordType])
        }
    }

    @Test
    fun everyTableHasACategoryAndBack() {
        for (table in tableNames) {
            assertEquals(table, HealthCategory.fromTableName(table)?.tableName)
        }
        assertNull(HealthCategory.fromTableName("hc_bogus"))
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotosAccessTest {
    @Test fun api34_distinguishes_full_selected_and_denied() {
        assertEquals(PhotosAccess.FULL, photosAccess(34, fullGranted = true, selectedGranted = true))
        assertEquals(PhotosAccess.LIMITED, photosAccess(34, fullGranted = false, selectedGranted = true))
        assertEquals(PhotosAccess.DENIED, photosAccess(34, fullGranted = false, selectedGranted = false))
    }

    @Test fun selected_grant_has_no_meaning_before_api34() {
        assertEquals(PhotosAccess.DENIED, photosAccess(33, fullGranted = false, selectedGranted = true))
    }

    @Test fun permission_request_includes_optional_media_location_only_where_supported() {
        assertEquals(
            listOf(android.Manifest.permission.READ_EXTERNAL_STORAGE),
            photosPermissionsToRequest(28).toList(),
        )
        assertTrue(photosPermissionsToRequest(29).contains(android.Manifest.permission.ACCESS_MEDIA_LOCATION))
        assertTrue(photosPermissionsToRequest(33).contains(android.Manifest.permission.ACCESS_MEDIA_LOCATION))
        assertTrue(photosPermissionsToRequest(34).contains(android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED))
        assertTrue(photosPermissionsToRequest(34).contains(android.Manifest.permission.ACCESS_MEDIA_LOCATION))
    }

    @Test fun optional_location_denial_does_not_block_primary_access_enablement() {
        assertTrue(
            photosRequestGrantsPrimaryAccess(
                34,
                mapOf(
                    android.Manifest.permission.READ_MEDIA_IMAGES to false,
                    android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED to true,
                    android.Manifest.permission.ACCESS_MEDIA_LOCATION to false,
                ),
            ),
        )
        assertFalse(
            photosRequestGrantsPrimaryAccess(
                33,
                mapOf(
                    android.Manifest.permission.READ_MEDIA_IMAGES to false,
                    android.Manifest.permission.ACCESS_MEDIA_LOCATION to true,
                ),
            ),
        )
    }

    @Test fun full_limited_denied_and_recovered_health_are_truthful() {
        val full = photosPermissionSnapshot(1L, PhotosAccess.FULL, true, true)
        assertEquals(2, full.capabilities.size)
        assertTrue(full.capabilities.all { it.state == dev.omnesis.android.transport.PermissionCapabilityState.HEALTHY })

        val limited = photosPermissionSnapshot(2L, PhotosAccess.LIMITED, true, false)
        assertEquals(dev.omnesis.android.transport.PermissionCapabilityState.PERMISSION_DEGRADED, limited.capabilities[0].state)
        val optional = limited.capabilities.single { it.id == "photo-location" }
        assertEquals(dev.omnesis.android.transport.PermissionRequirement.OPTIONAL, optional.requirement)
        assertEquals(dev.omnesis.android.transport.PermissionRepairAction.OPEN_SOURCE_SETTINGS, optional.repairAction)

        val fullWithoutLocation = photosPermissionSnapshot(3L, PhotosAccess.FULL, true, false)
        assertEquals(
            dev.omnesis.android.transport.PermissionCapabilityState.HEALTHY,
            fullWithoutLocation.capabilities.single { it.id == "photo-library" }.state,
        )
        assertEquals(
            dev.omnesis.android.transport.PermissionCapabilityState.PERMISSION_DEGRADED,
            fullWithoutLocation.capabilities.single { it.id == "photo-location" }.state,
        )

        val denied = photosPermissionSnapshot(4L, PhotosAccess.DENIED, true, false)
        assertEquals(listOf("photo-library"), denied.capabilities.map { it.id })

        val recovered = photosPermissionSnapshot(5L, PhotosAccess.FULL, true, true)
        assertEquals(5L, recovered.checkedAt)
        assertTrue(recovered.capabilities.all { it.state == dev.omnesis.android.transport.PermissionCapabilityState.HEALTHY })
        assertTrue(recovered.capabilities.all { it.repairAction == dev.omnesis.android.transport.PermissionRepairAction.NONE })
        assertTrue(recovered.capabilities.all { it.remediation == null })

        val unsupported = photosPermissionSnapshot(6L, PhotosAccess.FULL, false, false)
        assertFalse(unsupported.capabilities.any { it.id == "photo-location" })
        assertNull(unsupported.capabilities.single().remediation)
    }
}

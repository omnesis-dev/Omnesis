// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotosSettingsTest {

    @Test
    fun `photosEnabled defaults to false and round-trips`() {
        val settings = PhotosSettings(InMemoryKeyValueStore())
        assertFalse(settings.photosEnabled)

        settings.photosEnabled = true
        assertEquals(true, settings.photosEnabled)
    }

    @Test
    fun `permanent denial survives relaunch`() {
        val store = InMemoryKeyValueStore()
        PhotosSettings(store).recordPermissionResult(primaryGranted = false, permanentlyDenied = true)

        assertTrue(PhotosSettings(store).permissionPermanentlyDenied)
    }

    @Test
    fun `grant clears denial so a later OS auto-reset remains requestable`() {
        val store = InMemoryKeyValueStore()
        PhotosSettings(store).recordPermissionResult(primaryGranted = false, permanentlyDenied = true)
        PhotosSettings(store).recordPermissionResult(primaryGranted = true, permanentlyDenied = false)
        PhotosSettings(store).observePermission(primaryGranted = false)

        assertFalse(PhotosSettings(store).permissionPermanentlyDenied)
    }

    @Test fun `requestable denial is never persisted as hard denial`() {
        val settings = PhotosSettings(InMemoryKeyValueStore())
        settings.recordPermissionResult(primaryGranted = false, permanentlyDenied = false)
        assertFalse(settings.permissionPermanentlyDenied)
    }

    @Test
    fun `lastReconcileAt defaults to null and round-trips`() {
        val settings = PhotosSettings(InMemoryKeyValueStore())
        assertNull(settings.lastReconcileAt)

        val now = Instant.parse("2026-07-05T12:00:00Z")
        settings.lastReconcileAt = now
        assertEquals(now, settings.lastReconcileAt)
    }

    @Test
    fun `reset clears every setting`() {
        val settings = PhotosSettings(InMemoryKeyValueStore())
        settings.photosEnabled = true
        settings.permissionPermanentlyDenied = true
        settings.lastReconcileAt = Instant.parse("2026-07-05T12:00:00Z")

        settings.reset()

        assertFalse(settings.photosEnabled)
        assertFalse(settings.permissionPermanentlyDenied)
        assertNull(settings.lastReconcileAt)
    }

    @Test fun `restricted to full increments generation once and clears reconcile throttle`() {
        val settings = PhotosSettings(InMemoryKeyValueStore())
        settings.observeAccess(PhotosAccess.LIMITED)
        settings.lastReconcileAt = Instant.parse("2026-07-05T12:00:00Z")
        assertEquals(1L, settings.observeAccess(PhotosAccess.FULL))
        assertNull(settings.lastReconcileAt)
        assertEquals(1L, settings.observeAccess(PhotosAccess.FULL))
    }

    @Test fun `first full observation advances generation so legacy cursors are re-baselined`() {
        val settings = PhotosSettings(InMemoryKeyValueStore())
        assertEquals(1L, settings.observeAccess(PhotosAccess.FULL))
        assertEquals(1L, settings.observeAccess(PhotosAccess.FULL))
    }
}

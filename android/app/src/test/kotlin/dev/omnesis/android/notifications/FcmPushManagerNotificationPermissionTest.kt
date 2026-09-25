// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 34])
class FcmPushManagerNotificationPermissionTest {
    @Test
    fun `denial revocation and recovery control health and claimed rendering`() {
        val application = ApplicationProvider.getApplicationContext<Application>()
        val applicationShadow = shadowOf(application)
        val manager = FcmPushManager(application)
        val delivery = ClaimedNotificationDelivery(
            id = "00000000-0000-4000-8000-000000000101",
            kind = "brief",
            targetId = "brief_permission_test",
            title = "Fictional permission update",
            body = "Invented notification body.",
            collapseId = "brief:permission-test",
        )

        applicationShadow.denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertEquals("not-determined", manager.deliveryHealth(configurationAvailable = true))
        manager.markNotificationPermissionPrompted()
        assertEquals("permission-denied", manager.deliveryHealth(configurationAvailable = true))
        assertEquals(
            NotificationRenderOutcome.DeferredNotificationsDisabled,
            manager.showClaimedOutcome(delivery),
        )

        applicationShadow.grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertEquals("healthy", manager.deliveryHealth(configurationAvailable = true))
        assertEquals(NotificationRenderOutcome.Rendered, manager.showClaimedOutcome(delivery))
        assertEquals(
            1,
            shadowOf(application.getSystemService(NotificationManager::class.java)).allNotifications.size,
        )

        applicationShadow.denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertEquals("permission-denied", manager.deliveryHealth(configurationAvailable = true))
        assertEquals(
            NotificationRenderOutcome.DeferredNotificationsDisabled,
            manager.showClaimedOutcome(delivery.copy(id = "00000000-0000-4000-8000-000000000102")),
        )
    }
}

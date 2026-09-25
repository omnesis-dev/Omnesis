// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import android.app.NotificationManager
import android.app.NotificationChannel
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.MainActivity
import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import dev.omnesis.android.transport.GatewayException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32])
class FcmPushManagerTest {
    @Test fun failed_claim_posts_only_generic_diagnostic_and_a_claim_clears_it() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = FcmPushManager(context)
        manager.showClaimFailureDiagnostic(GatewayException.Network(java.net.ConnectException("refused")))
        val system = shadowOf(context.getSystemService(NotificationManager::class.java))
        val diagnostic = system.allNotifications.single()
        assertEquals("Couldn't check for a private update", diagnostic.extras.getString("android.title"))
        assertTrue(diagnostic.extras.getString("android.text")!!.contains("Tailscale hostname"))
        manager.showClaimFailureDiagnostic(GatewayException.Network(java.net.ConnectException("refused again")))
        assertEquals(1, system.allNotifications.size)
        assertTrue(manager.showClaimed(delivery("brief", "brief_example", 42)))
        assertEquals(1, system.allNotifications.size)
        assertEquals("Fictional notification 42", system.allNotifications.single().extras.getString("android.title"))
        manager.showClaimFailureDiagnostic(GatewayException.Network(java.net.ConnectException("new outage")))
        assertEquals(2, system.allNotifications.size)
        assertTrue(system.allNotifications.any { it.extras.getString("android.title") == "Couldn't check for a private update" })
    }

    @Test
    fun all_claimed_kinds_are_rendered_as_local_notifications() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = FcmPushManager(context)
        val deliveries = listOf(
            delivery("agent-answer", "conversation_answer", 1),
            delivery("conversation", "conversation_update", 2),
            delivery("brief", "brief_example", 3),
            delivery("watch", "watch_example", 4),
            delivery("needs-auth", "fictional_source", 5),
            delivery("privacy-approval", "approval_example", 6),
            delivery("source-permission", "photos:local", 7),
            delivery("access-authorization", "access", 8),
        )

        deliveries.forEach { assertTrue(manager.showClaimed(it)) }

        val systemManager = context.getSystemService(NotificationManager::class.java)
        val notifications = shadowOf(systemManager).allNotifications
        assertEquals(8, notifications.size)
        assertEquals(
            deliveries.map { it.title }.toSet(),
            notifications.map { it.extras.getString("android.title") }.toSet(),
        )
    }

    @Test fun access_authorization_tap_carries_no_request_or_code() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = FcmPushManager(context)
        assertTrue(manager.showClaimed(delivery("access-authorization", "access", 15)))
        val notification = shadowOf(context.getSystemService(NotificationManager::class.java))
            .allNotifications.single()
        val intent = shadowOf(notification.contentIntent).savedIntent
        assertEquals(MainActivity.ACTION_ACCESS_AUTHORIZATION, intent.action)
        assertEquals(1, intent.extras?.keySet()?.size)
        assertTrue(intent.hasExtra(MainActivity.EXTRA_ACCESS_AUTHORIZATION_LAUNCH_STAMP))
    }

    @Test
    fun watch_banner_tap_carries_the_exact_firing_route() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = FcmPushManager(context)
        val delivery = delivery("watch", "watch_fallback", 7).copy(
            route = Json.parseToJsonElement(
                """{"kind":"watch","watchId":"watch_example","firingKey":"watch_example:17"}""",
            ).jsonObject,
        )

        assertTrue(manager.showClaimed(delivery))

        val systemManager = context.getSystemService(NotificationManager::class.java)
        val notification = shadowOf(systemManager).allNotifications.single()
        val intent = shadowOf(notification.contentIntent).savedIntent
        assertEquals(MainActivity.ACTION_WATCH_FIRING, intent.action)
        assertEquals("watch_example", intent.getStringExtra(MainActivity.EXTRA_WATCH_ID))
        assertEquals(
            "watch_example:17",
            intent.getStringExtra(MainActivity.EXTRA_WATCH_FIRING_KEY),
        )
    }

    @Test
    fun lease_retry_replaces_the_existing_local_notification() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = FcmPushManager(context)
        val firstLease = delivery("brief", "brief_retry", 8)
        val retryLease = firstLease.copy(
            id = "00000000-0000-4000-8000-000000000099",
            title = "Fictional retry replacement",
        )

        assertTrue(manager.showClaimed(firstLease))
        assertTrue(manager.showClaimed(retryLease))

        val systemManager = context.getSystemService(NotificationManager::class.java)
        val notifications = shadowOf(systemManager).allNotifications
        assertEquals(1, notifications.size)
        assertEquals(
            "Fictional retry replacement",
            notifications.single().extras.getString("android.title"),
        )
    }

    @Test fun malformed_known_and_unknown_future_kinds_are_distinct() {
        val manager = FcmPushManager(ApplicationProvider.getApplicationContext())
        assertEquals(
            NotificationRenderOutcome.RejectedInvalid,
            manager.showClaimedOutcome(delivery("brief", "", 8)),
        )
        assertEquals(
            NotificationRenderOutcome.DeferredUnknownKind,
            manager.showClaimedOutcome(delivery("future-kind", "future_target", 9)),
        )
    }

    @Test fun notifications_disabled_is_deferred_not_confirmable() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)
        assertEquals(
            NotificationRenderOutcome.DeferredNotificationsDisabled,
            FcmPushManager(context).showClaimedOutcome(delivery("brief", "brief_example", 10)),
        )
    }

    @Test fun destination_channel_disabled_is_deferred_not_confirmable() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val system = context.getSystemService(NotificationManager::class.java)
        system.createNotificationChannel(
            NotificationChannel(FcmPushManager.AGENT_CHANNEL_ID, "Agent answers", NotificationManager.IMPORTANCE_NONE),
        )
        assertEquals(
            NotificationRenderOutcome.DeferredNotificationsDisabled,
            FcmPushManager(context).showClaimedOutcome(delivery("agent-answer", "conversation_answer", 11)),
        )
    }

    @Test fun source_permission_for_this_device_routes_to_local_repair() {
        val action = notificationAction(
            delivery("source-permission", "photos:local", 12).copy(affectedDeviceId = "device-local"),
            localDeviceId = "device-local",
        )
        assertEquals(NotificationTarget.SourcePermission("photos:local"), action?.target)
    }

    @Test fun source_permission_for_another_device_never_routes_to_local_settings() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val delivery = delivery("source-permission", "photos:local", 13).copy(
            affectedDeviceId = "device-remote",
            sourceName = "Fictional Photos",
            affectedDeviceName = "Fictional Android",
        )
        val action = notificationAction(delivery, localDeviceId = "device-local")
        assertEquals(
            NotificationTarget.RemoteSourcePermission(
                "photos:local",
                "device-remote",
                "Fictional Photos",
                "Fictional Android",
            ),
            action?.target,
        )

        assertTrue(FcmPushManager(context).showClaimed(delivery, localDeviceId = "device-local"))
        val notification = shadowOf(context.getSystemService(NotificationManager::class.java)).allNotifications.single()
        assertEquals("Permission needed on another device", notification.extras.getString("android.title"))
        val intent = shadowOf(notification.contentIntent).savedIntent
        assertEquals(MainActivity.ACTION_REMOTE_SOURCE_PERMISSION, intent.action)
        assertEquals("photos:local", intent.getStringExtra(MainActivity.EXTRA_SOURCE_ID))
        assertEquals("device-remote", intent.getStringExtra(MainActivity.EXTRA_AFFECTED_DEVICE_ID))
        assertEquals("Fictional Photos", intent.getStringExtra(MainActivity.EXTRA_SOURCE_NAME))
        assertEquals("Fictional Android", intent.getStringExtra(MainActivity.EXTRA_AFFECTED_DEVICE_NAME))
    }

    @Test fun malformed_affected_device_never_falls_back_to_local_repair() {
        val delivery = delivery("source-permission", "photos:local", 14).copy(affectedDeviceId = "bad\ndevice")
        assertEquals(null, notificationAction(delivery, localDeviceId = "device-local"))
    }

    private fun delivery(kind: String, value: String, suffix: Int) =
        ClaimedNotificationDelivery(
            id = "00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}",
            kind = kind,
            targetId = value,
            title = "Fictional notification $suffix",
            body = "Invented notification body $suffix.",
            collapseId = "$kind:$value",
        )
}

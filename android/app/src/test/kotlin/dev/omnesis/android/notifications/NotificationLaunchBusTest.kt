// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationLaunchBusTest {
    @Test fun access_authorization_carries_no_request_data_and_is_consumed() {
        val bus = NotificationLaunchBus()
        bus.postAccessAuthorization()
        assertEquals(true, bus.accessAuthorization.value != null)
        assertNull(bus.accessAuthorization.value?.code)
        bus.consumeAccessAuthorization()
        assertNull(bus.accessAuthorization.value)
    }

    @Test fun access_authorization_preserves_only_a_valid_user_code() {
        val bus = NotificationLaunchBus()
        val pairing = AccessAuthorizationPairingIdentity(
            "https://gateway.example.com",
            "device-example",
            "generation-example",
        )
        bus.postAccessAuthorization("ABCD-EFGH", pairing)
        assertEquals("ABCD-EFGH", bus.accessAuthorization.value?.code)
        assertEquals(pairing, bus.accessAuthorization.value?.pairingIdentity)
        bus.consumeAccessAuthorization()

        bus.postAccessAuthorization("../../admin", pairing)
        assertNull(bus.accessAuthorization.value)
        bus.postAccessAuthorization("abcd-efgh", pairing)
        assertNull(bus.accessAuthorization.value)
        bus.postAccessAuthorization("ABCD-EFGH")
        assertNull(bus.accessAuthorization.value)
    }

    @Test
    fun acceptsOpaqueApprovalIdsAndConsumesThem() {
        val bus = NotificationLaunchBus()
        bus.postPrivacyApproval("approval_example-123")
        assertEquals("approval_example-123", bus.privacyApproval.value?.approvalId)
        bus.consumePrivacyApproval()
        assertNull(bus.privacyApproval.value)
    }

    @Test
    fun rejectsIdsThatCouldChangeTheGatewayPath() {
        val bus = NotificationLaunchBus()
        bus.postPrivacyApproval("../admin/config")
        assertNull(bus.privacyApproval.value)
        bus.postPrivacyApproval("approval example")
        assertNull(bus.privacyApproval.value)
    }

    @Test
    fun preserves_and_consumes_an_exact_watch_firing() {
        val bus = NotificationLaunchBus()
        bus.postWatchFiring("watch_example", "watch_example:17")
        assertEquals("watch_example", bus.watchFiring.value?.watchId)
        assertEquals("watch_example:17", bus.watchFiring.value?.firingKey)
        bus.consumeWatchFiring()
        assertNull(bus.watchFiring.value)
    }

    @Test fun source_permission_accepts_bounded_source_identity_and_consumes_it() {
        val bus = NotificationLaunchBus()
        bus.postSourcePermission("photos:local")
        assertEquals("photos:local", bus.sourcePermission.value?.sourceId)
        bus.consumeSourcePermission()
        assertNull(bus.sourcePermission.value)
        bus.postSourcePermission("bad\nsource")
        assertNull(bus.sourcePermission.value)
    }

    @Test fun remote_source_permission_routes_by_device_and_consumes_it() {
        val bus = NotificationLaunchBus()
        bus.postRemoteSourcePermission(
            "photos:local",
            "device-remote",
            "Fictional Photos",
            "Fictional Android",
        )
        assertEquals("photos:local", bus.remoteSourcePermission.value?.sourceId)
        assertEquals("device-remote", bus.remoteSourcePermission.value?.deviceId)
        assertEquals("Fictional Photos", bus.remoteSourcePermission.value?.sourceName)
        assertEquals("Fictional Android", bus.remoteSourcePermission.value?.deviceName)
        assertNull(bus.sourcePermission.value)
        bus.consumeRemoteSourcePermission()
        assertNull(bus.remoteSourcePermission.value)
        bus.postRemoteSourcePermission("photos:local", "bad\ndevice")
        assertNull(bus.remoteSourcePermission.value)
    }
}

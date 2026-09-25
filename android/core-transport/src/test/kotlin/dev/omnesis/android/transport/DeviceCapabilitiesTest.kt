// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCapabilitiesTest {
    @Test
    fun sourceContractsProduceClosedWireValuesAndLeaseCapability() {
        val capabilities = DeviceCapabilities.android(
            listOf(
                HostedSourceContract("apple-health", SourceMultiDeviceMode.REPLICATED),
                HostedSourceContract("activity-segments", SourceMultiDeviceMode.PARTITIONED),
            ),
        )

        assertEquals("replicated", capabilities.multiDeviceModes["apple-health"])
        assertEquals("partitioned", capabilities.multiDeviceModes["activity-segments"])
        assertTrue(capabilities.syncLease)
    }

    /**
     * The gateway's version ledger reads `version` out of the hello. The
     * field is deliberately optional on the wire, so a build that stopped
     * sending it would still connect and simply go silent about which
     * release it is — nothing but this test would notice.
     */
    @Test
    fun announcesTheAppVersionWhenTheCompositionRootSuppliesOne() {
        val announced = DeviceCapabilities.android(
            listOf(HostedSourceContract("health-connect", SourceMultiDeviceMode.PARTITIONED)),
            version = "9.8.7",
        )
        assertEquals("9.8.7", announced.version)

        // A caller that supplies none reports nothing rather than a made-up
        // version: an absent reading is a supported state on the gateway.
        assertNull(DeviceCapabilities.android(emptyList()).version)
    }

    @Test
    fun announcesThePushAppIdentityWhenTheCompositionRootSuppliesOne() {
        val announced = DeviceCapabilities.android(
            emptyList(),
            pushAppId = "dev.omnesis.android",
        )

        assertEquals("dev.omnesis.android", announced.pushAppId)
        assertNull(DeviceCapabilities.android(emptyList()).pushAppId)
    }

    @Test
    fun rejectsBlankAndDuplicateSourceContracts() {
        assertThrows(IllegalArgumentException::class.java) {
            DeviceCapabilities.android(listOf(HostedSourceContract("")))
        }
        assertThrows(IllegalArgumentException::class.java) {
            DeviceCapabilities.android(
                listOf(HostedSourceContract("photos"), HostedSourceContract("photos")),
            )
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import dev.omnesis.android.ui.settings.settingsGatewayInfo
import org.junit.Assert.*
import org.junit.Test

class GoogleSettingsRouteProjectionTest {
    @Test fun routing_status_follows_negotiated_authority_even_without_initial_lan_facts() {
        val base = Pairing("https://gateway.example.test", "device-test-token", deviceId = "device-test",
            gatewayName = "Test gateway", tlsMode = PairingTlsMode.PINNED_KEY_STRICT, spkiFingerprint = "a".repeat(64), scopes = listOf("admin"))
        assertTrue(settingsGatewayInfo(base).usesDirectRouting)
        assertFalse(settingsGatewayInfo(base.copy(url = "https://127.0.0.1")).usesDirectRouting)
        assertFalse(settingsGatewayInfo(base.copy(url = "https://localhost")).usesDirectRouting)
        assertFalse(settingsGatewayInfo(base.copy(tlsMode = PairingTlsMode.PINNED_LEAF_STRICT)).usesDirectRouting)
        val facts = listOf(DirectGatewayCandidate("10.0.0.2", 9443))
        assertTrue(settingsGatewayInfo(base.copy(tlsMode = PairingTlsMode.PINNED_LEAF_STRICT, directCandidates = facts)).usesDirectRouting)
        for (mode in listOf(PairingTlsMode.LEGACY, PairingTlsMode.SYSTEM, PairingTlsMode.PINNED_LEAF)) {
            assertFalse(settingsGatewayInfo(base.copy(tlsMode = mode, directCandidates = facts)).usesDirectRouting)
        }
        val projected = settingsGatewayInfo(base)
        assertEquals(base.url, projected.url)
        assertEquals(base.scopes, projected.scopes)
        assertEquals(base.tlsMode, projected.tlsMode)
        assertEquals("Test gateway", projected.name)
        assertEquals("Gateway", settingsGatewayInfo(base.copy(gatewayName = "")).name)
        val unnamed = settingsGatewayInfo(base.copy(gatewayName = null, deviceId = null))
        assertEquals("Gateway", unnamed.name)
        assertEquals("—", unnamed.deviceId)
    }
}

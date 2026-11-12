// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test

class DirectCandidatePersistenceTest {
    private val bundle = PairingCredentialBundle(
        url = "https://gateway.example.test", token = "device-token", pairingGeneration = "generation-one",
        accountId = "local", deviceId = "device-one", name = "Gateway", scopes = listOf("read"),
        tlsMode = PairingTlsMode.PINNED_KEY_STRICT.persistedValue, spkiFingerprint = "ab".repeat(32),
    )
    private val first = listOf(DirectGatewayCandidate("10.0.0.1", 7600))
    private val second = listOf(DirectGatewayCandidate("10.0.0.2", 8443))
    private fun store(value: PairingCredentialBundle = bundle) = InMemoryStore().apply {
        set("gateway.credential.v1", OmnesisJson.encodeToString(value))
    }

    @Test fun `fresh hints replace only routing facts and preserve the entire authority`() {
        val backing = store()
        val store = object : SecureStore by backing {
            var writes = 0
            override fun set(key: String, value: String) { writes++; backing.set(key, value) }
        }
        val service = PairingService(store, cloudRelay = true)
        val expected = service.current()!!
        assertTrue(service.updateDirectCandidates(expected, emptyList()))
        assertEquals(0, store.writes)
        assertTrue(service.updateDirectCandidates(expected, first))
        assertEquals(1, store.writes)
        assertTrue(service.updateDirectCandidates(expected, first))
        assertEquals(1, store.writes)
        assertEquals(expected.copy(directCandidates = first), service.current())
        // Same authority remains current even while successive DHCP facts replace older hints.
        assertTrue(service.updateDirectCandidates(expected, second))
        assertEquals(expected.copy(directCandidates = second), service.current())
        assertEquals(expected.copy(directCandidates = second), PairingService(store, cloudRelay = true).current())
        assertEquals(bundle.copy(directCandidates = second), OmnesisJson.decodeFromString<PairingCredentialBundle>(store.get("gateway.credential.v1")!!))
        assertTrue(service.updateDirectCandidates(expected, emptyList()))
        assertEquals(expected, service.current())
        try { service.updateDirectCandidates(expected, listOf(DirectGatewayCandidate("127.0.0.1", 443))); fail("Unsafe hint persisted") }
        catch (_: IllegalArgumentException) { }
        assertEquals(expected, service.current())
    }

    @Test fun `every stale authority field and unpair reject without restoring credentials`() {
        val store = store()
        val service = PairingService(store, cloudRelay = true)
        val expected = service.current()!!
        val stale = listOf(
            expected.copy(url = "https://other.example.test"), expected.copy(token = "other-token"),
            expected.copy(pairingGeneration = "generation-two"), expected.copy(accountId = "other-account"),
            expected.copy(deviceId = "other-device"), expected.copy(scopes = listOf("admin")),
            expected.copy(gatewayName = "Other gateway"), expected.copy(spkiFingerprint = "cd".repeat(32)),
            expected.copy(fingerprint = "ef".repeat(32)), expected.copy(tlsMode = PairingTlsMode.SYSTEM),
        )
        for (candidate in stale) {
            assertFalse(service.updateDirectCandidates(candidate, first))
            assertEquals(expected, service.current())
        }
        service.unpair()
        assertFalse(service.updateDirectCandidates(expected, first))
        assertNull(service.current())
    }

    @Test fun `ordinary direct credentials and corrupt state never acquire cloud routing facts`() {
        val directStore = store(bundle.copy(tlsMode = PairingTlsMode.SYSTEM.persistedValue, spkiFingerprint = null))
        val direct = PairingService(directStore, cloudRelay = true)
        assertFalse(direct.updateDirectCandidates(direct.current()!!, first))
        val split = InMemoryStore().apply {
            set("gateway.url", bundle.url); set("gateway.token", bundle.token)
            set("gateway.accountId", bundle.accountId); set("gateway.name", bundle.name)
            set("gateway.deviceId", bundle.deviceId)
            set("gateway.tlsMode", PairingTlsMode.PINNED_LEAF_STRICT.persistedValue)
            set("gateway.fingerprint", "ab".repeat(32))
        }
        val legacy = PairingService(split, cloudRelay = true)
        assertFalse(legacy.updateDirectCandidates(legacy.current()!!, first))
        val service = PairingService(store(), cloudRelay = true)
        val expected = service.current()!!
        val corrupt = store().apply { set("gateway.credential.v1", "not JSON") }
        assertFalse(PairingService(corrupt, cloudRelay = true).updateDirectCandidates(expected, first))
    }
}

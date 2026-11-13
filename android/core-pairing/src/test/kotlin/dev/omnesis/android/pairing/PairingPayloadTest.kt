// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingPayloadTest {

    @Test
    fun decodes_v4_system_trust() {
        val p = PairingPayload.decode(
            """{"v":4,"gatewayUrl":"https://public-gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"system"}}""",
        )
        assertTrue(p is PairingPayload.V4)
        p as PairingPayload.V4
        assertEquals(PairingPayload.V4Tls.System, p.tls)
    }

    @Test
    fun decodes_v4_pinned_leaf() {
        val fp = "b".repeat(64)
        val p = PairingPayload.decode(
            """{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"pinned-leaf","fingerprint":"$fp"}}""",
        ) as PairingPayload.V4
        assertEquals(PairingPayload.V4Tls.PinnedLeaf(fp), p.tls)
    }

    @Test
    fun strict_trust_modes_are_unknown_unless_cloud_connectivity_is_enabled() {
        val key = """{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"pinned-key-strict","spkiFingerprint":"${"c".repeat(64)}"}}"""
        val leaf = """{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"pinned-leaf-strict","fingerprint":"${"d".repeat(64)}"}}"""
        for (payload in listOf(key, leaf)) {
            val error = assertThrows(PairingPayloadException::class.java) { PairingPayload.decode(payload) }
            assertEquals("invalid TLS trust mode", error.message)
        }
        assertEquals(PairingPayload.V4Tls.PinnedKeyStrict("c".repeat(64)), (PairingPayload.decode(key, cloudRelay = true) as PairingPayload.V4).tls)
        assertEquals(PairingPayload.V4Tls.PinnedLeafStrict("d".repeat(64)), (PairingPayload.decode(leaf, cloudRelay = true) as PairingPayload.V4).tls)
    }

    @Test
    fun rejects_v4_system_trust_over_http() {
        assertThrows(PairingPayloadException::class.java) {
            PairingPayload.decode(
                """{"v":4,"gatewayUrl":"http://public-gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"system"}}""",
            )
        }
    }

    @Test
    fun rejects_v4_system_trust_urls_that_are_not_exact_origins() {
        listOf(
            "https://public-gateway.example.com/base",
            "https://user@public-gateway.example.com",
            "https://public-gateway.example.com?mode=test",
            "https://public-gateway.example.com#fragment",
        ).forEach { url ->
            assertThrows(PairingPayloadException::class.java) {
                PairingPayload.decode(
                    """{"v":4,"gatewayUrl":"$url","pairingCode":"AB-CD","tls":{"mode":"system"}}""",
                )
            }
        }
    }

    @Test
    fun rejects_v4_pinned_leaf_over_http() {
        val fp = "b".repeat(64)
        assertThrows(PairingPayloadException::class.java) {
            PairingPayload.decode(
                """{"v":4,"gatewayUrl":"http://gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"pinned-leaf","fingerprint":"$fp"}}""",
            )
        }
    }

    @Test
    fun decodes_v3() {
        val fp = "a".repeat(64)
        val p = PairingPayload.decode(
            """{"v":3,"gatewayUrl":"https://10.0.2.2:17700","pairingCode":"AB-CD","fingerprint":"$fp"}""",
        )
        assertTrue(p is PairingPayload.V3)
        p as PairingPayload.V3
        assertEquals("https://10.0.2.2:17700", p.gatewayUrl)
        assertEquals("AB-CD", p.pairingCode)
        assertEquals(fp, p.fingerprint)
    }

    @Test
    fun decodes_v2() {
        val p = PairingPayload.decode("""{"v":2,"gatewayUrl":"https://host.local:7600","pairingCode":"Z9"}""")
        assertTrue(p is PairingPayload.V2)
    }

    @Test
    fun rejects_plain_http_for_every_legacy_payload_version() {
        val fp = "a".repeat(64)
        listOf(
            """{"v":3,"gatewayUrl":"http://host.local:7600","pairingCode":"Z9","fingerprint":"$fp"}""",
            """{"v":2,"gatewayUrl":"http://host.local:7600","pairingCode":"Z9"}""",
            """{"v":1,"url":"http://host.local:7600","token":"tok","accountId":"acc","name":"Gateway"}""",
        ).forEach { payload ->
            assertThrows(PairingPayloadException::class.java) { PairingPayload.decode(payload) }
        }
    }

    @Test
    fun decodes_v1() {
        val p = PairingPayload.decode(
            """{"v":1,"url":"https://host.local:7600","token":"tok","accountId":"acc","name":"Gateway"}""",
        )
        assertTrue(p is PairingPayload.V1)
        assertEquals("Gateway", (p as PairingPayload.V1).name)
    }

    @Test
    fun rejects_non_json() {
        assertThrows(PairingPayloadException::class.java) { PairingPayload.decode("not json") }
    }

    @Test
    fun rejects_missing_version() {
        assertThrows(PairingPayloadException::class.java) { PairingPayload.decode("""{"gatewayUrl":"https://x"}""") }
    }

    @Test
    fun rejects_unsupported_version() {
        assertThrows(PairingPayloadException::class.java) {
            PairingPayload.decode("""{"v":9,"gatewayUrl":"https://x","pairingCode":"c"}""")
        }
    }

    @Test
    fun rejects_non_https_scheme() {
        assertThrows(PairingPayloadException::class.java) {
            PairingPayload.decode("""{"v":2,"gatewayUrl":"javascript:alert(1)","pairingCode":"c"}""")
        }
    }

    @Test
    fun rejects_missing_required_field() {
        assertThrows(PairingPayloadException::class.java) {
            PairingPayload.decode("""{"v":2,"gatewayUrl":"https://x"}""")
        }
    }

    @Test
    fun rejects_bad_fingerprint_length() {
        assertThrows(PairingPayloadException::class.java) {
            PairingPayload.decode("""{"v":3,"gatewayUrl":"https://x","pairingCode":"c","fingerprint":"${"a".repeat(63)}"}""")
        }
    }

    @Test
    fun rejects_non_hex_fingerprint() {
        assertThrows(PairingPayloadException::class.java) {
            PairingPayload.decode("""{"v":3,"gatewayUrl":"https://x","pairingCode":"c","fingerprint":"${"z".repeat(64)}"}""")
        }
    }
}

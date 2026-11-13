// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.routing.DirectGatewayRoute
import dev.omnesis.android.transport.tls.LeafCertPinner
import java.security.cert.CertificateException
import okhttp3.OkHttpClient
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** A build without cloud connectivity builds the session's clients as it did before the feature. */
class SessionTransportTest {
    private val pinned = HeldCertificate.Builder().addSubjectAlternativeName("gateway.example.test").build().certificate
    private val other = HeldCertificate.Builder().addSubjectAlternativeName("gateway.example.test").build().certificate
    private val off = SessionTransport(cloudEnabled = false)
    private val on = SessionTransport(cloudEnabled = true)

    private fun pairing(url: String = "https://gateway.example.test:7600", mode: PairingTlsMode = PairingTlsMode.PINNED_LEAF) = Pairing(
        url = url, token = "synthetic-token", pairingGeneration = "generation", deviceId = "device-1", gatewayName = "Fictional gateway",
        fingerprint = LeafCertPinner.sha256Hex(pinned.encoded), tlsMode = mode,
    )

    /** The pinner names the host it was built with when it refuses a certificate. */
    private fun refusal(client: OkHttpClient): String = assertThrows(CertificateException::class.java) {
        client.x509TrustManager!!.checkServerTrusted(arrayOf(other), "RSA")
    }.message.orEmpty()

    @Test fun `off, the socket shares the streaming client and on it has its own`() {
        val pairing = pairing()
        val offStreaming = off.streaming(pairing, null, null)
        assertSame(offStreaming, off.socket(pairing, null, null, offStreaming))
        val onStreaming = on.streaming(pairing, null, null)
        assertNotSame(onStreaming, on.socket(pairing, null, null, onStreaming))
    }

    @Test fun `off, the hello identity is not checked and no route or hint refresh reaches the socket`() {
        val pairing = pairing()
        val strict = pairing.copy(tlsMode = PairingTlsMode.PINNED_KEY_STRICT, fingerprint = null, spkiFingerprint = "ab".repeat(32))
        val route = DirectGatewayRoute.maintained("https://gateway.example.test", emptyList())
        assertNull(off.expectedDeviceId(pairing))
        assertNull(off.socketRoute(route))
        assertFalse(off.refreshesHints(strict))
        assertEquals("device-1", on.expectedDeviceId(pairing))
        assertNull(on.expectedDeviceId(pairing.copy(pairingGeneration = null)))
        assertSame(route, on.socketRoute(route))
        assertTrue(on.refreshesHints(strict))
        assertFalse(on.refreshesHints(pairing))
    }

    @Test fun `off, clients take the gateway host as the URL spells it`() {
        val literal = pairing("https://[fd00::1]:7600")
        for (client in listOf(off.http(literal, null, null), off.streaming(literal, null, null), off.revocation(literal))) {
            assertTrue(refusal(client), "[fd00::1] cannot fall back" in refusal(client))
        }
        for (client in listOf(on.http(literal, null, null), on.streaming(literal, null, null), on.revocation(literal))) {
            assertTrue(refusal(client), "; fd00::1 cannot fall back" in refusal(client))
        }
        // A name java.net.URI does not parse leaves the pinner without a host, as before.
        val unparsed = pairing("https://my_gateway.example.test:7600")
        assertTrue(refusal(off.http(unparsed, null, null)), "this gateway cannot fall back" in refusal(off.http(unparsed, null, null)))
    }

    @Test fun `off, a pending revocation is sent without requiring the pin`() {
        val unpinned = pairing().copy(fingerprint = "not-a-fingerprint")
        assertNotNull(off.revocation(unpinned))
        assertThrows(IllegalArgumentException::class.java) { on.revocation(unpinned) }
    }
}

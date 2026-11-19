// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.tls.LeafCertPinner
import java.security.cert.CertificateException
import okhttp3.OkHttpClient
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionTransportTest {
    private val pinned = HeldCertificate.Builder().addSubjectAlternativeName("gateway.example.test").build().certificate
    private val other = HeldCertificate.Builder().addSubjectAlternativeName("gateway.example.test").build().certificate
    private val transport = SessionTransport()

    private fun pairing(url: String = "https://gateway.example.test:7600", mode: PairingTlsMode = PairingTlsMode.PINNED_LEAF) = Pairing(
        url = url, token = "synthetic-token", pairingGeneration = "generation", deviceId = "device-1", gatewayName = "Fictional gateway",
        fingerprint = LeafCertPinner.sha256Hex(pinned.encoded), tlsMode = mode,
    )

    /** The pinner names the host it was built with when it refuses a certificate. */
    private fun refusal(client: OkHttpClient): String = assertThrows(CertificateException::class.java) {
        client.x509TrustManager!!.checkServerTrusted(arrayOf(other), "RSA")
    }.message.orEmpty()

    @Test fun `the socket has its own client`() {
        val pairing = pairing()
        assertNotSame(transport.streaming(pairing, null, null), transport.socket(pairing, null, null))
    }

    @Test fun `the hello identity is checked once the pairing has a generation and a strict key refreshes its hints`() {
        val pairing = pairing()
        val strict = pairing.copy(tlsMode = PairingTlsMode.PINNED_KEY_STRICT, fingerprint = null, spkiFingerprint = "ab".repeat(32))
        assertEquals("device-1", transport.expectedDeviceId(pairing))
        assertNull(transport.expectedDeviceId(pairing.copy(pairingGeneration = null)))
        assertTrue(transport.refreshesHints(strict))
        assertFalse(transport.refreshesHints(pairing))
    }

    @Test fun `clients name an IPv6 literal host without brackets`() {
        val literal = pairing("https://[fd00::1]:7600")
        for (client in listOf(transport.http(literal, null, null), transport.streaming(literal, null, null), transport.revocation(literal))) {
            assertTrue(refusal(client), "; fd00::1 cannot fall back" in refusal(client))
        }
    }

    @Test fun `a pending revocation requires the pin`() {
        val unpinned = pairing().copy(fingerprint = "not-a-fingerprint")
        assertThrows(IllegalArgumentException::class.java) { transport.revocation(unpinned) }
    }
}

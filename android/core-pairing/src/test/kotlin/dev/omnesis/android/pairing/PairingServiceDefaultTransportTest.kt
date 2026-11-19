// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.coroutines.runBlocking
import okhttp3.Protocol
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

/** Exercise the production factory wiring, including strict TLS before the pairing code is sent. */
class PairingServiceDefaultTransportTest {
    private val certificate = HeldCertificate.Builder().commonName("gateway").addSubjectAlternativeName("localhost").build()
    private fun hash(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
    private val leaf get() = hash(certificate.certificate.encoded)
    private val key get() = hash(certificate.certificate.publicKey.encoded)
    private val reply = """{"device":{"id":"device-one","name":"Gateway","kind":"android"},"tokenId":"generation-one","token":"device-token","scopes":["read"]}"""
    private fun server(held: HeldCertificate = certificate) = MockWebServer().apply {
        protocols = listOf(Protocol.HTTP_1_1)
        useHttps(HandshakeCertificates.Builder().heldCertificate(held).build().sslSocketFactory(), false)
        start()
    }

    @Test fun `default legacy leaf strict leaf and strict key factories perform real HTTPS exchanges`() = runBlocking {
        for (mode in listOf(PairingTlsMode.PINNED_LEAF, PairingTlsMode.PINNED_LEAF_STRICT, PairingTlsMode.PINNED_KEY_STRICT)) {
            server().use { server ->
                val origin = server.url("/").toString().trimEnd('/')
                val payload = when (mode) {
                    PairingTlsMode.PINNED_LEAF -> """{"v":3,"gatewayUrl":"$origin","pairingCode":"CODE","fingerprint":"$leaf"}"""
                    PairingTlsMode.PINNED_LEAF_STRICT -> """{"v":4,"gatewayUrl":"$origin","pairingCode":"CODE","tls":{"mode":"pinned-leaf-strict","fingerprint":"$leaf"}}"""
                    else -> """{"v":4,"gatewayUrl":"$origin","pairingCode":"CODE","tls":{"mode":"pinned-key-strict","spkiFingerprint":"$key"}}"""
                }
                server.enqueue(MockResponse().setBody(reply))
                if (mode == PairingTlsMode.PINNED_KEY_STRICT) server.enqueue(MockResponse().setBody("""{"version":1,"candidates":[]}"""))
                val service = PairingService(InMemoryStore())
                val pairing = service.pair(payload)
                assertEquals(mode, pairing.tlsMode)
                assertEquals("device-token", pairing.token)
                assertEquals(pairing, service.current())
                val exchange = server.takeRequest()
                assertEquals("/devices/pair", exchange.path)
                assertTrue(exchange.body.readUtf8().contains("CODE"))
                assertNull(exchange.getHeader("Authorization"))
                if (mode == PairingTlsMode.PINNED_KEY_STRICT) {
                    val metadata = server.takeRequest()
                    assertEquals("/devices/direct-candidates", metadata.path)
                    assertEquals("Bearer device-token", metadata.getHeader("Authorization"))
                }
            }
        }
    }

    @Test fun `default strict factories reject expired or wrong hostname certificates before credentials`() = runBlocking {
        val now = System.currentTimeMillis()
        val expired = HeldCertificate.Builder().commonName("gateway").addSubjectAlternativeName("localhost")
            .validityInterval(now - 120_000, now - 60_000).build()
        val wrongHost = HeldCertificate.Builder().commonName("gateway").addSubjectAlternativeName("other.example.test").build()
        for (held in listOf(expired, wrongHost)) {
            server(held).use { server ->
                val origin = server.url("/").toString().trimEnd('/')
                val certPin = hash(held.certificate.encoded)
                val keyPin = hash(held.certificate.publicKey.encoded)
                for (tls in listOf("""{"mode":"pinned-leaf-strict","fingerprint":"$certPin"}""", """{"mode":"pinned-key-strict","spkiFingerprint":"$keyPin"}""")) {
                    val service = PairingService(InMemoryStore())
                    assertNotNull(runCatching { service.pair("""{"v":4,"gatewayUrl":"$origin","pairingCode":"PRIVATE-CODE","tls":$tls}""") }.exceptionOrNull())
                    assertNull(service.current())
                }
                assertEquals(0, server.requestCount)
            }
        }
    }

    @Test fun `unconfigured system trust and incorrect strict pins cannot send pairing credentials`() = runBlocking {
        server().use { server ->
            val origin = server.url("/").toString().trimEnd('/')
            val manual = PairingService(InMemoryStore())
            assertNotNull(runCatching { manual.pairManually(origin, "PRIVATE-CODE") }.exceptionOrNull())
            assertNull(manual.current())
            for (tls in listOf("""{"mode":"system"}""", """{"mode":"pinned-leaf-strict","fingerprint":"${"00".repeat(32)}"}""", """{"mode":"pinned-key-strict","spkiFingerprint":"${"00".repeat(32)}"}""")) {
                val service = PairingService(InMemoryStore())
                assertNotNull(runCatching { service.pair("""{"v":4,"gatewayUrl":"$origin","pairingCode":"PRIVATE-CODE","tls":$tls}""") }.exceptionOrNull())
                assertNull(service.current())
            }
            assertEquals(0, server.requestCount)
        }
    }
}

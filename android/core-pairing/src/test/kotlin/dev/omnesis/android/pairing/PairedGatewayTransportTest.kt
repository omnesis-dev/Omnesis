// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import dev.omnesis.android.transport.tls.LeafCertPinner
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue

class PairedGatewayTransportTest {
    private val digest = "ab".repeat(32)
    private fun pairing(mode: PairingTlsMode) = Pairing("https://gateway.example.test", "synthetic-token",
        deviceId = "synthetic-device", gatewayName = "Test gateway", pairingGeneration = "generation",
        fingerprint = digest, spkiFingerprint = digest, tlsMode = mode)
    private fun close(client: OkHttpClient) { client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }

    @Test fun `all ordinary legacy direct and strict modes retain independent HTTP streaming and socket policies`() {
        for (mode in PairingTlsMode.entries) {
            val value = pairing(mode)
            val http = PairedGatewayTransport.http(value)
            val streaming = PairedGatewayTransport.streaming(value) { fail("Unexpected CA upgrade") }
            val socket = PairedGatewayTransport.socket(value, null, null)
            try {
                assertEquals(30_000, http.callTimeoutMillis)
                assertEquals(0, streaming.callTimeoutMillis)
                assertEquals(0, socket.readTimeoutMillis)
                assertEquals(20_000, socket.pingIntervalMillis)
                assertEquals(mode == PairingTlsMode.PINNED_KEY_STRICT, PairedGatewayTransport.directRoute(value) != null)
            } finally { close(http); close(streaming); close(socket) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            PairedGatewayTransport.http(pairing(PairingTlsMode.PINNED_KEY_STRICT).copy(url = "http://gateway.example.test"))
        }
        assertThrows(PairingPayloadException::class.java) {
            PairedGatewayTransport.http(pairing(PairingTlsMode.PINNED_KEY_STRICT).copy(spkiFingerprint = null))
        }
        assertThrows(PairingPayloadException::class.java) {
            PairedGatewayTransport.http(pairing(PairingTlsMode.PINNED_KEY_STRICT).copy(spkiFingerprint = "malformed"))
        }
    }

    @Test fun `only valid optional strict LAN facts enable routing and malformed facts preserve authority`() {
        val facts = listOf(DirectGatewayCandidate("192.168.1.2", 7600))
        for (mode in PairingTlsMode.entries) {
            val value = pairing(mode).copy(directCandidates = facts)
            val route = PairedGatewayTransport.directRoute(value)
            assertEquals(mode.isStrict, route != null)
            val client = PairedGatewayTransport.http(value)
            try { assertEquals(mode.isStrict, !client.retryOnConnectionFailure) } finally { close(client) }
        }
        for (mode in listOf(PairingTlsMode.PINNED_KEY_STRICT, PairingTlsMode.PINNED_LEAF_STRICT)) {
            val value = pairing(mode).copy(directCandidates = listOf(DirectGatewayCandidate("8.8.8.8", 443)))
            assertNull(PairedGatewayTransport.directRoute(value))
            val client = PairedGatewayTransport.streaming(value)
            try { assertTrue(client.retryOnConnectionFailure) } finally { close(client) }
        }
    }

    @Test fun `actual default key pairing exchanges and authenticates metadata without Google or relay setup`() = runBlocking {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverCertificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val requests = LinkedBlockingQueue<RecordedRequest>()
        MockWebServer().use { server ->
            server.useHttps(serverCertificates.sslSocketFactory(), false)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests.add(request)
                    return when (request.path) {
                        "/devices/pair" -> MockResponse().setBody("""{"device":{"id":"synthetic-device","name":"Test gateway","kind":"android"},"tokenId":"generation","token":"synthetic-token","scopes":["read","admin"]}""")
                        "/devices/direct-candidates" -> if (request.getHeader("Authorization") == "Bearer synthetic-token")
                            MockResponse().setBody("""{"version":1,"candidates":[]}""") else MockResponse().setResponseCode(401)
                        else -> MockResponse().setBody("synthetic-body")
                    }
                }
            }
            server.start()
            val origin = server.url("/").toString().trimEnd('/')
            val key = LeafCertPinner.sha256Hex(certificate.certificate.publicKey.encoded)
            val service = PairingService(InMemoryStore())
            val value = service.pair("""{"v":4,"gatewayUrl":"$origin","pairingCode":"SYNTHETIC","tls":{"mode":"pinned-key-strict","spkiFingerprint":"$key"}}""")
            assertEquals(key, value.spkiFingerprint)
            assertNull(value.fingerprint)
            assertEquals(value, service.current())
            assertEquals("/devices/pair", requests.remove().path)
            assertEquals("Bearer synthetic-token", requests.remove().getHeader("Authorization"))
            for (client in listOf(PairedGatewayTransport.http(value), PairedGatewayTransport.httpOnRoute(value, null, null),
                                  PairedGatewayTransport.streamingOnRoute(value, null, null))) {
            try { client.newCall(Request.Builder().url("$origin/probe").header("Authorization", "Bearer ${value.token}").build()).execute().use {
                assertEquals("synthetic-body", it.body!!.string())
            } } finally { close(client) }
            assertEquals("Bearer synthetic-token", requests.remove().getHeader("Authorization"))
            }
        }
    }
}

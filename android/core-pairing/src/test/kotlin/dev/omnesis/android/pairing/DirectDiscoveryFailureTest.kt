// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

class DirectDiscoveryFailureTest {
    private val origin = "https://gateway.example.test"
    private val spki = "ab".repeat(32)
    private val payload get() = """{"v":4,"gatewayUrl":"$origin","pairingCode":"CODE","tls":{"mode":"pinned-key-strict","spkiFingerprint":"$spki"}}"""
    private val reply = """{"device":{"id":"device-new","name":"Gateway","kind":"android"},"tokenId":"new-generation","token":"new-token","scopes":["read"]}"""

    @Test fun `only temporary availability failures allow an already approved exchange to commit`() = runBlocking {
        val temporary = listOf(404, 429, 500, 503, 599).map { CloudPairingException(it) } +
            listOf(ConnectException(), NoRouteToHostException(), SocketException(), SocketTimeoutException(), UnknownHostException())
        for (error in temporary) {
            assertTrue(isTemporaryDirectDiscoveryFailure(error))
            assertTrue(GatewayDirectCandidateDiscovery.isTemporary(error))
            MockWebServer().use { server ->
                server.start(); server.enqueue(MockResponse().setBody(reply))
                val store = InMemoryStore()
                val service = service(store, server) { throw error }
                assertEquals("new-token", service.pair(payload).token)
                assertEquals(emptyList<DirectGatewayCandidate>(), service.current()!!.directCandidates)
            }
        }
    }

    @Test fun `refused metadata never replaces a previous credential or commits a new one`() = runBlocking {
        val errors = listOf(400, 401, 403, 499, 600).map { CloudPairingException(it) } + listOf(
            CloudPairingException(), SSLHandshakeException("TLS refused"), SSLPeerUnverifiedException("Pin refused"),
            IOException("Unexpected protocol"), IllegalArgumentException("Invalid metadata"), CancellationException("Cancelled"),
        )
        for (error in errors) {
            assertFalse(isTemporaryDirectDiscoveryFailure(error))
            assertFalse(GatewayDirectCandidateDiscovery.isTemporary(error))
            MockWebServer().use { server ->
                server.start()
                val store = InMemoryStore()
                var refusal: Exception? = null
                val service = service(store, server) { refusal?.let { throw it }; emptyList() }
                server.enqueue(MockResponse().setBody(reply))
                service.pair(payload)
                val previous = store.get("gateway.credential.v1")
                refusal = error
                server.enqueue(MockResponse().setBody(reply.replace("new-token", "other-token")))
                assertSame(error, runCatching { service.pair(payload) }.exceptionOrNull())
                assertEquals(previous, store.get("gateway.credential.v1"))
                service.unpair()
                server.enqueue(MockResponse().setBody(reply))
                assertSame(error, runCatching { service.pair(payload) }.exceptionOrNull())
                assertNull(service.current())
            }
        }
    }

    @Test fun `unpair during optional discovery cannot resurrect the approved credential`() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setBody(reply))
            val store = InMemoryStore()
            lateinit var service: PairingService
            service = service(store, server) { service.unpair(); throw ConnectException() }
            assertTrue(runCatching { service.pair(payload) }.exceptionOrNull() is CancellationException)
            assertNull(service.current())
        }
    }

    @Test fun `real pinned HTTPS preserves HTTP refusals and rejects malformed metadata and replacement keys`() = runBlocking {
        val certificate = HeldCertificate.Builder().commonName("gateway").addSubjectAlternativeName("localhost").build()
        val pin = MessageDigest.getInstance("SHA-256").digest(certificate.certificate.publicKey.encoded).joinToString("") { "%02x".format(it) }
        MockWebServer().use { server ->
            server.protocols = listOf(Protocol.HTTP_1_1)
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            server.start()
            val url = server.url("/").toString().trimEnd('/')
            for (status in listOf(404, 429, 503, 401, 403, 307)) {
                server.enqueue(MockResponse().setResponseCode(status))
                val failure = runCatching { fetchPairedDirectCandidates(url, "device-token", pin) }.exceptionOrNull()
                assertEquals(status, (failure as CloudPairingException).statusCode)
                assertEquals(status in listOf(404, 429, 503), isTemporaryDirectDiscoveryFailure(failure))
                assertEquals("Bearer device-token", server.takeRequest().getHeader("Authorization"))
            }
            for (body in listOf("not JSON", "{}", """{"version":2,"candidates":[]}""", """{"version":1,"candidates":[{"address":"127.0.0.1","port":443}]}""")) {
                server.enqueue(MockResponse().setBody(body))
                val failure = runCatching { fetchPairedDirectCandidates(url, "device-token", pin) }.exceptionOrNull()!!
                assertFalse(isTemporaryDirectDiscoveryFailure(failure as Exception))
                server.takeRequest()
            }
            server.enqueue(MockResponse().setBody("""{"version":1,"candidates":[]}"""))
            val pairing = Pairing(url = url, token = "device-token", deviceId = "device-one", gatewayName = "Gateway",
                tlsMode = PairingTlsMode.PINNED_KEY_STRICT, spkiFingerprint = pin)
            assertEquals(emptyList<DirectGatewayCandidate>(), GatewayDirectCandidateDiscovery.fetch(pairing))
            for (invalid in listOf(pairing.copy(tlsMode = PairingTlsMode.SYSTEM), pairing.copy(spkiFingerprint = null), pairing.copy(spkiFingerprint = "invalid"))) {
                assertNotNull(runCatching { GatewayDirectCandidateDiscovery.fetch(invalid) }.exceptionOrNull())
            }
            server.takeRequest()
            val wrongKey = runCatching { fetchPairedDirectCandidates(url, "device-token", "00".repeat(32)) }.exceptionOrNull()
            assertTrue(wrongKey is javax.net.ssl.SSLException || wrongKey is SSLPeerUnverifiedException)
            assertFalse(isTemporaryDirectDiscoveryFailure(wrongKey as Exception))
            assertEquals(11, server.requestCount)
        }
    }

    private fun service(store: SecureStore, server: MockWebServer, fetch: suspend () -> List<DirectGatewayCandidate>) = PairingService(
        store,
        cloudRelay = true,
        keyClientFactory = { _, _ -> OkHttpClient.Builder().addInterceptor { chain ->
            chain.proceed(chain.request().newBuilder().url(server.url(chain.request().url.encodedPath)).build())
        }.build() },
        fetchDirectCandidates = { _, _, _ -> fetch() },
    )
}

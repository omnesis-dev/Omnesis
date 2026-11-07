// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.coroutines.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.Protocol
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class CloudPairingHTTPTest {
    private val certificate = HeldCertificate.Builder().commonName("Fictional gateway").addSubjectAlternativeName("localhost").build()
    private val fingerprint get() = MessageDigest.getInstance("SHA-256").digest(certificate.certificate.encoded).joinToString("") { "%02x".format(it) }
    private fun server() = MockWebServer().apply {
        protocols = listOf(Protocol.HTTP_1_1)
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
        start()
    }

    @Test fun `HTTPS handshake and explicit pin protect JSON POST credentials and streaming responses`() = runBlocking {
        server().use { server ->
            CloudPairingHTTP(fingerprint).use { client ->
                server.enqueue(MockResponse().setBody("{\"ok\":true}").setHeader("Set-Cookie", "fictional=private"))
                val reply = client.request(server.url("/devices/google/request").toString(), "{\"secret\":\"synthetic\"}", "routing-test-token")
                assertEquals("{\"ok\":true}", reply)
                val request = server.takeRequest()
                assertEquals("POST", request.method)
                assertEquals("Bearer routing-test-token", request.getHeader("Authorization"))
                assertEquals("application/json; charset=utf-8", request.getHeader("Content-Type"))
                assertEquals("{\"secret\":\"synthetic\"}", request.body.readUtf8())
                server.enqueue(MockResponse().setChunkedBody("{\"ok\":true}", 2))
                assertEquals("{\"ok\":true}", client.request(server.url("/poll").toString()))
                val poll = server.takeRequest()
                assertEquals("GET", poll.method); assertNull(poll.getHeader("Authorization")); assertNull(poll.getHeader("Cookie"))
            }
        }
    }

    @Test fun `replacement certificate redirects declared or chunked oversize and malformed origins fail closed`() = runBlocking {
        server().use { server ->
            CloudPairingHTTP("0".repeat(64)).use { wrong ->
                try { wrong.request(server.url("/").toString()); fail("Replacement certificate accepted") }
                catch (_: java.io.IOException) { }
            }
            CloudPairingHTTP(fingerprint).use { client ->
                for (response in listOf(MockResponse().setResponseCode(401),
                    MockResponse().setResponseCode(307).setHeader("Location", "https://other.example.test/"),
                    MockResponse().setBody("{}").setHeader("Content-Length", "65537"),
                    MockResponse().setChunkedBody(Buffer().write(ByteArray(65_537)), 8192))) {
                    server.enqueue(response)
                    try { client.request(server.url("/refused").toString()); fail("Unsafe response accepted") }
                    catch (_: CloudPairingException) { }
                }
                for (url in listOf("http://gateway.example.test/", "https://user:password@gateway.example.test/", "https://gateway.example.test/#fragment")) {
                    try { client.request(url); fail("Unsafe URI accepted") } catch (_: CloudPairingException) { }
                }
            }
        }
        CloudPairingHTTP().close()
    }

    @Test fun `closed transport never sends another request`(): Unit = runBlocking {
        val client = CloudPairingHTTP(fingerprint)
        client.close(); client.close()
        try { client.request("https://gateway.example.test/"); fail("Closed client sent a request") }
        catch (_: CloudPairingException) { }
    }

    @Test fun `cancellation and disconnect release the TLS request`() = runBlocking {
        server().use { server ->
            CloudPairingHTTP(fingerprint).use { client ->
                server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
                val request = async { client.request(server.url("/waiting").toString()) }
                assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(3, TimeUnit.SECONDS) })
                request.cancelAndJoin()
                assertTrue(request.isCancelled)
                server.enqueue(MockResponse().setBody("response must be complete".repeat(100)).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
                try { client.request(server.url("/disconnect").toString()); fail("Disconnected request succeeded") }
                catch (_: java.io.IOException) { }
            }
        }
    }
}

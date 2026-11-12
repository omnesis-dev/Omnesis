// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertThrows
import org.junit.Assert.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicInteger

class PinnedOkHttpTest {
    private lateinit var server: MockWebServer
    private var serverStarted = false

    @Before
    fun setUp() {
        server = MockWebServer()
    }

    @After
    fun tearDown() {
        if (serverStarted) server.close()
    }

    @Test
    fun requiredPinRejectsMissingFingerprint() {
        assertThrows(IllegalArgumentException::class.java) {
            PinnedOkHttp.build(fingerprint = null, requirePin = true)
        }
    }

    @Test
    fun strictMatchingPinRefusesExpiredCertificatesAndWrongHostnamesInRealTLS() {
        val expired = HeldCertificate.Builder().addSubjectAlternativeName("localhost").validityInterval(1000, 2000).build()
        val wrongHost = HeldCertificate.Builder().addSubjectAlternativeName("other.example.test").build()
        for (certificate in listOf(expired, wrongHost)) {
            MockWebServer().use { endpoint ->
                endpoint.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
                endpoint.start()
                endpoint.enqueue(MockResponse().setBody("legacy"))
                val pin = LeafCertPinner.sha256Hex(certificate.certificate.encoded)
                val request = Request.Builder().url(endpoint.url("/")).build()
                PinnedOkHttp.build(pin, requirePin = true).newCall(request).execute().use { assertEquals("legacy", it.body?.string()) }
                assertThrows(IOException::class.java) {
                    PinnedOkHttp.build(pin, requirePin = true, requireCertificateValidity = true).newCall(request).execute()
                }
                assertThrows(IOException::class.java) {
                    PinnedOkHttp.buildStreaming(pin, requirePin = true, requireCertificateValidity = true).newCall(request).execute()
                }
            }
        }
    }

    @Test
    fun strictCurrentMatchingCertificateWorksForHttpAndStreamingWithoutPublicTrust() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val pin = LeafCertPinner.sha256Hex(certificate.certificate.encoded)
        MockWebServer().use { endpoint ->
            endpoint.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            endpoint.start()
            for (client in listOf(PinnedOkHttp.build(pin, requirePin = true, requireCertificateValidity = true),
                PinnedOkHttp.buildStreaming(pin, requirePin = true, requireCertificateValidity = true))) {
                endpoint.enqueue(MockResponse().setBody("strict"))
                client.newCall(Request.Builder().url(endpoint.url("/")).build()).execute().use { assertEquals("strict", it.body?.string()) }
                client.connectionPool.evictAll()
            }
        }
    }

    @Test
    fun requiredPinRejectsMalformedFingerprint() {
        assertThrows(IllegalArgumentException::class.java) {
            PinnedOkHttp.buildStreaming(fingerprint = "not-a-pin", requirePin = true)
        }
    }

    @Test
    fun systemTrustAllowsNoFingerprint() {
        PinnedOkHttp.build(fingerprint = null, requirePin = false)
    }

    @Test
    fun systemTrustRejectsAnUntrustedSelfSignedCertificate() {
        val leaf = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(leaf).build().sslSocketFactory(), false)
        server.start()
        serverStarted = true
        server.enqueue(MockResponse().setBody("nope"))

        assertThrows(IOException::class.java) {
            PinnedOkHttp.build().newCall(Request.Builder().url(server.url("/")).build()).execute()
        }
        assertThrows(IOException::class.java) {
            PinnedOkHttp.buildStreaming().newCall(Request.Builder().url(server.url("/stream"))
                .header("Authorization", "Bearer must-not-arrive").build()).execute()
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun keyPinWithoutAnExplicitHostStillVerifiesTheActualRequestHostname() {
        val leaf = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        MockWebServer().use { endpoint ->
            endpoint.useHttps(HandshakeCertificates.Builder().heldCertificate(leaf).build().sslSocketFactory(), false)
            endpoint.start()
            val pin = LeafCertPinner.sha256Hex(leaf.certificate.publicKey.encoded)
            val client = PinnedOkHttp.build(spkiFingerprint = pin, requirePin = true)
            endpoint.enqueue(MockResponse().setBody("verified"))
            client.newCall(Request.Builder().url(endpoint.url("/"))
                .header("Authorization", "Bearer device-token").build()).execute().use {
                assertEquals("verified", it.body?.string())
            }
            assertEquals("Bearer device-token", endpoint.takeRequest().getHeader("Authorization"))
            client.connectionPool.evictAll()
            val wrongHostname = endpoint.url("/").newBuilder().host("127.0.0.1").build()
            assertThrows(IOException::class.java) {
                client.newCall(Request.Builder().url(wrongHostname)
                    .header("Authorization", "Bearer must-not-arrive").build()).execute()
            }
            assertEquals(1, endpoint.requestCount)
            client.connectionPool.evictAll()
        }
    }

    @Test
    fun systemTrustChecksHostnameAndAcceptsLeafRotationUnderTheSameCA() {
        val root = HeldCertificate.Builder().certificateAuthority(0).commonName("Example Root").build()
        val clientTrust = HandshakeCertificates.Builder().addTrustedCertificate(root.certificate).build()

        fun trustedClient(): OkHttpClient = PinnedOkHttp.buildForTest(
            OkHttpClient.Builder().sslSocketFactory(clientTrust.sslSocketFactory(), clientTrust.trustManager),
        )

        repeat(2) { generation ->
            val leaf = HeldCertificate.Builder()
                .commonName("gateway-$generation")
                .addSubjectAlternativeName("localhost")
                .signedBy(root)
                .build()
            val rotatingServer = MockWebServer()
            rotatingServer.useHttps(
                HandshakeCertificates.Builder().heldCertificate(leaf, root.certificate).build().sslSocketFactory(),
                false,
            )
            rotatingServer.start()
            rotatingServer.enqueue(MockResponse().setBody("generation-$generation"))
            try {
                trustedClient().newCall(Request.Builder().url(rotatingServer.url("/")).build()).execute().use {
                    assertEquals(200, it.code)
                }
                val wrongHost = rotatingServer.url("/").newBuilder().host("127.0.0.1").build()
                assertThrows(IOException::class.java) {
                    trustedClient().newCall(Request.Builder().url(wrongHost).build()).execute()
                }
            } finally {
                rotatingServer.close()
            }
        }
    }

    @Test
    fun pinnedTrustRejectsLeafRotation() {
        val first = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val second = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(second).build().sslSocketFactory(), false)
        server.start()
        serverStarted = true
        server.enqueue(MockResponse().setBody("rotated"))
        val firstFingerprint = LeafCertPinner.sha256Hex(first.certificate.encoded)

        assertThrows(IOException::class.java) {
            PinnedOkHttp.build(firstFingerprint, requirePin = true)
                .newCall(Request.Builder().url(server.url("/")).build())
                .execute()
        }
    }

    @Test
    fun pinnedTrustAcceptsAPubliclyTrustedRotationForTheDnsHostAndReportsTheUpgrade() {
        val root = HeldCertificate.Builder().certificateAuthority(0).commonName("Example Root").build()
        val systemTrust = HandshakeCertificates.Builder().addTrustedCertificate(root.certificate).build().trustManager
        val pinned = HeldCertificate.Builder().addSubjectAlternativeName("gateway.example.com").signedBy(root).build()
        val renewed = HeldCertificate.Builder().addSubjectAlternativeName("gateway.example.com").signedBy(root).build()
        server.useHttps(
            HandshakeCertificates.Builder().heldCertificate(renewed, root.certificate).build().sslSocketFactory(),
            false,
        )
        server.start()
        serverStarted = true
        server.enqueue(MockResponse().setBody("renewed"))
        server.enqueue(MockResponse().setBody("renewed"))
        val loopback = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> =
                if (hostname == "gateway.example.com") {
                    listOf(InetAddress.getLoopbackAddress())
                } else {
                    Dns.SYSTEM.lookup(hostname)
                }
        }

        fun client(host: String, upgrades: AtomicInteger) = PinnedOkHttp.buildForTest(
            OkHttpClient.Builder().dns(loopback),
            fingerprint = LeafCertPinner.sha256Hex(pinned.certificate.encoded),
            requirePin = true,
            host = host,
            onSystemTrustVerified = { upgrades.incrementAndGet() },
            systemTrust = systemTrust,
        )

        val upgrades = AtomicInteger()
        val byName = server.url("/").newBuilder().host("gateway.example.com").build()
        client("gateway.example.com", upgrades).newCall(Request.Builder().url(byName).build()).execute().use {
            assertEquals(200, it.code)
            assertEquals("renewed", it.body!!.string())
        }
        assertEquals(1, upgrades.get())

        val ipUpgrades = AtomicInteger()
        val byIp = server.url("/").newBuilder().host("127.0.0.1").build()
        assertThrows(IOException::class.java) {
            client("127.0.0.1", ipUpgrades).newCall(Request.Builder().url(byIp).build()).execute()
        }
        assertEquals(0, ipUpgrades.get())
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.routing

import dev.omnesis.android.transport.tls.LeafCertPinner
import dev.omnesis.android.transport.tls.PinnedOkHttp
import kotlinx.coroutines.async
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.util.Base64
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.ExtendedSSLSession
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket

class DirectGatewayTLSRoutingTest {
    private val host = "gateway.example.test"
    private val origin = "https://$host:9443"
    private fun held(name: String = host) = HeldCertificate.Builder().addSubjectAlternativeName(name).build()
    private fun key(value: HeldCertificate) = LeafCertPinner.sha256Hex(value.certificate.publicKey.encoded)
    private fun route(origin: String, ports: List<Int>) = DirectGatewayRoute.createValidated(origin,
        ports.map { DirectGatewayCandidate("127.0.0.1", it) }, true)!!
    private fun stop(client: OkHttpClient) { client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }

    @Test fun `real HTTPS and WebSocket keep canonical SNI Host and bearer while dialing the LAN port`() {
        val certificate = held()
        RoutedTLSPeer(certificate).use { peer ->
            val route = route(origin, listOf(peer.port))
            val client = PinnedOkHttp.build(spkiFingerprint = key(certificate), requirePin = true, host = host, directRoute = route)
            val stream = PinnedOkHttp.buildStreaming(spkiFingerprint = key(certificate), requirePin = true, host = host, directRoute = route)
            try {
                val request = Request.Builder().url("$origin/probe").header("Authorization", "Bearer device-test-token")
                    .post("synthetic-request-body".toRequestBody()).build()
                client.newCall(request).execute().use { response ->
                    assertEquals(200, response.code)
                    assertIdentity(requireNotNull(response.body).string(), "$host:9443", "synthetic-request-body")
                }
                val done = CountDownLatch(1)
                val message = AtomicReference<String?>()
                val failure = AtomicReference<Throwable?>()
                val socket = stream.newWebSocket(Request.Builder().url("wss://$host:9443/events")
                    .header("Authorization", "Bearer device-test-token").build(), object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) { message.set(text); done.countDown() }
                    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                        if (message.get() == null) failure.set(error)
                        done.countDown()
                    }
                })
                try {
                    assertTrue(done.await(5, TimeUnit.SECONDS))
                    assertNull(failure.get())
                    assertIdentity(requireNotNull(message.get()), "$host:9443", "")
                } finally { socket.cancel() }
                assertEquals(2, peer.requests.size)
            } finally { stop(client); stop(stream) }
        }
    }

    @Test fun `an expired certificate with the pinned key still serves on the LAN path and never through the relay`() {
        val trusted = held()
        val lapsed = HeldCertificate.Builder().keyPair(trusted.keyPair).addSubjectAlternativeName(host).validityInterval(1000, 2000).build()
        // At home: the hint is the gateway itself, and its key is the pinned one.
        RoutedTLSPeer(lapsed).use { lan ->
            val route = route(origin, listOf(lan.port))
            val client = PinnedOkHttp.build(spkiFingerprint = key(trusted), host = host, requirePin = true, directRoute = route)
            try {
                client.newCall(Request.Builder().url("$origin/private")
                    .header("Authorization", "Bearer device-test-token").post("private-body".toRequestBody()).build()).execute().use { response ->
                    assertEquals(200, response.code)
                    assertIdentity(requireNotNull(response.body).string(), "$host:9443", "private-body")
                }
                assertEquals(GatewayConnectionPath.LOCAL, route.connectionPath.value)
            } finally { route.retire(); stop(client) }
        }
        // Away from home the same lapsed certificate arrives through the relay's address, and is refused.
        RoutedTLSPeer(lapsed).use { relay ->
            val relayOrigin = "https://$host:${relay.port}"
            val route = DirectGatewayRoute.maintained(relayOrigin, emptyList())
            val trustedClient = PinnedOkHttp.buildForTest(OkHttpClient.Builder(), spkiFingerprint = key(trusted), host = host, requirePin = true, directRoute = route)
            val factory = DirectGatewaySocketFactory(route, resolve = { listOf(InetAddress.getLoopbackAddress()) })
            val client = trustedClient.newBuilder().socketFactory(factory).dns(factory.dns).proxy(java.net.Proxy.NO_PROXY).build()
            try {
                assertThrows(IOException::class.java) {
                    client.newCall(Request.Builder().url("$relayOrigin/private").header("Authorization", "Bearer device-test-token").build()).execute()
                }
                assertTrue(relay.requests.isEmpty())
            } finally { route.retire(); stop(client) }
        }
    }

    @Test fun `TLS key and hostname failures skip untrusted hints without releasing application bytes`() {
        val trusted = held()
        val bad = listOf(held(), HeldCertificate.Builder().keyPair(trusted.keyPair).addSubjectAlternativeName("other.example.test").build())
        for (certificate in bad) {
            RoutedTLSPeer(certificate).use { first -> RoutedTLSPeer(trusted).use { second ->
                val client = PinnedOkHttp.build(spkiFingerprint = key(trusted), host = host, requirePin = true,
                    directRoute = route(origin, listOf(first.port, second.port)))
                try {
                    client.newCall(Request.Builder().url("$origin/private")
                        .header("Authorization", "Bearer device-test-token").post("private-body".toRequestBody()).build()).execute().use { response ->
                        assertEquals(200, response.code)
                        assertIdentity(requireNotNull(response.body).string(), "$host:9443", "private-body")
                    }
                    assertTrue(first.requests.isEmpty())
                    assertEquals(1, second.requests.size)
                    assertEquals("Bearer device-test-token", second.requests.single()["authorization"])
                } finally { stop(client) }
            } }
        }
    }

    @Test fun `untrusted LAN falls back to the pinned canonical relay without exposing credentials`() {
        val trusted = held()
        RoutedTLSPeer(held()).use { lan -> RoutedTLSPeer(trusted).use { relay ->
            val relayOrigin = "https://$host:${relay.port}"
            val route = route(relayOrigin, listOf(lan.port))
            val trustedClient = PinnedOkHttp.build(spkiFingerprint = key(trusted), host = host, requirePin = true)
            val factory = DirectGatewaySocketFactory(route, resolve = { listOf(InetAddress.getLoopbackAddress()) },
                authenticate = { target, timeout -> DirectGatewayProbe.verifyCandidate(route, trustedClient, target, timeout) })
            val client = trustedClient.newBuilder().socketFactory(factory).dns(factory.dns).proxy(java.net.Proxy.NO_PROXY).build()
            try {
                client.newCall(Request.Builder().url("$relayOrigin/private")
                    .header("Authorization", "Bearer device-test-token").post("private-body".toRequestBody()).build()).execute().use {
                    assertEquals(200, it.code)
                    assertIdentity(requireNotNull(it.body).string(), "$host:${relay.port}", "private-body")
                }
                assertEquals(GatewayConnectionPath.RELAY, route.connectionPath.value)
                assertTrue(lan.requests.isEmpty())
                assertEquals(1, relay.requests.size)
            } finally { route.retire(); stop(client) }
        } }
    }

    @Test fun `same-key other-SAN requests are refused by the configured canonical key host`() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName(host).addSubjectAlternativeName("other.example.test").build()
        RoutedTLSPeer(certificate).use { peer ->
            val client = PinnedOkHttp.build(spkiFingerprint = key(certificate), host = host, requirePin = true).newBuilder()
                .dns(object : Dns { override fun lookup(hostname: String) = listOf(InetAddress.getLoopbackAddress()) }).build()
            try {
                assertThrows(IOException::class.java) { client.newCall(Request.Builder().url("https://other.example.test:${peer.port}/private")
                    .header("Authorization", "Bearer device-test-token").build()).execute() }
                assertTrue(peer.requests.isEmpty())
            } finally { stop(client) }
        }
    }

    @Test fun `same-key renewal works and two simultaneous routes never share credentials or teardown`() {
        val original = held()
        val renewed = HeldCertificate.Builder().keyPair(original.keyPair).addSubjectAlternativeName(host).serialNumber(2).build()
        val otherHost = "another-gateway.example.test"
        val otherCertificate = held(otherHost)
        RoutedTLSPeer(renewed).use { first -> RoutedTLSPeer(otherCertificate).use { second ->
            val firstClient = PinnedOkHttp.build(spkiFingerprint = key(original), host = host, directRoute = route(origin, listOf(first.port)))
            val otherOrigin = "https://$otherHost:9443"
            val secondClient = PinnedOkHttp.build(spkiFingerprint = key(otherCertificate), host = otherHost, directRoute = route(otherOrigin, listOf(second.port)))
            val workers = Executors.newFixedThreadPool(2)
            try {
                val work = listOf(firstClient to origin, secondClient to otherOrigin).mapIndexed { index, (client, url) ->
                    workers.submit<String> { client.newCall(Request.Builder().url("$url/private").header("Authorization", "Bearer synthetic-$index").build())
                        .execute().use { requireNotNull(it.body).string() } }
                }
                assertEquals("Bearer synthetic-0", Json.parseToJsonElement(work[0].get(5, TimeUnit.SECONDS)).jsonObject["authorization"]!!.jsonPrimitive.content)
                assertEquals("Bearer synthetic-1", Json.parseToJsonElement(work[1].get(5, TimeUnit.SECONDS)).jsonObject["authorization"]!!.jsonPrimitive.content)
                stop(firstClient)
                secondClient.newCall(Request.Builder().url("$otherOrigin/private").header("Authorization", "Bearer synthetic-1").build()).execute().use { assertEquals(200, it.code) }
                assertEquals(1, first.requests.size)
                assertEquals(2, second.requests.size)
                assertTrue(first.requests.all { it["host"] == "$host:9443" && it["authorization"] == "Bearer synthetic-0" })
                assertTrue(second.requests.all { it["host"] == "$otherHost:9443" && it["authorization"] == "Bearer synthetic-1" })
            } finally { workers.shutdownNow(); stop(firstClient); stop(secondClient) }
        } }
    }

    @Test fun `LAN probe authenticates canonical TLS without HTTP credentials and rejects key hostname expiry changes`() = kotlinx.coroutines.runBlocking {
        val trusted = held()
        val cases = listOf(
            trusted to true,
            HeldCertificate.Builder().keyPair(trusted.keyPair).addSubjectAlternativeName(host).serialNumber(9).build() to true,
            held() to false,
            HeldCertificate.Builder().keyPair(trusted.keyPair).addSubjectAlternativeName("other.example.test").build() to false,
            HeldCertificate.Builder().keyPair(trusted.keyPair).addSubjectAlternativeName(host).validityInterval(1000, 2000).build() to false,
        )
        for ((certificate, accepted) in cases) {
            RoutedTLSPeer(certificate).use { first -> RoutedTLSPeer(trusted).use { second ->
                val client = PinnedOkHttp.build(spkiFingerprint = key(trusted), host = host, requirePin = true)
                try {
                    assertEquals(accepted, DirectGatewayProbe.reachable(route(origin, listOf(first.port)), client))
                    assertTrue(DirectGatewayProbe.reachable(route(origin, listOf(first.port, second.port)), client))
                    assertTrue(first.requests.isEmpty())
                    assertTrue(second.requests.isEmpty())
                    assertEquals(if (accepted) 0 else 1, second.connections.get())
                } finally { stop(client) }
            } }
        }
    }

    @Test fun `completed trusted TLS handshake cannot promote after the total probe deadline`() = kotlinx.coroutines.runBlocking {
        val certificate = held()
        RoutedTLSPeer(certificate).use { peer ->
            val client = PinnedOkHttp.build(spkiFingerprint = key(certificate), host = host)
            try {
                var ticks = 0
                assertFalse(DirectGatewayProbe.reachable(route(origin, listOf(peer.port)), client,
                    { if (ticks++ < 3) 0 else 5_000_000_000L }, { java.net.Socket() }))
                assertTrue(peer.requests.isEmpty())
                assertEquals(1, peer.connections.get())
            } finally { stop(client) }
        }
    }

    @Test fun `LAN probe can skip owned closed TCP endpoints without sending a request`() = kotlinx.coroutines.runBlocking {
        val certificate = held()
        val closedPort = java.net.ServerSocket(0).use { it.localPort }
        RoutedTLSPeer(certificate).use { peer ->
            val client = PinnedOkHttp.build(spkiFingerprint = key(certificate), host = host)
            try {
                assertTrue(DirectGatewayProbe.reachable(route(origin, listOf(closedPort, peer.port)), client))
                assertTrue(peer.requests.isEmpty())
                assertFalse(DirectGatewayProbe.reachable(route(origin, listOf(closedPort)), client))
            } finally { stop(client) }
        }
    }

    @Test fun `probe deadline and unexpected raw connectivity errors stop before TLS or application bytes`() = kotlinx.coroutines.runBlocking {
        val client = PinnedOkHttp.build(spkiFingerprint = "ab".repeat(32), host = host)
        val closedPort = java.net.ServerSocket(0).use { it.localPort }
        val candidate = route(origin, listOf(closedPort))
        try {
            var ticks = 0
            assertFalse(DirectGatewayProbe.reachable(candidate, client, { if (ticks++ == 0) 0 else 5_000_000_000L }, { error("Connection opened past deadline") }))
            var afterConnectTicks = 0
            assertFalse(DirectGatewayProbe.reachable(candidate, client, {
                if (afterConnectTicks++ < 2) 0 else 5_000_000_000L
            }, {
                object : java.net.Socket() { override fun connect(endpoint: java.net.SocketAddress?, timeout: Int) {} }
            }))
            var closed = false
            assertFalse(DirectGatewayProbe.reachable(candidate, client, { 0 }, {
                object : java.net.Socket() {
                    override fun connect(endpoint: java.net.SocketAddress?, timeout: Int) { throw IOException("synthetic unsupported socket I/O") }
                    override fun close() { closed = true }
                }
            }))
            assertTrue(closed)
        } finally { stop(client) }
    }

    @Test fun `absolute TLS watchdog defeats a peer dribbling incomplete TLS records`() = kotlinx.coroutines.runBlocking {
        java.net.ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
            val worker = Executors.newSingleThreadExecutor()
            val firstByte = AtomicInteger(-1)
            val server = worker.submit {
                try { listener.accept().use { socket ->
                    socket.soTimeout = 1000
                    val header = socket.getInputStream().readNBytes(5)
                    firstByte.set(header.first().toInt())
                    val length = ((header[3].toInt() and 255) shl 8) or (header[4].toInt() and 255)
                    socket.getInputStream().readNBytes(length)
                    val output = socket.getOutputStream()
                    output.write(byteArrayOf(22, 3, 3, 16, 0)) // incomplete but valid-size TLS record
                    output.flush()
                    repeat(100) { output.write(0); output.flush(); Thread.sleep(50) }
                } } catch (_: IOException) { } catch (_: InterruptedException) { }
            }
            val client = PinnedOkHttp.build(spkiFingerprint = "ab".repeat(32), host = host)
            try {
                val started = System.nanoTime()
                assertFalse(DirectGatewayProbe.reachable(route(origin, listOf(listener.localPort)), client))
                val elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
                assertEquals(22, firstByte.get())
                assertTrue("Incomplete TLS record did not exercise blocking reads: $elapsed", elapsed >= 400)
                assertTrue("TLS watchdog exceeded its absolute budget: $elapsed", elapsed < 2000)
            } finally { server.cancel(true); listener.close(); worker.shutdownNow(); worker.awaitTermination(2, TimeUnit.SECONDS); stop(client) }
        }
    }

    @Test fun `cancelling a blocked TLS probe closes its owned socket immediately`() = kotlinx.coroutines.runBlocking {
        java.net.ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
            val worker = Executors.newSingleThreadExecutor()
            val hello = CountDownLatch(1)
            val closed = CountDownLatch(1)
            val server = worker.submit {
                try { listener.accept().use { socket ->
                    socket.soTimeout = 2000
                    val input = socket.getInputStream()
                    val header = input.readNBytes(5)
                    val length = ((header[3].toInt() and 255) shl 8) or (header[4].toInt() and 255)
                    input.readNBytes(length)
                    hello.countDown()
                    if (input.read() == -1) closed.countDown()
                } } catch (_: IOException) { }
            }
            val client = PinnedOkHttp.build(spkiFingerprint = "ab".repeat(32), host = host)
            try {
                val pending = async { DirectGatewayProbe.reachable(route(origin, listOf(listener.localPort)), client) }
                assertTrue(kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { hello.await(2, TimeUnit.SECONDS) })
                assertTrue(pending.isActive)
                val started = System.nanoTime()
                pending.cancel()
                pending.join()
                assertTrue("Cancellation waited for read timeout", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 500)
                assertTrue(kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { closed.await(500, TimeUnit.MILLISECONDS) })
            } finally { server.cancel(true); listener.close(); worker.shutdownNow(); worker.awaitTermination(2, TimeUnit.SECONDS); stop(client) }
        }
    }

    @Test fun `retiring a route during blocking preflight closes TLS and forbids relay lookup`() {
        java.net.ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
            val worker = Executors.newFixedThreadPool(2)
            val hello = CountDownLatch(1)
            val closed = CountDownLatch(1)
            val route = route(origin, listOf(listener.localPort))
            val client = PinnedOkHttp.build(spkiFingerprint = "ab".repeat(32), host = host)
            val dns = AtomicInteger()
            val server = worker.submit {
                listener.accept().use { socket ->
                    socket.soTimeout = 2000
                    val input = socket.getInputStream()
                    val header = input.readNBytes(5)
                    val length = ((header[3].toInt() and 255) shl 8) or (header[4].toInt() and 255)
                    input.readNBytes(length)
                    hello.countDown()
                    if (input.read() == -1) closed.countDown()
                }
            }
            val factory = DirectGatewaySocketFactory(route, resolve = { dns.incrementAndGet(); error("Retired route resolved relay") },
                authenticate = { target, timeout -> DirectGatewayProbe.verifyCandidate(route, client, target, timeout) })
            val pending = worker.submit<Boolean> {
                try { factory.select(1000); false } catch (_: java.net.SocketException) { true }
            }
            try {
                assertTrue(hello.await(2, TimeUnit.SECONDS))
                route.retire()
                assertTrue(pending.get(500, TimeUnit.MILLISECONDS))
                assertTrue(closed.await(500, TimeUnit.MILLISECONDS))
                assertEquals(0, dns.get())
            } finally { route.retire(); listener.close(); server.cancel(true); pending.cancel(true); worker.shutdownNow(); stop(client) }
        }
    }

    @Test fun `promotion skips rejected hints only while its total budget and route remain active`() = kotlinx.coroutines.runBlocking {
        val certificate = held()
        RoutedTLSPeer(held()).use { bad -> RoutedTLSPeer(certificate).use { good ->
            val client = PinnedOkHttp.build(spkiFingerprint = key(certificate), host = host)
            try {
                var ticks = 0
                assertFalse(DirectGatewayProbe.reachable(route(origin, listOf(bad.port, good.port)), client,
                    { if (ticks++ < 3) 0 else 5_000_000_000L }, { java.net.Socket() }))
                assertEquals(0, good.connections.get())
                assertTrue(bad.requests.isEmpty())
                val retired = route(origin, listOf(good.port, bad.port))
                val retiring = client.newBuilder().hostnameVerifier { _, _ -> retired.retire(); true }.build()
                try { assertFalse(DirectGatewayProbe.reachable(retired, retiring)) }
                finally { stop(retiring) }
                assertEquals(1, good.connections.get())
                assertTrue(good.requests.isEmpty())
            } finally { stop(client) }
        } }
    }

    @Test fun `cancellation after a rejected hostname never opens the next hint`() = kotlinx.coroutines.runBlocking {
        val certificate = held()
        RoutedTLSPeer(certificate).use { first -> RoutedTLSPeer(certificate).use { next ->
            val client = PinnedOkHttp.build(spkiFingerprint = key(certificate), host = host)
            try {
                val pending = async {
                    val owner = requireNotNull(kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job])
                    val cancelling = client.newBuilder().hostnameVerifier { _, _ -> owner.cancel(); false }.build()
                    try { DirectGatewayProbe.reachable(route(origin, listOf(first.port, next.port)), cancelling) }
                    finally { stop(cancelling) }
                }
                try { pending.await(); fail("Cancelled promotion completed") }
                catch (_: kotlinx.coroutines.CancellationException) { }
                assertEquals(0, next.connections.get())
                assertTrue(first.requests.isEmpty())
            } finally { stop(client) }
        } }
    }

    @Test fun `retirement before probe tracking closes its unused socket without dialing`() = kotlinx.coroutines.runBlocking {
        val candidate = route(origin, listOf(49150))
        val client = OkHttpClient()
        val closed = AtomicBoolean()
        try {
            assertFalse(DirectGatewayProbe.reachable(candidate, client, { 0 }, {
                candidate.retire()
                object : java.net.Socket() {
                    override fun connect(endpoint: java.net.SocketAddress?, timeout: Int) { fail("Retired route dialed") }
                    override fun close() { closed.set(true) }
                }
            }))
            assertTrue(closed.get())
            assertFalse(DirectGatewayProbe.reachable(candidate, client))
        } finally { stop(client) }
    }

    @Test fun `retiring a blocked promotion closes TLS without probing another hint`() = kotlinx.coroutines.runBlocking {
        java.net.ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
            RoutedTLSPeer(held()).use { next ->
                val worker = Executors.newSingleThreadExecutor()
                val hello = CountDownLatch(1)
                val route = route(origin, listOf(listener.localPort, next.port))
                val server = worker.submit {
                    listener.accept().use { socket ->
                        socket.soTimeout = 2000
                        val input = socket.getInputStream()
                        val header = input.readNBytes(5)
                        val length = ((header[3].toInt() and 255) shl 8) or (header[4].toInt() and 255)
                        input.readNBytes(length)
                        hello.countDown()
                        input.read()
                    }
                }
                val client = PinnedOkHttp.build(spkiFingerprint = "ab".repeat(32), host = host)
                val pending = async { DirectGatewayProbe.reachable(route, client) }
                try {
                    assertTrue(kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { hello.await(2, TimeUnit.SECONDS) })
                    route.retire()
                    assertFalse(kotlinx.coroutines.withTimeout(500) { pending.await() })
                    assertEquals(0, next.connections.get())
                } finally { route.retire(); pending.cancel(); server.cancel(true); listener.close(); worker.shutdownNow(); stop(client) }
            }
        }
    }

    @Test fun `a verifier completing after its attempt or total deadline cannot promote that hint`() = kotlinx.coroutines.runBlocking {
        val certificate = held()
        for (totalExpired in listOf(false, true)) {
            RoutedTLSPeer(certificate).use { first -> RoutedTLSPeer(certificate).use { next ->
                val now = java.util.concurrent.atomic.AtomicLong()
                val checks = AtomicInteger()
                val client = PinnedOkHttp.build(spkiFingerprint = key(certificate), host = host).newBuilder()
                    .hostnameVerifier { _, _ ->
                        if (checks.getAndIncrement() == 0) now.set(if (totalExpired) 5_000_000_000L else 750_000_000L)
                        true
                    }.build()
                try {
                    assertEquals(!totalExpired, DirectGatewayProbe.reachable(route(origin, listOf(first.port, next.port)), client,
                        now::get, { java.net.Socket() }))
                    assertEquals(if (totalExpired) 0 else 1, next.connections.get())
                    assertTrue(first.requests.isEmpty())
                    assertTrue(next.requests.isEmpty())
                } finally { stop(client) }
            } }
        }
    }

    private fun assertIdentity(data: String, expectedHost: String, body: String) {
        val response = Json.parseToJsonElement(data).jsonObject
        assertEquals(host, response["sni"]!!.jsonPrimitive.content)
        assertEquals(expectedHost, response["host"]!!.jsonPrimitive.content)
        assertEquals("Bearer device-test-token", response["authorization"]!!.jsonPrimitive.content)
        assertEquals(body, response["body"]!!.jsonPrimitive.content)
    }
}

/** Isolated TLS peer. Probe connections exchange no bytes; HTTP is recorded only after a real handshake. */
private class RoutedTLSPeer(certificate: HeldCertificate) : AutoCloseable {
    private val listener = HandshakeCertificates.Builder().heldCertificate(certificate).build().sslContext().serverSocketFactory
        .createServerSocket(0, 50, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))) as SSLServerSocket
    val port get() = listener.localPort
    val requests: MutableList<Map<String, String>> = Collections.synchronizedList(mutableListOf())
    val connections = AtomicInteger()
    private val closed = AtomicBoolean()
    private val executor = Executors.newSingleThreadExecutor()
    init {
        listener.soTimeout = 100
        executor.submit {
            while (!closed.get()) {
                try { (listener.accept() as SSLSocket).use { socket ->
                    connections.incrementAndGet()
                    socket.soTimeout = 1000
                    socket.startHandshake()
                    val reader = socket.inputStream.bufferedReader(Charsets.UTF_8)
                    if (reader.readLine() == null) return@use
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = reader.readLine() ?: return@use
                        if (line.isEmpty()) break
                        headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
                    }
                    val body = CharArray(headers["content-length"]?.toInt() ?: 0)
                    var offset = 0
                    while (offset < body.size) { val count = reader.read(body, offset, body.size - offset); if (count == -1) break; offset += count }
                    val sni = (socket.session as ExtendedSSLSession).requestedServerNames.filterIsInstance<SNIHostName>().firstOrNull()?.asciiName.orEmpty()
                    val result = mapOf("sni" to sni, "host" to headers["host"].orEmpty(), "authorization" to headers["authorization"].orEmpty(), "body" to String(body))
                    requests += result
                    val payload = buildJsonObject { for ((key, value) in result) put(key, value) }.toString().toByteArray()
                    val output = socket.outputStream
                    if (headers["upgrade"]?.equals("websocket", ignoreCase = true) == true) {
                        val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                            .digest((headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
                        output.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
                        output.write(0x81)
                        if (payload.size < 126) output.write(payload.size) else { output.write(126); output.write(payload.size shr 8); output.write(payload.size and 255) }
                        output.write(payload); output.flush()
                    } else {
                        output.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${payload.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        output.write(payload); output.flush()
                    }
                } } catch (_: SocketTimeoutException) { }
                catch (_: IOException) { }
            }
        }
    }
    override fun close() { closed.set(true); listener.close(); executor.shutdownNow(); executor.awaitTermination(2, TimeUnit.SECONDS) }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.routing

import dev.omnesis.android.transport.tls.PinnedOkHttp
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.*
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

class DirectGatewayRouteTest {
    private val origin = "https://gateway.example.test:9443"
    private fun route() = DirectGatewayRoute.create(origin, listOf(DirectGatewayCandidate("10.0.0.1", 7600), DirectGatewayCandidate("192.168.1.2", 8443)))!!

    @Test fun `a wrong-key LAN hint can select only another authenticated hint or the canonical relay`() {
        val value = route()
        val attempts = mutableListOf<Int>()
        val relay = InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, 1))
        val factory = DirectGatewaySocketFactory(value, probe = { target, _ -> assertEquals(9443, target.port) },
            resolve = { listOf(relay) }, authenticate = { target, _ -> attempts += target.port; false })
        assertEquals(InetSocketAddress(relay, 9443), factory.select(1000))
        assertEquals(listOf(7600, 8443), attempts)
        // The route now remembers that no hint answered; a network change makes it ask again.
        value.hintsMayBeReachable()
        val second = DirectGatewaySocketFactory(value, probe = { _, _ -> error("raw probe preceded identity") },
            resolve = { error("authenticated LAN must avoid relay DNS") }, authenticate = { target, _ -> target.port == 8443 })
        assertEquals(8443, second.select(1000).port)
    }

    @Test fun `retired routes and exhausted LAN trust budgets cannot dial another hint`() {
        val value = route()
        var now = 0L
        var attempts = 0
        val relay = InetAddress.getLoopbackAddress()
        val factory = DirectGatewaySocketFactory(value, probe = { _, _ -> }, resolve = { listOf(relay) },
            authenticate = { _, _ -> attempts++; now += 5_000_000_000L; true }, nanoTime = { now })
        assertEquals(9443, factory.select(1000).port)
        assertEquals(1, attempts)
        val retired = route()
        val blocked = DirectGatewaySocketFactory(retired, probe = { _, _ -> error("retired route dialed") },
            resolve = { error("retired route resolved DNS") }, authenticate = { _, _ -> retired.retire(); false })
        assertThrows(SocketException::class.java) { blocked.select(1000) }
    }

    @Test fun `maintained empty routes accept authenticated DHCP updates and retire irreversibly`() {
        val route = DirectGatewayRoute.maintained(origin, emptyList())
        assertTrue(route.endpoints.isEmpty())
        val placeholder = DirectGatewaySocketFactory(route).dns.lookup("gateway.example.test").single()
        assertEquals("gateway.example.test", placeholder.hostName)
        assertTrue(placeholder.isAnyLocalAddress)
        val validLength = List(3) { "x".repeat(63) }.plus("x".repeat(61)).joinToString(".")
        assertEquals(253, DirectGatewayRoute.maintained("https://$validLength", emptyList()).host.length)
        assertThrows(IllegalArgumentException::class.java) { DirectGatewayRoute.maintained("https://${validLength}x", emptyList()) }
        val socket = object : Socket() { var retired = false; override fun close() { retired = true; super.close() } }
        val old = route.track(socket)
        val facts = listOf(DirectGatewayCandidate("10.0.0.2", 8443))
        route.updateCandidates(facts)
        assertTrue(old.isEmpty())
        assertEquals(8443, route.endpoints.single().port)
        route.connected(route.endpoints.single())
        assertEquals(GatewayConnectionPath.LOCAL, route.connectionPath.value)
        route.updateCandidates(emptyList())
        assertTrue(route.endpoints.isEmpty())
        route.retire()
        assertTrue(socket.retired)
        route.connected(InetSocketAddress("127.0.0.1", 1))
        assertEquals(GatewayConnectionPath.RECONNECTING, route.connectionPath.value)
        assertThrows(IllegalStateException::class.java) { route.updateCandidates(facts) }
        assertThrows(IllegalStateException::class.java) { route.track(Socket()) }
        route.release(socket)
        route.retire()
        for (bad in listOf("https://localhost", "https://127.0.0.1", "https://[fd00::1]", "https://-bad.example.test", "https://bad_.example.test", "https://" + "x".repeat(64) + ".example.test")) {
            assertThrows(IllegalArgumentException::class.java) { DirectGatewayRoute.maintained(bad, emptyList()) }
        }
        assertThrows(IllegalArgumentException::class.java) { DirectGatewayRoute.maintained(origin, listOf(DirectGatewayCandidate("127.0.0.1", 443))) }
    }

    @Test fun `only bounded private IP literals and valid ports are candidates`() {
        for (address in listOf("10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.2", "fc00::1", "FDFF::abcd")) {
            assertNotNull(DirectGatewayCandidate(address, 65535).validatedAddress())
        }
        for (address in listOf("", "1", "10.0.0", "10.0.0.256", "010.0.0.1", "172.15.0.1", "172.32.0.1", "192.169.0.1",
            "192.0.2.1", "8.8.8.8", "127.0.0.1", "0.0.0.0", "gateway.example.test", "https://10.0.0.1", "10.0.0.1/path",
            "::1", "fe80::1", "2001:db8::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:a00:1", "fd00:::1", "fd00::1%en0", "a".repeat(46))) {
            assertThrows(address, Exception::class.java) { DirectGatewayCandidate(address, 7600).validatedAddress() }
        }
        for (port in listOf(-1, 0, 65536, Int.MAX_VALUE)) {
            assertThrows(IllegalArgumentException::class.java) { DirectGatewayCandidate("10.0.0.1", port).validatedAddress() }
        }
        assertTrue(DirectGatewayCandidate("127.0.0.1", 1).validatedAddress(allowLoopback = true).isLoopbackAddress)
        assertTrue(DirectGatewayCandidate("::1", 1).validatedAddress(allowLoopback = true).isLoopbackAddress)
        assertThrows(IllegalArgumentException::class.java) { DirectGatewayCandidate("192.0.2.1", 1).validatedAddress(allowLoopback = true) }
    }

    @Test fun `empty route remains optional and invalid discovery cannot enable a route`() {
        assertNull(DirectGatewayRoute.create("unchanged legacy origin", emptyList()))
        val candidate = DirectGatewayCandidate("10.0.0.1", 7600)
        assertEquals("10.0.0.1", candidate.address)
        assertThrows(IllegalArgumentException::class.java) { DirectGatewayRoute.create(origin, List(9) { DirectGatewayCandidate("10.0.0.${it + 1}", 7600) }) }
        assertThrows(IllegalArgumentException::class.java) { DirectGatewayRoute.create(origin, listOf(candidate, candidate)) }
        for (url in listOf("http://gateway.example.test", "https://user:password@gateway.example.test", "https://:password@gateway.example.test", "$origin?query", "$origin#fragment", "invalid")) {
            assertThrows(IllegalArgumentException::class.java) { DirectGatewayRoute.create(url, listOf(candidate)) }
        }
        assertEquals("gateway.example.test", route().host)
        assertEquals(9443, route().port)
    }

    @Test fun `LAN route selection does not resolve or contact relay and preserves each candidate port`() {
        val attempts = mutableListOf<Pair<InetSocketAddress, Int>>()
        val value = route()
        val factory = DirectGatewaySocketFactory(value, probe = { endpoint, timeout ->
            attempts += endpoint to timeout
            if (endpoint.port == 7600) throw ConnectException("synthetic refused")
        }, resolve = { error("Relay DNS called despite reachable LAN") })
        assertEquals(8443, factory.select(42).port)
        assertEquals(listOf(7600, 8443), attempts.map { it.first.port })
        assertEquals(listOf(42, 42), attempts.map { it.second })
        assertEquals("10.0.0.1", factory.dns.lookup("GATEWAY.EXAMPLE.TEST").single().hostAddress)
        assertThrows(UnknownHostException::class.java) { factory.dns.lookup("another-gateway.example.test") }
    }

    @Test fun `only explicit TCP connectivity failures can choose a relay route`() {
        for (failure in listOf(ConnectException(), SocketTimeoutException(), NoRouteToHostException(), UnknownHostException(), SocketException())) {
            val attempts = mutableListOf<InetSocketAddress>()
            val factory = DirectGatewaySocketFactory(route(), probe = { endpoint, timeout ->
                // A home-network hint is checked briefly; the relay gets the time mobile data needs.
                assertEquals(if (endpoint.port == 9443) 10_000 else 150, timeout)
                attempts += endpoint
                if (endpoint.port != 9443) throw failure
            }, resolve = { name -> assertEquals("gateway.example.test", name); listOf(InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, 1))) }, nanoTime = { 0 })
            assertEquals(9443, factory.select(0).port)
            assertEquals(3, attempts.size)
        }
        for (failure in listOf(SSLHandshakeException("synthetic TLS"), SSLPeerUnverifiedException("synthetic key"), IOException("unknown failure"))) {
            var attempts = 0
            val factory = DirectGatewaySocketFactory(route(), probe = { _, _ -> attempts++; throw failure }, resolve = { error("TLS error triggered relay fallback") })
            assertSame(failure, assertThrows(IOException::class.java) { factory.select(1000) })
            assertEquals(1, attempts)
        }
    }

    @Test fun `a relay that is slow to answer is still reached`() {
        val relay = InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, 1))
        // Mobile data, or a radio waking from idle: the connect needs about 400 ms.
        val slow = { endpoint: InetSocketAddress, timeout: Int ->
            if (endpoint.port != 9443) throw ConnectException("synthetic away from home")
            if (timeout < 400) throw SocketTimeoutException("synthetic: connect needs 400 ms, was given $timeout")
        }
        for (timeout in listOf(0, 15_000)) {
            val factory = DirectGatewaySocketFactory(route(), probe = slow, resolve = { listOf(relay) })
            assertEquals(InetSocketAddress(relay, 9443), factory.select(timeout))
        }
        // With several relay addresses each still gets far more than a mobile round trip.
        val budgets = mutableListOf<Int>()
        val four = DirectGatewaySocketFactory(route(), probe = { endpoint, timeout ->
            if (endpoint.port != 9443) throw ConnectException()
            budgets += timeout
            if (budgets.size < 4) throw SocketTimeoutException()
        }, resolve = { List(4) { InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, (it + 1).toByte())) } }, nanoTime = { 0 })
        assertEquals(9443, four.select(0).port)
        assertEquals(listOf(2_500, 3_333, 5_000, 10_000), budgets)
        // The caller's own connect timeout still caps a single address.
        val capped = mutableListOf<Int>()
        DirectGatewaySocketFactory(route(), probe = { endpoint, timeout -> if (endpoint.port != 9443) throw ConnectException() else capped += timeout },
            resolve = { listOf(relay) }).select(2_000)
        assertEquals(listOf(2_000), capped)
    }

    @Test fun `the whole relay attempt stays bounded`() {
        var now = 0L
        var attempts = 0
        val factory = DirectGatewaySocketFactory(route(), probe = { endpoint, timeout ->
            if (endpoint.port != 9443) throw ConnectException()
            attempts++
            now += timeout * 1_000_000L
            throw SocketTimeoutException()
        }, resolve = { List(4) { InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, (it + 1).toByte())) } }, nanoTime = { now })
        assertThrows(NoRouteToHostException::class.java) { factory.select(0) }
        assertEquals(4, attempts)
        assertEquals(10_000_000_000L, now)
    }

    @Test fun `a device found away skips the hints until a check or a network change says otherwise`() {
        var now = 0L
        val value = route()
        val relay = InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, 1))
        val checked = mutableListOf<Int>()
        var home = false
        val factory = DirectGatewaySocketFactory(value, probe = { _, _ -> }, resolve = { listOf(relay) },
            authenticate = { target, _ -> checked += target.port; home }, nanoTime = { now })
        // Away: both hints are tried once, then the relay.
        assertEquals(9443, factory.select(1000).port)
        assertEquals(listOf(7600, 8443), checked)
        // The next connections go straight to the relay.
        repeat(3) { assertEquals(9443, factory.select(1000).port) }
        assertEquals(listOf(7600, 8443), checked)
        // A network change asks again at once; still away.
        value.hintsMayBeReachable()
        assertEquals(9443, factory.select(1000).port)
        assertEquals(listOf(7600, 8443, 7600, 8443), checked)
        // Coming home: within one promotion interval the hints are tried again without any signal.
        home = true
        now += DirectGatewayRoute.AWAY_MEMORY_NANOS - 1
        assertEquals(9443, factory.select(1000).port)
        now += 1
        assertEquals(7600, factory.select(1000).port)
        // At home nothing is skipped.
        assertEquals(7600, factory.select(1000).port)
        // New hints from the gateway have not been tried, so they are not skipped either.
        home = false
        assertEquals(9443, factory.select(1000).port)
        value.updateCandidates(listOf(DirectGatewayCandidate("10.0.0.9", 7700)))
        home = true
        assertEquals(7700, factory.select(1000).port)
    }

    @Test fun `unexpected errors at relay TCP selection remain terminal too`() {
        for (failure in listOf(SSLHandshakeException("synthetic TLS"), IOException("synthetic protocol"))) {
            var attempts = 0
            val factory = DirectGatewaySocketFactory(route(), probe = { endpoint, _ ->
                attempts++
                if (endpoint.port != 9443) throw ConnectException("synthetic offline")
                throw failure
            }, resolve = { listOf(InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, 1))) })
            assertSame(failure, assertThrows(IOException::class.java) { factory.select(150) })
            assertEquals(3, attempts)
        }
        assertThrows(IllegalArgumentException::class.java) { PinnedOkHttp.build(spkiFingerprint = "malformed") }
    }

    @Test fun `all-offline attempts stay bounded and report a connectivity error`() {
        var attempts = 0
        val factory = DirectGatewaySocketFactory(route(), probe = { _, _ -> attempts++; throw SocketTimeoutException() },
            resolve = { List(20) { InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, (it + 1).toByte())) } })
        assertThrows(NoRouteToHostException::class.java) { factory.select(-1) }
        assertEquals(6, attempts)
        val empty = DirectGatewaySocketFactory(route(), probe = { _, _ -> throw ConnectException() }, resolve = { emptyList() })
        assertThrows(NoRouteToHostException::class.java) { empty.select(150) }
    }

    @Test fun `all socket entry points preserve canonical scope while dialing the candidate port`() {
        ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { endpoint ->
            val local = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
            val value = DirectGatewayRoute.createValidated(origin, listOf(DirectGatewayCandidate("127.0.0.1", endpoint.localPort)), true)!!
            val factory = DirectGatewaySocketFactory(value)
            val named = InetAddress.getByAddress(value.host, local.address)
            val sockets = listOf(
                factory.createSocket(value.host, value.port), factory.createSocket(named, value.port),
                factory.createSocket(value.host, value.port, local, 0), factory.createSocket(named, value.port, local, 0),
                factory.createSocket().apply { connect(InetSocketAddress.createUnresolved(value.host, value.port), 200) },
            )
            for (socket in sockets) { assertEquals(endpoint.localPort, socket.port); socket.close() }
            factory.createSocket().use { socket ->
                assertThrows(SSLPeerUnverifiedException::class.java) { socket.connect(InetSocketAddress.createUnresolved("other.example.test", value.port), 200) }
                assertThrows(SSLPeerUnverifiedException::class.java) { socket.connect(InetSocketAddress.createUnresolved(value.host, 1), 200) }
                assertThrows(SSLPeerUnverifiedException::class.java) { socket.connect(object : SocketAddress() {}, 200) }
            }
            val ipv6 = DirectGatewayRoute.createValidated("https://[fd00::1]:9443", listOf(DirectGatewayCandidate("127.0.0.1", endpoint.localPort)), true)!!
            DirectGatewaySocketFactory(ipv6).createSocket().use { socket ->
                socket.connect(InetSocketAddress(InetAddress.getByName("fd00::1"), 9443), 200)
                assertEquals(endpoint.localPort, socket.port)
            }
            DirectGatewaySocketFactory(ipv6).createSocket().use { socket ->
                assertThrows(SSLPeerUnverifiedException::class.java) { socket.connect(InetSocketAddress.createUnresolved("other.example.test", 9443), 200) }
                assertThrows(SSLPeerUnverifiedException::class.java) { socket.connect(InetSocketAddress(InetAddress.getByName("fd00::2"), 9443), 200) }
            }
            val unavailable = ServerSocket(0, 1, local).use { it.localPort }
            val offline = DirectGatewayRoute.createValidated("https://localhost:${endpoint.localPort}", listOf(DirectGatewayCandidate("127.0.0.1", unavailable)), true)!!
            DirectGatewaySocketFactory(offline).createSocket("localhost", endpoint.localPort).use { socket -> assertEquals(endpoint.localPort, socket.port) }
        }
    }

    @Test fun `route activation requires strict trust and never changes conventional clients`() {
        val key = "a".repeat(64)
        assertThrows(IllegalArgumentException::class.java) { PinnedOkHttp.build(directRoute = route()) }
        assertThrows(IllegalArgumentException::class.java) { PinnedOkHttp.build(key, directRoute = route()) }
        assertThrows(IllegalArgumentException::class.java) { PinnedOkHttp.build(key, host = "gateway.example.test", requireCertificateValidity = true, directRoute = route()) }
        assertThrows(IllegalArgumentException::class.java) { PinnedOkHttp.build(spkiFingerprint = key, host = "other.example.test", directRoute = route()) }
        val routed = PinnedOkHttp.build(spkiFingerprint = key, directRoute = route())
        assertFalse(routed.retryOnConnectionFailure)
        assertEquals(Proxy.NO_PROXY, routed.proxy)
        assertTrue(routed.socketFactory is DirectGatewaySocketFactory)
        assertTrue(PinnedOkHttp.build().retryOnConnectionFailure)
        assertNull(PinnedOkHttp.build().proxy)
        val exact = PinnedOkHttp.build(key, requireCertificateValidity = true, directRoute = route())
        assertFalse(exact.retryOnConnectionFailure)
    }
}

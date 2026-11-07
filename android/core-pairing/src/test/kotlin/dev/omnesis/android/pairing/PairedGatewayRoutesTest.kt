// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import java.net.ConnectException
import javax.net.ssl.SSLHandshakeException

class PairedGatewayRoutesTest {
    private val bundle = PairingCredentialBundle("https://gateway.example.test", "device-token", "generation", "local",
        "device", "Gateway", listOf("read"), "pinned-key-strict", spkiFingerprint = "ab".repeat(32))
    private val candidates = listOf(DirectGatewayCandidate("10.0.0.2", 8443))
    private fun service() = PairingService(InMemoryStore().apply { set("gateway.credential.v1", OmnesisJson.encodeToString(bundle)) })

    @Test fun `refresh acquires and clears hints without replacing identity or live stream owners`(): Unit = runBlocking {
        val service = service()
        val original = service.current()!!
        var facts = candidates
        val updates = mutableListOf<Pairing>()
        val routes = PairedGatewayRoutes(original, service, { assertEquals(original, it); facts }, { updates += it })
        val http = routes.http
        val streaming = routes.streaming
        val socket = routes.socket
        assertNotNull(http); assertNotSame(http, streaming); assertNotSame(streaming, socket)
        assertTrue(routes.refresh())
        assertEquals(original.copy(directCandidates = candidates), service.current())
        facts = emptyList()
        assertTrue(routes.refresh())
        assertEquals(original, service.current())
        assertSame(http, routes.http); assertSame(streaming, routes.streaming); assertSame(socket, routes.socket)
        assertEquals(2, updates.size)
        routes.retire()
        assertFalse(routes.refresh())
        routes.retire()
    }

    @Test fun `temporary unavailable metadata retains hints while explicit trust and malformed refusals propagate`(): Unit = runBlocking {
        val service = service()
        val original = service.current()!!
        service.updateDirectCandidates(original, candidates)
        var error: Exception = ConnectException("offline")
        val routes = PairedGatewayRoutes(original, service, { throw error }, { fail("Refused facts applied") })
        assertFalse(routes.refresh())
        for (failure in listOf(SSLHandshakeException("key refusal"), CloudPairingException(401), IllegalArgumentException("malformed"))) {
            error = failure
            try { routes.refresh(); fail("Terminal metadata accepted") } catch (actual: Exception) { assertSame(failure, actual) }
            assertEquals(candidates, service.current()!!.directCandidates)
        }
        routes.retire()
    }

    @Test fun `unpair cancellation and retired leases fence delayed metadata callbacks`(): Unit = runBlocking {
        suspend fun delayed(retire: Boolean, cancel: Boolean) {
            val service = service()
            val expected = service.current()!!
            val gate = CompletableDeferred<List<DirectGatewayCandidate>>()
            val started = CompletableDeferred<Unit>()
            var applied = false
            val routes = PairedGatewayRoutes(expected, service, { started.complete(Unit); gate.await() }, { applied = true })
            val work = async { routes.refresh() }
            started.await()
            if (retire) routes.retire() else service.unpair()
            if (cancel) work.cancel()
            gate.complete(candidates)
            try { work.await() } catch (_: kotlinx.coroutines.CancellationException) { assertTrue(cancel) }
            assertFalse(applied)
            if (!retire) assertNull(service.current())
            routes.retire()
        }
        delayed(false, false)
        delayed(true, false)
        delayed(false, true)
    }

    @Test fun `strict direct IP gateways keep ordinary transport when no optional cloud route exists`(): Unit = runBlocking {
        val directBundle = bundle.copy(url = "https://127.0.0.1")
        val service = PairingService(InMemoryStore().apply { set("gateway.credential.v1", OmnesisJson.encodeToString(directBundle)) })
        val expected = service.current()!!
        var updates = 0
        val routes = PairedGatewayRoutes(expected, service, { emptyList() }, { assertEquals(expected, it); updates++ })
        assertNull(routes.http); assertNull(routes.streaming); assertNull(routes.socket)
        assertTrue(routes.refresh())
        assertEquals(1, updates)
        assertEquals(expected, service.current())
        routes.retire()
    }

    @Test fun `ordinary direct pairing never acquires an optional route`(): Unit = runBlocking {
        val service = service()
        val expected = service.current()!!.copy(tlsMode = PairingTlsMode.SYSTEM)
        val routes = PairedGatewayRoutes(expected, service, { emptyList() }, { fail("Other authority applied") })
        assertNull(routes.http); assertNull(routes.streaming); assertNull(routes.socket)
        assertFalse(routes.refresh())
        routes.retire()
    }
}

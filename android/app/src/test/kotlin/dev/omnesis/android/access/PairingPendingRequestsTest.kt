// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.access

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.transport.dto.TailscaleJoinApproving
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import java.net.ConnectException
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The main screen's banner for devices that wait for approval, by signing in or through Tailscale. */
@OptIn(ExperimentalCoroutinesApi::class)
class PairingPendingRequestsTest {
    private var now = 1_000L
    private fun request(id: String, status: String = "pending", expiresAt: Long = 5_000) =
        GatewayPairingApprovalRequest(id, "android", "Test phone", status, "465 774", expiresAt)

    private fun join(id: String, expiresAt: Long = 5_000) = TailscaleJoinRequest(
        id = id, name = "Maya's studio Mac", kind = "collector", machine = "studio-mac", os = "macOS", login = "maya@example.com",
        requestedAt = Instant.ofEpochMilli(0).toString(), expiresAt = Instant.ofEpochMilli(expiresAt).toString(),
    )

    /** A gateway's Tailscale join list: what [waiting] holds, or [failure]; [hold] delays the next answer. */
    private class Joins(var waiting: List<TailscaleJoinRequest> = emptyList()) : TailscaleJoinApproving {
        var failure: Exception? = null
        var reads = 0
        var hold: CompletableDeferred<Unit>? = null
        override suspend fun tailscaleJoinRequests(): List<TailscaleJoinRequest> {
            reads++
            val answer = waiting
            hold?.await()
            failure?.let { throw it }
            return answer
        }
        override suspend fun decideTailscaleJoin(id: String, approve: Boolean) = "approved"
    }

    @Test fun `one banner whatever the count, with the count in its words`() {
        val requests = PairingPendingRequests { now }
        assertNull(requests.state.value.banner)
        requests.replace(listOf(request("a")))
        assertEquals("A new device is waiting for your OK.", requests.state.value.banner?.text)
        requests.replace(listOf(request("a"), request("b"), request("c")))
        assertEquals(PairingRequestBannerOffer(3), requests.state.value.banner)
        assertEquals("3 new devices are waiting for your OK.", requests.state.value.banner?.text)
        assertEquals("Review", PairingRequestBannerOffer.ACTION)
    }

    @Test fun `it disappears when nothing waits any more`() {
        val requests = PairingPendingRequests { now }
        requests.replace(listOf(request("a"), request("b", status = "approved"), request("c", expiresAt = 2_000)))
        assertEquals(2, requests.state.value.banner?.count)
        // One runs out while the app stays in front, with no new read.
        now = 2_000
        assertEquals(1, requests.state.value.banner?.count)
        requests.replace(emptyList())
        assertNull(requests.state.value.banner)
    }

    @Test fun `dismissing hides it for the set waiting now and a new request brings it back`() {
        val requests = PairingPendingRequests { now }
        requests.replace(listOf(request("a")))
        requests.dismiss()
        assertNull(requests.state.value.banner)
        requests.replace(listOf(request("a")))
        assertNull(requests.state.value.banner)
        requests.replace(listOf(request("a"), request("b")))
        assertEquals(2, requests.state.value.banner?.count)
    }

    @Test fun `Tailscale joins count in the same banner as sign-in requests`() = runTest {
        val requests = PairingPendingRequests { now }
        requests.refreshTailscale(Joins(listOf(join("a"))))
        assertEquals("A new device is waiting for your OK.", requests.state.value.banner?.text)
        // The same id in both kinds is two requests.
        requests.replace(listOf(request("a")))
        assertEquals(2, requests.state.value.banner?.count)
        // A join that runs out leaves the banner with no new read.
        requests.tailscaleListed(listOf(join("a"), join("b", expiresAt = 2_000)))
        assertEquals(3, requests.state.value.banner?.count)
        now = 2_000
        assertEquals(2, requests.state.value.banner?.count)
    }

    @Test fun `dismissing covers both kinds and a new Tailscale join brings it back`() {
        val requests = PairingPendingRequests { now }
        requests.replace(listOf(request("a")))
        requests.tailscaleListed(listOf(join("j1")))
        requests.dismiss()
        assertNull(requests.state.value.banner)
        requests.tailscaleListed(listOf(join("j1"), join("j2")))
        assertEquals(3, requests.state.value.banner?.count)
    }

    @Test fun `a gateway that answers 404 shows nothing waiting`() = runTest {
        val requests = PairingPendingRequests { now }
        requests.tailscaleListed(listOf(join("a")))
        requests.refreshTailscale(Joins().apply { failure = GatewayException.NotFound("Not Found") })
        assertTrue(requests.state.value.tailscale.isEmpty())
        assertNull(requests.state.value.banner)
    }

    @Test fun `the main screen polls with cloud connectivity or a gateway that advertises Tailscale joins`() {
        assertFalse(PairingPendingRequests.polls(cloudEnabled = false, tailscaleEmbed = false))
        assertTrue(PairingPendingRequests.polls(cloudEnabled = false, tailscaleEmbed = true))
        assertTrue(PairingPendingRequests.polls(cloudEnabled = true, tailscaleEmbed = false))
    }

    @Test fun `a phone that may not review Tailscale joins never asks and holds none`() = runTest {
        val requests = PairingPendingRequests { now }
        requests.tailscaleListed(listOf(join("a")))
        requests.refreshTailscale(null)
        assertTrue(requests.state.value.tailscale.isEmpty())
        assertNull(requests.state.value.banner)
    }

    @Test fun `a failed Tailscale read shows nothing rather than a request that may be gone`() = runTest {
        val requests = PairingPendingRequests { now }
        val gateway = Joins(listOf(join("a")))
        requests.refreshTailscale(gateway)
        gateway.failure = GatewayException.Network(ConnectException("unreachable"))
        requests.refreshTailscale(gateway)
        assertNull(requests.state.value.banner)
        // Not a 404: the gateway is asked again.
        gateway.failure = null
        requests.refreshTailscale(gateway)
        assertEquals(3, gateway.reads)
        assertEquals(1, requests.state.value.banner?.count)
    }

    @Test fun `what the sheet listed wins over a read already under way`() = runTest {
        val requests = PairingPendingRequests { now }
        val gateway = Joins(listOf(join("a"), join("b"))).apply { hold = CompletableDeferred() }
        val read = launch { requests.refreshTailscale(gateway) }
        runCurrent()
        requests.tailscaleListed(listOf(join("b")))
        gateway.hold?.complete(Unit)
        read.join()
        assertEquals(listOf(join("b")), requests.state.value.tailscale)
    }

    @Test fun `only an administrator's phone in a build with the Omnesis account asks`() {
        assertTrue(PairingPendingRequests.eligible(cloudEnabled = true, scopes = listOf("read", "admin")))
        assertFalse(PairingPendingRequests.eligible(cloudEnabled = true, scopes = listOf("read")))
        assertFalse(PairingPendingRequests.eligible(cloudEnabled = false, scopes = listOf("admin")))
        assertFalse(PairingPendingRequests.eligible(cloudEnabled = true, scopes = null))
    }

    @Test fun `a pairing notification asks for a fresh read`() {
        val before = PairingPendingRequests.refreshRequests.value
        PairingPendingRequests.requestRefresh()
        assertEquals(before + 1, PairingPendingRequests.refreshRequests.value)
    }
}

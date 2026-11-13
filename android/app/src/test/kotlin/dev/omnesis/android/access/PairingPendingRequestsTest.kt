// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.access

import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The main screen's banner for devices that signed in and wait for approval. */
class PairingPendingRequestsTest {
    private var now = 1_000L
    private fun request(id: String, status: String = "pending", expiresAt: Long = 5_000) =
        GatewayPairingApprovalRequest(id, "android", "Test phone", status, "465 774", expiresAt)

    @Test fun `one banner whatever the count, with the count in its words`() {
        val requests = PairingPendingRequests { now }
        assertNull(requests.state.value.banner)
        requests.replace(listOf(request("a")))
        assertEquals("A device is waiting for your approval to pair to this gateway.", requests.state.value.banner?.text)
        requests.replace(listOf(request("a"), request("b"), request("c")))
        assertEquals(PairingRequestBannerOffer(3), requests.state.value.banner)
        assertEquals("3 devices are waiting for your approval to pair to this gateway.", requests.state.value.banner?.text)
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import dev.omnesis.android.pairing.GatewayPairingApprovalController
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which approvals the Devices screen offers and lists, and how a Tailscale join request reads. */
class DeviceApprovalsLogicTest {
    private val now = Instant.parse("2026-11-14T18:05:00.000Z").toEpochMilli()
    private val studio = TailscaleJoinRequest(
        id = "join-1", name = "Maya's studio Mac", kind = "collector", machine = "studio-mac", os = "macOS",
        login = "maya@example.com", requestedAt = "2026-11-14T18:02:00.000Z", expiresAt = "2026-11-14T18:12:00.000Z",
    )
    private val signIns = object : GatewayPairingApproving {
        override suspend fun pairingApprovalRequests() = emptyList<GatewayPairingApprovalRequest>()
        override suspend fun decidePairingApproval(requestId: String, approve: Boolean, trustSignIn: Boolean) = Unit
    }

    @Test fun `the Devices entry appears for sign-in requests or a gateway that serves Tailscale joins`() {
        assertTrue(deviceApprovalsOffered(signIns, tailscaleAvailable = null))
        assertTrue(deviceApprovalsOffered(signIns, tailscaleAvailable = false))
        assertTrue(deviceApprovalsOffered(null, tailscaleAvailable = true))
    }

    @Test fun `without sign-in requests a gateway that answered 404, or has not answered, offers no entry`() {
        assertFalse(deviceApprovalsOffered(null, tailscaleAvailable = false))
        assertFalse(deviceApprovalsOffered(null, tailscaleAvailable = null))
    }

    @Test fun `beside sign-in requests, Tailscale joins show only once the gateway answered that it serves them`() {
        val cloud = GatewayPairingApprovalController.State()
        assertNull(shownTailscaleJoins(cloud, null))
        assertNull(shownTailscaleJoins(cloud, TailscaleJoinRequestsViewModel.State(loading = true)))
        assertNull(shownTailscaleJoins(cloud, TailscaleJoinRequestsViewModel.State(loaded = true, available = false)))
        val served = TailscaleJoinRequestsViewModel.State(requests = listOf(studio), loaded = true, available = true)
        assertSame(served, shownTailscaleJoins(cloud, served))
    }

    @Test fun `alone, Tailscale joins show from the first read so its loading and errors are seen`() {
        val loading = TailscaleJoinRequestsViewModel.State(loading = true)
        assertSame(loading, shownTailscaleJoins(null, loading))
        assertNull(shownTailscaleJoins(null, TailscaleJoinRequestsViewModel.State(loaded = true, available = false)))
    }

    @Test fun `a join request says what it is, that it asked through Tailscale, and as whom`() {
        assertEquals("Collector · via Tailscale · maya@example.com", tailscaleJoinViaLine(studio))
        assertEquals("Via Tailscale", tailscaleJoinViaLine(studio.copy(kind = null, login = null)))
        assertEquals("Collector · via Tailscale", tailscaleJoinViaLine(studio.copy(login = " ")))
    }

    @Test fun `the machine line uses whatever the gateway knows`() {
        assertEquals("On studio-mac (macOS)", tailscaleJoinMachineLine(studio))
        assertEquals("On studio-mac", tailscaleJoinMachineLine(studio.copy(os = null)))
        assertEquals("Linux", tailscaleJoinMachineLine(studio.copy(machine = "", os = "Linux")))
        assertNull(tailscaleJoinMachineLine(studio.copy(machine = null, os = null)))
    }

    @Test fun `the timing line says when it asked and until when`() {
        assertEquals("Asked 3m ago · expires in 7 min", tailscaleJoinTimingLine(studio, now))
        assertEquals("Asked 9m ago · expires in under a minute", tailscaleJoinTimingLine(studio, now + 6 * 60_000 + 30_000))
        assertEquals("Expired", tailscaleJoinTimingLine(studio, now + 7 * 60_000))
        assertEquals("Asked", tailscaleJoinTimingLine(studio.copy(requestedAt = "soon", expiresAt = "later"), now))
    }

    @Test fun `a time that can't be read never counts as run out`() {
        assertFalse(studio.copy(expiresAt = "later").expired(now))
        assertTrue(studio.expired(Instant.parse(studio.expiresAt).toEpochMilli()))
    }
}

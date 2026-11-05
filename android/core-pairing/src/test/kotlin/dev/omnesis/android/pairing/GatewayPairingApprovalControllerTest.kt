// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class GatewayPairingApprovalControllerTest {
    private fun request(kind: String = "ios", code: String = "AAAA-BBBB-CCCC-DDDD-EEEE", status: String = "pending", expiry: Long = 1_100_000) =
        GatewayPairingApprovalRequest("00000000-0000-4000-8000-000000000901", kind, "Test phone", status, code, expiry)
    private fun createController() = GatewayPairingApprovalController { 1_000_000 }

    @Test fun `only full local comparison of same pending request permits approval`() = runTest {
        val row = request()
        val client = Client(listOf(row))
        val model = createController()
        model.refresh(client)
        assertEquals(listOf(row), model.state.value.requests)
        assertFalse(model.canApprove(row))
        model.decide(row, true, client)
        assertTrue(client.decisions.isEmpty())
        model.setCompared("unknown", true)
        assertTrue(model.state.value.compared.isEmpty())
        model.setCompared(row.requestId, true)
        assertTrue(model.canApprove(row))
        model.setCompared(row.requestId, false)
        assertFalse(model.canApprove(row))
        model.setCompared(row.requestId, true)
        model.decide(row, true, client)
        assertEquals(listOf(true), client.decisions)
        assertTrue(model.state.value.requests.isEmpty())
        assertTrue(model.state.value.compared.isEmpty())
    }

    @Test fun `rejection needs no comparison but still needs current unexpired request`() = runTest {
        val row = request()
        val client = Client(listOf(row))
        val model = createController()
        model.refresh(client)
        model.decide(row.copy(requestId = "other"), false, client)
        assertTrue(client.decisions.isEmpty())
        model.decide(row, false, client)
        assertEquals(listOf(false), client.decisions)
        for (old in listOf(request(expiry = 1_000_000), request(status = "approved"), request(status = "denied"), request(status = "approving"))) {
            val owner = Client(listOf(old))
            val controller = createController()
            controller.refresh(owner)
            controller.setCompared(old.requestId, true)
            assertFalse(controller.canApprove(old))
            controller.decide(old, false, owner)
            assertTrue(owner.decisions.isEmpty())
        }
    }

    @Test fun `list refresh keeps exact comparison and drops replaced code`() = runTest {
        val row = request()
        val client = Client(listOf(row))
        val model = createController()
        model.refresh(client)
        model.setCompared(row.requestId, true)
        model.refresh(client)
        assertTrue(model.canApprove(row))
        client.rows = listOf(row.copy(requestId = "00000000-0000-4000-8000-000000000902"))
        model.refresh(client)
        assertFalse(model.canApprove(row))
        client.rows = listOf(row)
        model.refresh(client)
        model.setCompared(row.requestId, true)
        val changed = request(code = "1111-2222-3333-4444-5555")
        client.rows = listOf(changed)
        model.refresh(client)
        assertFalse(model.canApprove(changed))
        model.decide(row, true, client)
        assertTrue(client.decisions.isEmpty())
    }

    @Test fun `invalid lists never become visible while all provider surface kinds remain valid`() = runTest {
        val invalid = listOf(request().copy(requestId = "short"), request(kind = "unknown"), request().copy(name = ""),
            request().copy(name = "x".repeat(81)), request(status = "unknown"), request(expiry = 0), request(code = "BAD"))
        for (rows in invalid.map { listOf(it) } + listOf(listOf(request(), request()), List(129) { request() })) {
            val model = createController()
            model.refresh(Client(rows))
            assertTrue(model.state.value.requests.isEmpty())
            assertNotNull(model.state.value.error)
            assertFalse(model.state.value.busy)
        }
        for (kind in listOf("ios", "android", "collector", "cli", "portal")) {
            val model = createController()
            model.refresh(Client(listOf(request(kind))))
            assertNull(model.state.value.error)
        }
        val defaultClock = GatewayPairingApprovalController()
        val row = request(expiry = 1)
        defaultClock.refresh(Client(listOf(row)))
        defaultClock.setCompared(row.requestId, true)
        assertFalse(defaultClock.canApprove(row))
    }

    @Test fun `network failures preserve comparison for explicit retry without implying approval`() = runTest {
        val row = request()
        val client = Client(listOf(row))
        val model = createController()
        client.failure = true
        model.refresh(client)
        assertNotNull(model.state.value.error)
        client.failure = false
        model.refresh(client)
        assertNull(model.state.value.error)
        model.setCompared(row.requestId, true)
        client.failure = true
        model.decide(row, true, client)
        assertNotNull(model.state.value.error)
        assertTrue(model.canApprove(row))
        client.failure = false
        model.decide(row, true, client)
        assertNull(model.state.value.error)
        assertTrue(model.state.value.requests.isEmpty())
    }

    @Test fun `stop generation fences late success failure and cancellation and drops duplicate submissions`() = runTest {
        for (decision in listOf(false, true)) for (failure in listOf(false, true)) {
            val row = request()
            val client = Client(listOf(row))
            val model = createController()
            if (decision) { model.refresh(client); model.setCompared(row.requestId, true) }
            client.gate = CompletableDeferred()
            val pending = launch { if (decision) model.decide(row, true, client) else model.refresh(client) }
            runCurrent()
            assertTrue(model.state.value.busy)
            assertFalse(model.canApprove(row))
            model.refresh(client)
            model.decide(row, false, client)
            model.setCompared(row.requestId, false)
            model.stop()
            client.failure = failure
            client.gate!!.complete(Unit)
            pending.join()
            assertEquals(GatewayPairingApprovalController.State(), model.state.value)
        }
        for (decision in listOf(false, true)) {
            val row = request()
            val client = Client(listOf(row))
            val model = createController()
            if (decision) { model.refresh(client); model.setCompared(row.requestId, true) }
            client.cancelled = true
            try { if (decision) model.decide(row, true, client) else model.refresh(client); fail("Cancellation swallowed") }
            catch (_: CancellationException) { }
            assertFalse(model.state.value.busy)
            assertNull(model.state.value.error)
        }
    }

    private class Client(var rows: List<GatewayPairingApprovalRequest>) : GatewayPairingApproving {
        var failure = false
        var cancelled = false
        var gate: CompletableDeferred<Unit>? = null
        val decisions = mutableListOf<Boolean>()
        private suspend fun waitForResult() {
            gate?.await()
            if (cancelled) throw CancellationException("synthetic cancellation")
            if (failure) throw java.io.IOException("synthetic offline")
        }
        override suspend fun pairingApprovalRequests(): List<GatewayPairingApprovalRequest> { waitForResult(); return rows }
        override suspend fun decidePairingApproval(requestId: String, approve: Boolean) { decisions += approve; waitForResult() }
    }
}

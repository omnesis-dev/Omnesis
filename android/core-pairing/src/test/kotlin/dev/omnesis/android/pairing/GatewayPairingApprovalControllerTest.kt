// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.transport.dto.GatewayPasskeyCeremony
import dev.omnesis.android.transport.dto.GatewayPasskeyLocation
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class GatewayPairingApprovalControllerTest {
    private fun request(kind: String = "ios", code: String = "465 774", status: String = "pending", expiry: Long = 1_100_000) =
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

    @Test fun `only requests still waiting are listed`() = runTest {
        val approved = request(status = "approved").copy(requestId = "00000000-0000-4000-8000-000000000902")
        val denied = request(status = "denied").copy(requestId = "00000000-0000-4000-8000-000000000903")
        val first = request()
        val second = request().copy(requestId = "00000000-0000-4000-8000-000000000904")
        val model = createController()
        model.refresh(Client(listOf(approved, first, denied, second)))
        assertEquals(listOf(first, second), model.state.value.requests)
    }

    @Test fun `one explicit approval confirms exactly the current displayed request`() = runTest {
        val row = request()
        val client = Client(listOf(row))
        val model = createController()
        model.refresh(client)
        model.confirmAndApprove(row.copy(verificationCode = "081 434"), client)
        assertTrue(client.decisions.isEmpty())
        model.confirmAndApprove(row, client)
        model.confirmAndApprove(row, client)
        assertEquals(listOf(true), client.decisions)
        for (old in listOf(request(expiry = 1_000_000), request(status = "denied"))) {
            val other = Client(listOf(old))
            val controller = createController()
            controller.refresh(other)
            controller.confirmAndApprove(old, other)
            assertTrue(other.decisions.isEmpty())
        }
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
        val changed = request(code = "081 434")
        client.rows = listOf(changed)
        model.refresh(client)
        assertFalse(model.canApprove(changed))
        model.decide(row, true, client)
        assertTrue(client.decisions.isEmpty())
    }

    @Test fun `invalid lists never become visible while all provider surface kinds remain valid`() = runTest {
        val invalid = listOf(request().copy(requestId = "short"), request(kind = "unknown"), request().copy(name = ""),
            request().copy(name = "x".repeat(81)), request(status = "unknown"), request(expiry = 0), request(code = "BAD"), request(code = "465774"), request(code = "465-774"), request(code = "AAAA-BBBB-CCCC-DDDD-EEEE"), request(code = "4657 74"))
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

    @Test fun `trusting a sign-in travels with approval and only where the gateway offers it`(): Unit = runBlocking {
        val offered = GatewayPairingApprovalRequest("00000000-0000-4000-8000-000000000911", "android", "Test phone", "pending", "465 774", Long.MAX_VALUE, canTrustSignIn = true, signIn = "google")
        val plain = offered.copy(requestId = "00000000-0000-4000-8000-000000000912", canTrustSignIn = false)
        val client = Client(listOf(offered, plain))
        val model = GatewayPairingApprovalController()
        model.refresh(client)
        model.setTrustSignIn(plain.requestId, true)
        assertTrue(model.state.value.trustSignIn.isEmpty())
        model.setTrustSignIn(offered.requestId, true)
        model.setTrustSignIn(offered.requestId, false)
        model.setTrustSignIn(offered.requestId, true)
        model.confirmAndApprove(plain, client)
        model.confirmAndApprove(offered, client)
        assertEquals(listOf(false, true), client.trusted)
        assertTrue(model.state.value.trustSignIn.isEmpty())
    }

    @Test fun `rejecting never trusts the sign-in`(): Unit = runBlocking {
        val offered = GatewayPairingApprovalRequest("00000000-0000-4000-8000-000000000913", "android", "Test phone", "pending", "465 774", Long.MAX_VALUE, canTrustSignIn = true)
        val client = Client(listOf(offered))
        val model = GatewayPairingApprovalController()
        model.refresh(client)
        model.setTrustSignIn(offered.requestId, true)
        model.decide(offered, false, client)
        assertEquals(listOf(false), client.trusted)
    }

    private val app = "android:apk-key-hash:TPfeOsd2u2Uq8rCtF9DeGgc1m50jt6fPpDJYcUvAaCo"
    private val gatewayValue = "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw"
    private val binding = "l0NtUMoLWQPEqbViKuTTcNl21YlGfRT9uywbHtmcvzg"
    private inner class Passkeys(val answer: (String) -> String = { fakeAssertion(requestedChallenge(it), app) }) {
        val prompts = mutableListOf<String>()
        val signer = GatewayPasskeySigner("relay.example.test", app, { 1_000_000 }) { prompts += it; answer(it) }
    }
    private fun passkeyClient(row: GatewayPairingApprovalRequest, rpId: String? = "relay.example.test") = Client(listOf(row)).apply {
        location = rpId?.let { GatewayPasskeyLocation(it, "https://g-abcdefgh.relay.example.test") }
        ceremony = GatewayPasskeyCeremony("approve-request", "relay.example.test", "https://g-abcdefgh.relay.example.test", gatewayValue, binding, "s4TEruSndQL9XUX4vOZB8gLvPAjWmLWDn4hs6rqiev8", 1_100_000)
    }

    @Test fun `a passkey approval signs the gateway's ceremony for that request with the app's origin`() = runTest {
        val row = request(kind = "android").copy(canTrustSignIn = true)
        val client = passkeyClient(row)
        val passkeys = Passkeys()
        val model = GatewayPairingApprovalController(passkeys.signer) { 1_000_000 }
        model.refresh(client)
        assertTrue(model.state.value.passkeyApproval); assertTrue(model.canApproveWithPasskey(row))
        model.setTrustSignIn(row.requestId, true)
        model.confirmAndApproveWithPasskey(row, client)
        assertEquals(listOf(row.requestId), client.ceremonies)
        assertEquals(DeviceEnrollmentContract.gatewayPasskeyChallenge("approve-request", app, gatewayValue, binding), requestedChallenge(passkeys.prompts.single()))
        val (id, proof, trust) = client.passkeyApprovals.single()
        assertEquals(row.requestId, id); assertTrue(trust)
        assertEquals("gateway-passkey", proof["type"]!!.jsonPrimitive.content)
        assertEquals(gatewayValue, proof["challenge"]!!.jsonPrimitive.content)
        assertTrue(client.decisions.isEmpty())
        assertTrue(model.state.value.requests.isEmpty()); assertNull(model.state.value.error)
    }

    @Test fun `no passkey approval without a signer, a ceremony for this relay, or for a portal's request`() = runTest {
        val row = request(kind = "android")
        for ((client, signer) in listOf(passkeyClient(row) to null, passkeyClient(row, rpId = null) to Passkeys().signer,
            passkeyClient(row, rpId = "other.example.test") to Passkeys().signer, passkeyClient(row).apply { locationFails = true } to Passkeys().signer)) {
            val model = GatewayPairingApprovalController(signer) { 1_000_000 }
            model.refresh(client)
            assertNull(model.state.value.error); assertEquals(listOf(row), model.state.value.requests)
            assertFalse(model.state.value.passkeyApproval); assertFalse(model.canApproveWithPasskey(row))
            model.confirmAndApproveWithPasskey(row, client)
            assertTrue(client.ceremonies.isEmpty())
        }
        val portal = request(kind = "portal")
        val client = passkeyClient(portal)
        val model = GatewayPairingApprovalController(Passkeys().signer) { 1_000_000 }
        model.refresh(client)
        assertTrue(model.state.value.passkeyApproval); assertFalse(model.canApproveWithPasskey(portal))
        model.confirmAndApproveWithPasskey(portal, client)
        assertTrue(client.ceremonies.isEmpty())
    }

    @Test fun `a refused ceremony or assertion approves nothing and keeps the request`() = runTest {
        val row = request(kind = "cli")
        for ((client, passkeys) in listOf(
            passkeyClient(row).apply { ceremony = ceremony!!.copy(purpose = "step-up") } to Passkeys(),
            passkeyClient(row).apply { ceremony = ceremony!!.copy(rpId = "other.example.test") } to Passkeys(),
            passkeyClient(row) to Passkeys { fakeAssertion(requestedChallenge(it), "https://g-abcdefgh.relay.example.test") },
            passkeyClient(row).apply { approvalFails = true } to Passkeys(),
        )) {
            val model = GatewayPairingApprovalController(passkeys.signer) { 1_000_000 }
            model.refresh(client)
            model.confirmAndApproveWithPasskey(row, client)
            assertNotNull(model.state.value.error); assertFalse(model.state.value.busy)
            assertEquals(listOf(row), model.state.value.requests)
            assertTrue(client.decisions.isEmpty())
        }
    }

    private class Client(var rows: List<GatewayPairingApprovalRequest>) : GatewayPairingApproving {
        var failure = false
        var cancelled = false
        var gate: CompletableDeferred<Unit>? = null
        val decisions = mutableListOf<Boolean>()
        val trusted = mutableListOf<Boolean>()
        private suspend fun waitForResult() {
            gate?.await()
            if (cancelled) throw CancellationException("synthetic cancellation")
            if (failure) throw java.io.IOException("synthetic offline")
        }
        override suspend fun pairingApprovalRequests(): List<GatewayPairingApprovalRequest> { waitForResult(); return rows }
        override suspend fun decidePairingApproval(requestId: String, approve: Boolean, trustSignIn: Boolean) { decisions += approve; trusted += trustSignIn; waitForResult() }
        var location: GatewayPasskeyLocation? = null
        var locationFails = false
        var ceremony: GatewayPasskeyCeremony? = null
        var approvalFails = false
        val ceremonies = mutableListOf<String>()
        val passkeyApprovals = mutableListOf<Triple<String, JsonObject, Boolean>>()
        override suspend fun pairingPasskeyLocation(): GatewayPasskeyLocation? { if (locationFails) throw java.io.IOException("synthetic offline"); return location }
        override suspend fun pairingApprovalCeremony(requestId: String): GatewayPasskeyCeremony { ceremonies += requestId; return ceremony!! }
        override suspend fun approvePairingWithPasskey(requestId: String, proof: JsonObject, trustSignIn: Boolean) {
            if (approvalFails) throw java.io.IOException("synthetic refusal")
            passkeyApprovals += Triple(requestId, proof, trustSignIn)
        }
    }
}

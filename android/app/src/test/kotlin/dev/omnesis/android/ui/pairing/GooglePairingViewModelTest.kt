// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.pairing.CloudPairingChallenge
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.*
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GooglePairingViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private class Gateway : GooglePairingAttempt {
        override val code = "ABCD-1234-5678-9012-3456"
        override val host = "synthetic.gateway.example"
        override var approved = false
        var compared = false
        var closed = false
        override suspend fun start(challenge: CloudPairingChallenge, token: String) { assertEquals("signed-token", token) }
        override suspend fun poll() { approved = true }
        override fun compare() { compared = true }
        override fun payload(): String { check(approved && compared); return "verified-payload" }
        override fun close() { closed = true }
    }
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }
    private fun model(ports: GooglePairingPorts, available: Boolean = true) = PairingViewModel(
        session = { error("Google orchestration must only apply through its selected session port") },
        googlePorts = ports, googleAvailable = available, cloudRelay = true,
    )

    @Test fun `UI receives live host code approval and comparison before selected session receives payload`() = runTest(dispatcher) {
        val gateway = Gateway()
        val selectedSession = mutableListOf<String>()
        val otherSession = mutableListOf<String>()
        val vm = model(GooglePairingPorts({ _, nonce -> assertTrue(nonce.isNotBlank()); "signed-token" }, { gateway }, { selectedSession += it }))
        val otherGateway = Gateway()
        val otherVm = model(GooglePairingPorts({ _, _ -> "signed-token" }, { otherGateway }, { otherSession += it }))
        otherVm.startGoogle(context); runCurrent()
        vm.showGoogle(); assertEquals(PairingViewModel.Mode.Google, vm.state.value.mode)
        vm.startGoogle(context); runCurrent()
        assertEquals(PairingViewModel.GooglePhase.Comparing, vm.state.value.googlePhase)
        assertEquals(gateway.code, vm.state.value.googleCode); assertEquals(gateway.host, vm.state.value.googleHost)
        vm.finishGooglePairing(); assertTrue(selectedSession.isEmpty())
        assertFalse(vm.state.value.googleCompared)
        advanceTimeBy(2000); runCurrent()
        assertTrue(vm.state.value.googleApproved)
        assertEquals(PairingViewModel.GooglePhase.Comparing, vm.state.value.googlePhase)
        vm.finishGooglePairing(); vm.finishGooglePairing(); runCurrent()
        assertEquals(listOf("verified-payload"), selectedSession); assertTrue(otherSession.isEmpty())
        assertTrue(gateway.closed); assertEquals(PairingViewModel.GooglePhase.Idle, vm.state.value.googlePhase)
        assertEquals(PairingViewModel.GooglePhase.Comparing, otherVm.state.value.googlePhase)
        assertFalse(otherVm.state.value.googleCompared); assertFalse(otherGateway.closed)
        otherVm.showScanner()
    }

    @Test fun `Google unavailable keeps QR and manual pairing available without touching provider`() = runTest(dispatcher) {
        val vm = model(GooglePairingPorts({ _, _ -> error("provider") }, { error("client") }, { error("session") }), false)
        vm.showGoogle(); vm.startGoogle(context); runCurrent()
        assertEquals(PairingViewModel.Mode.Scan, vm.state.value.mode)
        assertEquals(PairingViewModel.GooglePhase.Idle, vm.state.value.googlePhase)
        vm.showManualEntry(); assertEquals(PairingViewModel.Mode.Manual, vm.state.value.mode)
        vm.showScanner(); assertEquals(PairingViewModel.Mode.Scan, vm.state.value.mode)
    }

    @Test fun `manual scanner and lifecycle cancellation close Google and prevent late callbacks reaching UI`() = runTest(dispatcher) {
        for (destination in listOf("manual", "scanner", "cleared")) {
            val release = CompletableDeferred<Unit>()
            val gateway = Gateway()
            val vm = model(GooglePairingPorts({ _, _ -> "signed-token" }, { gateway }, {
                withContext(NonCancellable) { release.await() }
            }))
            val store = ViewModelStore().apply { put("pairing", vm) }
            vm.startGoogle(context); runCurrent(); advanceTimeBy(2000); runCurrent()
            vm.finishGooglePairing(); runCurrent()
            when (destination) { "manual" -> vm.showManualEntry(); "scanner" -> vm.showScanner(); else -> store.clear() }
            assertTrue(destination, gateway.closed)
            assertNull(vm.state.value.googleCode); assertFalse(vm.state.value.googleCompared)
            release.complete(Unit); runCurrent()
            assertEquals(PairingViewModel.GooglePhase.Idle, vm.state.value.googlePhase)
            assertNull(vm.state.value.error)
            store.clear()
        }
    }

    @Test fun `public-key QR trust is presented separately from the exact certificate digest`() = runTest(dispatcher) {
        val vm = model(GooglePairingPorts({ _, _ -> error("provider") }, { error("client") }, { error("session") }))
        val pin = "ab".repeat(32)
        vm.pairFromQr("""{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"synthetic","tls":{"mode":"pinned-key-strict","spkiFingerprint":"$pin"}}""")
        val pending = checkNotNull(vm.state.value.pending)
        assertEquals(pin, pending.fingerprint)
        assertEquals("Verified gateway public key (V4)", pending.versionLabel)
        assertEquals(PairingViewModel.TrustKind.PinnedKey, pending.trustKind)
        vm.cancelPending()
    }

    @Test fun `legacy exact leaf QR modes retain their own certificate pin and label`() = runTest(dispatcher) {
        val vm = model(GooglePairingPorts({ _, _ -> error("provider") }, { error("client") }, { error("session") }))
        val pin = "cd".repeat(32)
        val cases = listOf(
            """{"v":3,"gatewayUrl":"https://gateway.example.com","pairingCode":"synthetic","fingerprint":"$pin"}""" to "TLS-pinned HTTPS (V3)",
            """{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"synthetic","tls":{"mode":"pinned-leaf","fingerprint":"$pin"}}""" to "TLS-pinned (V4)",
            """{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"synthetic","tls":{"mode":"pinned-leaf-strict","fingerprint":"$pin"}}""" to "Verified gateway (V4)",
        )
        for ((raw, label) in cases) {
            vm.pairFromQr(raw)
            val pending = checkNotNull(vm.state.value.pending)
            assertEquals(pin, pending.fingerprint)
            assertEquals(label, pending.versionLabel)
            assertEquals(PairingViewModel.TrustKind.PinnedLeaf, pending.trustKind)
            vm.cancelPending()
        }
    }

    @Test fun `provider and selected session failures reach UI safely and can return to QR`() = runTest(dispatcher) {
        for (providerFails in listOf(true, false)) {
            val gateway = Gateway().apply { approved = true }
            val vm = model(GooglePairingPorts({ _, _ -> if (providerFails) error("secret details") else "signed-token" }, { gateway }, { error("private session detail") }))
            vm.startGoogle(context); runCurrent()
            if (!providerFails) { advanceTimeBy(2000); runCurrent(); vm.finishGooglePairing(); runCurrent() }
            assertEquals(PairingViewModel.GooglePhase.Failed, vm.state.value.googlePhase)
            assertNotNull(vm.state.value.error); assertFalse(vm.state.value.error!!.contains("detail"))
            assertNull(vm.state.value.googleCode); assertNull(vm.state.value.googleHost)
            vm.showScanner(); assertEquals(PairingViewModel.Mode.Scan, vm.state.value.mode); assertNull(vm.state.value.error)
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.*
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
class PairingViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }

    private var clients = 0
    private val ports = AccountPairingPorts(
        acquireGoogle = { _, _ -> error("provider") },
        acquirePasskey = { _, _ -> error("provider") },
        createClient = { clients++; error("relay unreachable") },
        applyPairing = { error("session") },
    )

    private fun model(google: Boolean = true, passkey: Boolean = true) = PairingViewModel(
        session = { error("only a confirmed pairing reaches the session") },
        accountPorts = ports, googleAvailable = google, passkeyAvailable = passkey,
    )

    @Test fun `the entry offers one sign-in button that opens the choices and goes back to the entry`() = runTest(dispatcher) {
        val vm = model()
        assertEquals(PairingViewModel.Mode.Account, vm.state.value.mode)
        assertFalse(vm.state.value.choosingSignIn)
        vm.showSignInChoices()
        assertTrue(vm.state.value.choosingSignIn)
        assertEquals(PairingViewModel.Mode.Account, vm.state.value.mode)
        vm.showAccount()
        assertFalse(vm.state.value.choosingSignIn)
        assertEquals(AccountPairingState(), vm.state.value.account)
        assertEquals(0, clients)
    }

    @Test fun `a failed sign-in stays on the choices with its message and leaving clears it`() = runTest(dispatcher) {
        val vm = model()
        vm.showSignInChoices()
        vm.startPasskey(context); runCurrent()
        assertEquals(1, clients)
        assertEquals(AccountPairingPhase.Failed, vm.state.value.account?.phase)
        assertNotNull(vm.state.value.account?.error)
        assertTrue(vm.state.value.choosingSignIn)
        vm.showAccount()
        assertNull(vm.state.value.account?.error)
        assertEquals(AccountPairingPhase.Idle, vm.state.value.account?.phase)
    }

    @Test fun `direct pairing leaves the choices and returns to the entry`() = runTest(dispatcher) {
        val vm = model()
        vm.showSignInChoices()
        vm.showScanner()
        assertEquals(PairingViewModel.Mode.Scan, vm.state.value.mode)
        assertFalse(vm.state.value.choosingSignIn)
        vm.showManualEntry()
        assertEquals(PairingViewModel.Mode.Manual, vm.state.value.mode)
        vm.showAccount()
        assertEquals(PairingViewModel.Mode.Account, vm.state.value.mode)
        assertFalse(vm.state.value.choosingSignIn)
    }

    @Test fun `a method the phone cannot use never starts`() = runTest(dispatcher) {
        val vm = model(google = false)
        vm.startGoogle(context); runCurrent()
        assertEquals(0, clients)
        assertEquals(AccountPairingPhase.Idle, vm.state.value.account?.phase)
        vm.startPasskey(context); runCurrent()
        assertEquals(1, clients)
    }

    @Test fun `without any way to sign in the screen is scanner-first and has no account entry`() = runTest(dispatcher) {
        val vm = model(google = false, passkey = false)
        assertEquals(PairingViewModel.Mode.Scan, vm.state.value.mode)
        assertNull(vm.state.value.account)
        vm.showSignInChoices(); vm.showAccount(); vm.showManualEntry(); vm.showScanner()
        vm.startGoogle(context); vm.startPasskey(context); runCurrent()
        assertEquals(PairingViewModel.Mode.Scan, vm.state.value.mode)
        assertNull(vm.state.value.account)
        assertFalse(vm.state.value.choosingSignIn)
        assertEquals(0, clients)
    }

    @Test fun `public-key QR trust is presented separately from the exact certificate digest`() = runTest(dispatcher) {
        val vm = model()
        val pin = "ab".repeat(32)
        vm.pairFromQr("""{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"synthetic","tls":{"mode":"pinned-key-strict","spkiFingerprint":"$pin"}}""")
        val pending = checkNotNull(vm.state.value.pending)
        assertEquals(pin, pending.fingerprint)
        assertEquals("Verified gateway public key (V4)", pending.versionLabel)
        assertEquals(PairingViewModel.TrustKind.PinnedKey, pending.trustKind)
        vm.cancelPending()
    }

    @Test fun `legacy exact leaf QR modes retain their own certificate pin and label`() = runTest(dispatcher) {
        val vm = model()
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
}

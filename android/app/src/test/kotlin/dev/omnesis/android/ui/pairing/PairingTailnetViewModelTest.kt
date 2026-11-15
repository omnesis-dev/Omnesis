// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.transport.GatewayException
import java.net.ConnectException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A pairing code that marks its gateway URL as a Tailscale address, when this phone cannot
 * reach it: the Tailscale state replaces the error, and "Try again" repeats the same exchange.
 * The exchange's failure is injected where the view model resolves the session.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairingTailnetViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val fingerprint = "a".repeat(64)
    private val marked = """{"v":3,"gatewayUrl":"https://maya-gateway.tail1234.ts.net:7600","pairingCode":"AB-CD","fingerprint":"$fingerprint","tailnet":true}"""
    private val unmarked = """{"v":3,"gatewayUrl":"https://maya-gateway.tail1234.ts.net:7600","pairingCode":"AB-CD","fingerprint":"$fingerprint"}"""
    private val unreachable = GatewayException.Network(ConnectException("Failed to connect"))

    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }

    private var attempts = 0
    private val failures = ArrayDeque<Throwable>()

    private fun model() = PairingViewModel(
        session = {
            attempts++
            throw failures.removeFirstOrNull() ?: unreachable
        },
        googlePorts = GooglePairingPorts({ _, _ -> error("google") }, { error("client") }, { error("session") }),
        googleAvailable = false,
    )

    @Test fun `an unreachable marked address shows the Tailscale state, not the error`() = runTest(dispatcher) {
        val vm = model()
        vm.pairFromQr(marked)
        assertTrue(vm.state.value.pending!!.tailnet)
        vm.confirmPending(); runCurrent()

        val state = vm.state.value
        assertEquals("maya-gateway.tail1234.ts.net:7600", state.tailnetUnreachable?.retry?.hostAndPort)
        assertNull(state.tailnetUnreachable?.retryError)
        assertNull(state.error)
        assertNull(state.pending)
        assertFalse(state.isPairing)
        assertEquals(PairingViewModel.Mode.Scan, state.mode)
        assertEquals(1, attempts)
    }

    @Test fun `try again repeats the same exchange and stays on the state while still unreachable`() = runTest(dispatcher) {
        val vm = model()
        vm.pairFromQr(marked)
        vm.confirmPending(); runCurrent()
        val first = vm.state.value.tailnetUnreachable!!.retry

        vm.retryTailnetPairing()
        assertTrue(vm.state.value.isPairing)
        // A second tap while one is under way starts nothing.
        vm.retryTailnetPairing()
        runCurrent()

        assertEquals(2, attempts)
        assertEquals(first, vm.state.value.tailnetUnreachable?.retry)
        assertFalse(vm.state.value.isPairing)
        assertNull(vm.state.value.error)
    }

    @Test fun `a retry that fails another way says so on the Tailscale state`() = runTest(dispatcher) {
        val vm = model()
        vm.pairFromQr(marked)
        vm.confirmPending(); runCurrent()
        failures += GatewayException.ServerError(400, "invalid or expired pairing code", "BAD_REQUEST")

        vm.retryTailnetPairing(); runCurrent()

        assertEquals(PAIRING_CODE_USED_MESSAGE, vm.state.value.tailnetUnreachable?.retryError)
        assertNull(vm.state.value.error)
    }

    @Test fun `leaving the state forgets the payload it would retry`() = runTest(dispatcher) {
        val vm = model()
        vm.pairFromQr(marked)
        vm.confirmPending(); runCurrent()
        vm.dismissTailnetUnreachable()
        assertNull(vm.state.value.tailnetUnreachable)
        vm.retryTailnetPairing(); runCurrent()
        assertEquals(1, attempts)
    }

    @Test fun `without the marker an unreachable gateway shows the error as before`() = runTest(dispatcher) {
        val vm = model()
        vm.pairFromQr(unmarked)
        assertFalse(vm.state.value.pending!!.tailnet)
        vm.confirmPending(); runCurrent()

        val state = vm.state.value
        assertNull(state.tailnetUnreachable)
        assertEquals(PairingViewModel.Mode.Manual, state.mode)
        assertEquals(pairingErrorMessage(unreachable, "maya-gateway.tail1234.ts.net:7600"), state.error)
    }

    @Test fun `a marked code that fails another way shows that error as before`() = runTest(dispatcher) {
        val vm = model()
        failures += GatewayException.ServerError(400, "invalid or expired pairing code", "BAD_REQUEST")
        vm.pairFromQr(marked)
        vm.confirmPending(); runCurrent()

        assertNull(vm.state.value.tailnetUnreachable)
        assertEquals(PairingViewModel.Mode.Manual, vm.state.value.mode)
        assertEquals(PAIRING_CODE_USED_MESSAGE, vm.state.value.error)
    }
}

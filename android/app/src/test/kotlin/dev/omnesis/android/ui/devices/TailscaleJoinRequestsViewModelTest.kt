// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.TailscaleJoinApproving
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import java.net.ConnectException
import kotlinx.coroutines.CompletableDeferred
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

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TailscaleJoinRequestsViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }

    private val laptop = TailscaleJoinRequest(
        id = "join-1", name = "maya-laptop", kind = "collector", machine = "maya-laptop", os = "macOS",
        login = "maya@example.com", requestedAt = "2026-11-14T18:00:00.000Z", expiresAt = "2026-11-14T18:10:00.000Z",
    )
    private val buildBox = TailscaleJoinRequest(
        id = "join-2", name = "build-box", kind = "collector", machine = "build-box", os = "Linux",
        login = "maya@example.com", requestedAt = "2026-11-14T18:02:00.000Z", expiresAt = "2026-11-14T18:12:00.000Z",
    )

    /** A gateway whose list is what [waiting] holds; decisions remove the row unless [gone]. */
    private class Gateway(var waiting: List<TailscaleJoinRequest>) : TailscaleJoinApproving {
        val decisions = mutableListOf<Pair<String, Boolean>>()
        var reads = 0
        val gone = mutableSetOf<String>()
        var listFailure: Exception? = null
        var decisionFailure: Exception? = null
        var nextRead: CompletableDeferred<Unit>? = null

        override suspend fun tailscaleJoinRequests(): List<TailscaleJoinRequest> {
            reads++
            nextRead?.await()
            listFailure?.let { throw it }
            return waiting
        }

        override suspend fun decideTailscaleJoin(id: String, approve: Boolean): String {
            decisionFailure?.let { throw it }
            if (id in gone) throw GatewayException.NotFound("join request not found")
            decisions += id to approve
            waiting = waiting.filterNot { it.id == id }
            return if (approve) "approved" else "denied"
        }
    }

    @Test fun `opening reads the waiting requests`() = runTest(dispatcher) {
        val gateway = Gateway(listOf(laptop, buildBox))
        val vm = TailscaleJoinRequestsViewModel { gateway }
        assertFalse(vm.state.value.loaded)
        vm.open()
        assertTrue(vm.state.value.loading)
        runCurrent()
        assertEquals(listOf(laptop, buildBox), vm.state.value.requests)
        assertTrue(vm.state.value.loaded)
        assertFalse(vm.state.value.busy)
        assertNull(vm.state.value.error)
    }

    @Test fun `nothing waiting is loaded and empty`() = runTest(dispatcher) {
        val vm = TailscaleJoinRequestsViewModel { Gateway(emptyList()) }
        vm.open(); runCurrent()
        assertTrue(vm.state.value.loaded)
        assertTrue(vm.state.value.requests.isEmpty())
        assertNull(vm.state.value.error)
    }

    @Test fun `approve sends the decision, drops the row and reads the list again`() = runTest(dispatcher) {
        val gateway = Gateway(listOf(laptop, buildBox))
        val vm = TailscaleJoinRequestsViewModel { gateway }
        vm.open(); runCurrent()

        vm.decide(laptop, approve = true)
        assertEquals("join-1", vm.state.value.deciding)
        // One decision at a time.
        vm.decide(buildBox, approve = false)
        runCurrent()

        assertEquals(listOf("join-1" to true), gateway.decisions)
        assertEquals(listOf(buildBox), vm.state.value.requests)
        assertNull(vm.state.value.deciding)
        assertNull(vm.state.value.notice)
        assertEquals(2, gateway.reads)
    }

    @Test fun `deny sends a denial`() = runTest(dispatcher) {
        val gateway = Gateway(listOf(laptop, buildBox))
        val vm = TailscaleJoinRequestsViewModel { gateway }
        vm.open(); runCurrent()
        vm.decide(buildBox, approve = false); runCurrent()
        assertEquals(listOf("join-2" to false), gateway.decisions)
        assertEquals(listOf(laptop), vm.state.value.requests)
    }

    @Test fun `a request that is gone says so and the list is read again`() = runTest(dispatcher) {
        val gateway = Gateway(listOf(laptop, buildBox))
        val vm = TailscaleJoinRequestsViewModel { gateway }
        vm.open(); runCurrent()
        // Another administrator decided it meanwhile.
        gateway.gone += laptop.id
        gateway.waiting = listOf(buildBox)

        vm.decide(laptop, approve = true); runCurrent()

        assertEquals(TAILSCALE_JOIN_GONE_MESSAGE, vm.state.value.notice)
        assertEquals(listOf(buildBox), vm.state.value.requests)
        assertTrue(gateway.decisions.isEmpty())
        assertEquals(2, gateway.reads)
        assertNull(vm.state.value.error)

        // Reopening the sheet starts without the old notice.
        vm.open(); runCurrent()
        assertNull(vm.state.value.notice)
    }

    @Test fun `any other decision failure keeps the row to decide again`() = runTest(dispatcher) {
        val gateway = Gateway(listOf(laptop))
        val vm = TailscaleJoinRequestsViewModel { gateway }
        vm.open(); runCurrent()
        val failure = GatewayException.Network(ConnectException("unreachable"))
        gateway.decisionFailure = failure

        vm.decide(laptop, approve = true); runCurrent()

        assertEquals(listOf(laptop), vm.state.value.requests)
        assertEquals(failure, vm.state.value.error)
        assertNull(vm.state.value.deciding)
        assertEquals(1, gateway.reads)
    }

    @Test fun `a failed read is an error, not an empty list`() = runTest(dispatcher) {
        val gateway = Gateway(listOf(laptop)).apply { listFailure = GatewayException.Network(ConnectException("unreachable")) }
        val vm = TailscaleJoinRequestsViewModel { gateway }
        vm.open(); runCurrent()
        assertTrue(vm.state.value.error is GatewayException.Network)
        assertTrue(vm.state.value.requests.isEmpty())
    }

    @Test fun `only the latest read lands`() = runTest(dispatcher) {
        val gateway = Gateway(listOf(laptop, buildBox))
        val vm = TailscaleJoinRequestsViewModel { gateway }
        val slow = CompletableDeferred<Unit>()
        gateway.nextRead = slow
        vm.refresh(); runCurrent()
        gateway.nextRead = null
        gateway.waiting = listOf(buildBox)
        vm.refresh(); runCurrent()
        assertEquals(listOf(buildBox), vm.state.value.requests)
        gateway.waiting = listOf(laptop, buildBox)
        slow.complete(Unit); runCurrent()
        assertEquals(listOf(buildBox), vm.state.value.requests)
    }

    @Test fun `a phone without an admin client reads nothing`() = runTest(dispatcher) {
        val vm = TailscaleJoinRequestsViewModel { null }
        vm.open(); runCurrent()
        assertTrue(vm.state.value.error is GatewayException.Forbidden)
        vm.decide(laptop, approve = true); runCurrent()
        assertNull(vm.state.value.deciding)
    }
}

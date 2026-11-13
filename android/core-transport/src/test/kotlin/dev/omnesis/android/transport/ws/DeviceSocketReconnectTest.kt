// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.ws

import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.transport.ws.DeviceSocket.FailureKind
import dev.omnesis.android.transport.ws.DeviceSocket.NetworkAvailability
import dev.omnesis.android.transport.ws.DeviceSocketAttemptFailure.Network
import java.io.IOException
import java.net.ConnectException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.Json
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val wifi = NetworkPathSnapshot(isUsable = true, interfaces = setOf(NetworkPathSnapshot.Interface.WIFI))
private val cellular = NetworkPathSnapshot(isUsable = true, interfaces = setOf(NetworkPathSnapshot.Interface.CELLULAR))
private val noNetwork = NetworkPathSnapshot(isUsable = false)
private val refused = ConnectException("Failed to connect to gateway.example.com")

/** A scripted connection the test answers by hand, on the test's own thread. */
private class FakeWebSocket(
    private val request: Request,
    private val listener: WebSocketListener,
    private val holdsCallbacksAcrossCancel: Boolean,
) : WebSocket {
    val sent = mutableListOf<String>()
    var cancelled = false
        private set
    private var finished = false

    override fun request() = request
    override fun queueSize() = 0L
    var refusesSends = false

    override fun send(text: String): Boolean {
        if (refusesSends) return false
        sent += text
        return true
    }

    /** The gateway answers every command with its id; an unknown one gets an error, which is still an answer. */
    fun answerProbe() {
        val probe = Json.parseToJsonElement(sent.last()).jsonObject
        check(probe["type"]!!.jsonPrimitive.content == "ping")
        val id = probe["id"]!!.jsonPrimitive.content
        listener.onMessage(this, """{"kind":"response","correlationId":"$id","ok":false,"error":{"code":"unsupported","message":"no handler for ping"}}""")
    }

    override fun send(bytes: ByteString) = false
    override fun close(code: Int, reason: String?) = true

    override fun cancel() {
        cancelled = true
        if (!holdsCallbacksAcrossCancel) fail(IOException("Canceled"))
    }

    fun open() {
        listener.onOpen(this, response(101))
    }

    fun fail(error: Throwable, responseCode: Int? = null) {
        if (finished) return
        finished = true
        listener.onFailure(this, error, responseCode?.let(::response))
    }

    /** A late callback from a connection that was already replaced. */
    fun deliverLateFailure(error: Throwable) {
        listener.onFailure(this, error, null)
    }

    fun acceptHello() {
        listener.onMessage(this, helloResponse(ok = true))
    }

    fun rejectHello(code: String, message: String) {
        listener.onMessage(this, helloResponse(ok = false, code = code, message = message))
    }

    private fun helloResponse(ok: Boolean, code: String = "", message: String = ""): String {
        val id = Json.parseToJsonElement(sent.first()).jsonObject["id"]!!.jsonPrimitive.content
        return if (ok) {
            """{"kind":"response","correlationId":"$id","ok":true,"result":{"deviceId":"d","deviceName":"Phone","scopes":[]}}"""
        } else {
            """{"kind":"response","correlationId":"$id","ok":false,"error":{"code":"$code","message":"$message"}}"""
        }
    }

    private fun response(code: Int) = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(code)
        .message("status")
        .build()
}

private class FakeFactory : WebSocket.Factory {
    val opened = mutableListOf<FakeWebSocket>()
    val requests = mutableListOf<Request>()
    var holdsCallbacksAcrossCancel = false

    override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket {
        requests += request
        return FakeWebSocket(request, listener, holdsCallbacksAcrossCancel).also { opened += it }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceSocketReconnectTest : DeviceSocketReconnectCases(cloudRelay = false)

/** The same reconnect contract with cloud connectivity enabled. */
class DeviceSocketReconnectCloudTest : DeviceSocketReconnectCases(cloudRelay = true)

abstract class DeviceSocketReconnectCases(private val cloudRelay: Boolean) {
    private val factory = FakeFactory()
    private val paths = MutableSharedFlow<NetworkPathSnapshot>(extraBufferCapacity = 512)

    private fun TestScope.socket(onRouteEvent: (DeviceSocket.RouteEvent) -> Unit = {}) = DeviceSocket(
        client = factory,
        gatewayUrl = "https://gateway.example.com:7600/",
        token = "omn_test",
        scope = backgroundScope,
        cloudRelay = cloudRelay,
        pathObserver = { paths },
        onRouteEvent = onRouteEvent,
        nowMs = { testScheduler.currentTime },
        randomUnit = { 0.0 },
    )

    private fun TestScope.started(initial: NetworkPathSnapshot): DeviceSocket {
        val socket = socket()
        socket.start()
        runCurrent()
        send(initial)
        return socket
    }

    private fun TestScope.send(path: NetworkPathSnapshot) {
        paths.tryEmit(path)
        runCurrent()
    }

    private fun TestScope.advance(ms: Long) {
        advanceTimeBy(ms)
        runCurrent()
    }

    private fun TestScope.failNewest(error: Throwable = refused, code: Int? = null) {
        factory.opened.last().fail(error, code)
        runCurrent()
    }

    private fun TestScope.connectNewest() {
        factory.opened.last().open()
        factory.opened.last().acceptHello()
        runCurrent()
    }

    /** Fails attempts until the ladder is at its 30s cap, leaving the socket waiting on it. */
    private fun TestScope.climbToCappedBackoff() {
        for (delay in listOf(1_000L, 2_000, 4_000, 8_000, 16_000, 30_000)) {
            failNewest()
            advance(delay)
        }
        failNewest()
    }

    // --- restoration during backoff ---

    @Test
    fun restoration_during_capped_backoff_retries_without_waiting_for_the_timer() = runTest {
        val socket = started(wifi)
        climbToCappedBackoff()
        send(noNetwork)
        advance(29_000)
        val before = factory.opened.size

        send(wifi)
        assertEquals("woken with a second of the timer left", before + 1, factory.opened.size)
        connectNewest()
        assertTrue(socket.state.value is ConnectionState.Connected)
    }

    @Test
    fun restored_network_that_cannot_reach_the_gateway_climbs_bounded_backoff_again() = runTest {
        started(wifi)
        climbToCappedBackoff()
        send(noNetwork)
        advance(29_000)

        send(cellular)
        val woken = factory.opened.size
        failNewest()
        advance(999)
        assertEquals("a new network restarts the ladder at 1s, not sooner", woken, factory.opened.size)
        advance(1)
        assertEquals(woken + 1, factory.opened.size)

        failNewest()
        advance(1_999)
        assertEquals("and it keeps backing off", woken + 1, factory.opened.size)

        send(cellular)
        assertEquals("an identical path wakes nothing", woken + 1, factory.opened.size)
    }

    @Test
    fun restoration_after_an_unsuccessful_foreground_retry_still_wakes() = runTest {
        val socket = started(noNetwork)
        failNewest()
        socket.appDidBecomeActive()
        runCurrent()
        assertEquals(2, factory.opened.size)
        failNewest()

        send(wifi)
        assertEquals(3, factory.opened.size)
        connectNewest()
        assertTrue(socket.state.value is ConnectionState.Connected)
    }

    // --- unusable networks and storms ---

    @Test
    fun repeated_unusable_network_events_neither_attempt_nor_reset_backoff() = runTest {
        started(noNetwork)
        failNewest()
        advance(1_000)
        failNewest()

        repeat(20) { send(noNetwork) }
        send(NetworkPathSnapshot(isUsable = false, interfaces = setOf(NetworkPathSnapshot.Interface.WIFI)))
        assertEquals(2, factory.opened.size)

        advance(2_000)
        assertEquals("the ladder kept its place", 3, factory.opened.size)
        failNewest()
        advance(3_999)
        assertEquals(3, factory.opened.size)
        advance(1)
        assertEquals(4, factory.opened.size)
    }

    @Test
    fun flapping_network_cannot_exceed_the_attempt_budget() = runTest {
        started(wifi)
        repeat(200) {
            send(noNetwork)
            send(wifi)
            factory.opened.last().fail(refused)
            runCurrent()
        }
        assertTrue(
            "no time passed, so the burst is all there is, got ${factory.opened.size}",
            factory.opened.size <= DeviceSocketReconnectLimits().attemptBurst,
        )
        advance(DeviceSocketReconnectLimits().attemptRefillIntervalMs)
        assertTrue(factory.opened.size <= DeviceSocketReconnectLimits().attemptBurst + 1)
    }

    @Test
    fun attempt_long_in_flight_is_replaced_when_the_network_returns() = runTest {
        val socket = started(noNetwork)
        val stuck = factory.opened.single()
        advance(3_000)

        send(wifi)
        assertTrue(stuck.cancelled)
        assertEquals(2, factory.opened.size)
        connectNewest()
        assertTrue(socket.state.value is ConnectionState.Connected)
    }

    @Test
    fun fresh_attempt_is_left_to_finish_but_retried_at_once_if_it_fails() = runTest {
        started(noNetwork)
        val fresh = factory.opened.single()
        send(wifi)
        assertFalse(fresh.cancelled)

        failNewest()
        assertEquals("the path changed after this attempt started", 2, factory.opened.size)
    }

    // --- foreground and background ---

    @Test
    fun foreground_cuts_a_pending_backoff_short_without_resetting_it() = runTest {
        val socket = started(wifi)
        climbToCappedBackoff()
        advance(20_000)
        val before = factory.opened.size

        socket.appDidBecomeActive()
        runCurrent()
        assertEquals(before + 1, factory.opened.size)

        failNewest()
        advance(29_999)
        assertEquals("foreground says nothing about the network", before + 1, factory.opened.size)
        advance(1)
        assertEquals(before + 2, factory.opened.size)
    }

    @Test
    fun path_restored_in_background_waits_for_foreground_and_then_counts_as_restoration() = runTest {
        val socket = started(wifi)
        climbToCappedBackoff()
        send(noNetwork)
        socket.appDidEnterBackground()
        val before = factory.opened.size

        send(wifi)
        assertEquals("no early attempt while backgrounded", before, factory.opened.size)

        advance(20_000)
        socket.appDidBecomeActive()
        runCurrent()
        assertEquals(before + 1, factory.opened.size)
        failNewest()
        advance(1_000)
        assertEquals("the restoration restarted the ladder", before + 2, factory.opened.size)
    }

    @Test
    fun foreground_during_a_fresh_attempt_retries_at_once_if_it_fails() = runTest {
        val socket = started(wifi)
        climbToCappedBackoff()
        advance(30_000)
        val onResume = factory.opened.size

        socket.appDidBecomeActive()
        failNewest()
        assertEquals("the backoff fell due just ahead of the foreground signal", onResume + 1, factory.opened.size)
    }

    @Test
    fun refusal_keeps_its_earned_wait_when_the_network_changed_during_the_attempt() = runTest {
        started(noNetwork)
        send(wifi)
        failNewest(java.net.ProtocolException("Expected HTTP 101"), code = 401)
        advance(DeviceSocketReconnectLimits().refusedDelayMs - 1)
        assertEquals(1, factory.opened.size)
        advance(1)
        assertEquals(2, factory.opened.size)
    }

    @Test
    fun refusal_is_rechecked_on_foreground_even_if_the_path_also_changed_in_background() = runTest {
        val socket = started(wifi)
        failNewest(java.net.ProtocolException("Expected HTTP 101"), code = 401)
        socket.appDidEnterBackground()
        send(cellular)
        assertEquals(1, factory.opened.size)

        socket.appDidBecomeActive()
        runCurrent()
        assertEquals(2, factory.opened.size)
    }

    @Test
    fun a_refused_hello_cannot_be_replaced_before_its_outcome_is_read() = runTest {
        factory.holdsCallbacksAcrossCancel = true
        val socket = started(wifi)
        val connection = factory.opened.single()
        connection.open()
        advance(3_000)
        connection.rejectHello("invalid_token", "invalid token")

        socket.appDidBecomeActive()
        connection.deliverLateFailure(IOException("Canceled"))
        runCurrent()
        assertEquals(
            ConnectionState.Failed(FailureKind.AUTHENTICATION, "invalid token"),
            socket.state.value,
        )
    }

    @Test
    fun a_path_observer_that_throws_leaves_the_backoff_running() = runTest {
        val socket = DeviceSocket(
            client = factory,
            gatewayUrl = "https://gateway.example.com:7600/",
            token = "omn_test",
            scope = backgroundScope,
            cloudRelay = cloudRelay,
            pathObserver = { kotlinx.coroutines.flow.flow { throw SecurityException("too many callbacks") } },
            nowMs = { testScheduler.currentTime },
            randomUnit = { 0.0 },
        )
        socket.start()
        runCurrent()
        failNewest()
        advance(1_000)
        assertEquals(2, factory.opened.size)
    }

    @Test
    fun backoff_timer_still_runs_while_backgrounded() = runTest {
        val socket = started(wifi)
        failNewest()
        socket.appDidEnterBackground()
        advance(1_000)
        assertEquals(2, factory.opened.size)
    }

    /** Without cloud connectivity nothing about an open socket changed: the client's ping interval watches it. */
    @Test
    fun wake_signals_leave_an_open_socket_alone_without_cloud_connectivity() = runTest {
        if (cloudRelay) return@runTest
        val socket = started(wifi)
        connectNewest()

        socket.appDidBecomeActive()
        send(noNetwork)
        assertTrue("a path report alone does not end a session", socket.state.value is ConnectionState.Connected)
        send(cellular)
        advance(120_000)

        assertEquals(1, factory.opened.size)
        assertFalse(factory.opened.single().cancelled)
        assertEquals("only the hello was sent", 1, factory.opened.single().sent.size)
    }

    @Test
    fun a_network_change_asks_an_open_socket_to_answer_and_an_answer_keeps_it() = runTest {
        if (!cloudRelay) return@runTest
        val events = mutableListOf<DeviceSocket.RouteEvent>()
        val socket = socket(events::add)
        socket.start(); runCurrent(); send(wifi)
        connectNewest()
        val open = factory.opened.single()

        send(noNetwork)
        assertEquals("losing the network asks nothing: there is nothing to ask over", 1, open.sent.size)
        assertTrue("a path report alone does not end a session", socket.state.value is ConnectionState.Connected)
        send(cellular)
        assertEquals("one question on the open socket", 2, open.sent.size)
        assertEquals(listOf(DeviceSocket.RouteEvent.NETWORK_CHANGED, DeviceSocket.RouteEvent.NETWORK_CHANGED), events)
        // A second signal while the first question is open does not ask twice.
        socket.appDidBecomeActive()
        assertEquals(2, open.sent.size)

        advance(4_000)
        open.answerProbe()
        advance(120_000)
        assertEquals("answered in time: the connection stays", 1, factory.opened.size)
        assertFalse(open.cancelled)
        assertTrue(socket.state.value is ConnectionState.Connected)

        // Each later signal asks again.
        socket.appDidBecomeActive()
        assertEquals(3, open.sent.size)
        open.answerProbe()
        advance(10_000)
        assertEquals(1, factory.opened.size)
    }

    @Test
    fun an_open_socket_that_does_not_answer_within_five_seconds_is_replaced_at_once() = runTest {
        if (!cloudRelay) return@runTest
        val socket = started(wifi)
        connectNewest()
        val dead = factory.opened.single()

        send(cellular)
        advance(4_999)
        assertEquals("still inside the answer deadline", 1, factory.opened.size)
        advance(1)
        assertTrue("the silent connection is dropped", dead.cancelled)
        assertEquals("and replaced without waiting out a backoff", 2, factory.opened.size)
        connectNewest()
        assertTrue(socket.state.value is ConnectionState.Connected)
        // An answer that arrives on the dropped connection changes nothing.
        dead.answerProbe()
        advance(10_000)
        assertEquals(2, factory.opened.size)
    }

    @Test
    fun returning_to_the_app_checks_an_open_socket_too() = runTest {
        if (!cloudRelay) return@runTest
        val socket = started(wifi)
        connectNewest()
        socket.appDidEnterBackground()
        socket.appDidBecomeActive()
        assertEquals(2, factory.opened.single().sent.size)
        advance(5_000)
        assertEquals("unanswered on return: reconnect", 2, factory.opened.size)
    }

    @Test
    fun a_socket_that_cannot_even_send_the_question_is_replaced_without_waiting() = runTest {
        if (!cloudRelay) return@runTest
        started(wifi)
        connectNewest()
        factory.opened.single().refusesSends = true
        send(cellular)
        assertEquals(2, factory.opened.size)
    }

    // --- stale callbacks ---

    @Test
    fun late_hello_from_a_replaced_attempt_does_not_connect_or_reset_backoff() = runTest {
        factory.holdsCallbacksAcrossCancel = true
        val socket = started(wifi)
        failNewest()
        advance(1_000)
        failNewest()
        advance(2_000)
        val stale = factory.opened.last()
        stale.open()
        advance(3_000)

        socket.appDidBecomeActive()
        runCurrent()
        assertTrue(stale.cancelled)
        assertEquals(4, factory.opened.size)
        val replacement = factory.opened.last()

        stale.acceptHello()
        runCurrent()
        assertFalse(socket.state.value is ConnectionState.Connected)

        replacement.fail(refused)
        runCurrent()
        advance(3_999)
        assertEquals("the stale answer must not have reset the ladder", 4, factory.opened.size)
        advance(1)
        assertEquals(5, factory.opened.size)
    }

    @Test
    fun late_failure_from_a_replaced_attempt_is_not_reported() = runTest {
        factory.holdsCallbacksAcrossCancel = true
        val socket = started(noNetwork)
        val stale = factory.opened.single()
        advance(3_000)
        send(wifi)
        val replacement = factory.opened.last()

        stale.deliverLateFailure(SSLHandshakeException("cert").apply { initCause(CertificateException("pin")) })
        runCurrent()
        assertFalse(replacement.cancelled)

        replacement.fail(refused)
        runCurrent()
        assertTrue(
            "the abandoned attempt's certificate error must not surface, got ${socket.state.value}",
            socket.state.value is ConnectionState.Reconnecting,
        )
    }

    // --- stop ---

    @Test
    fun stop_during_backoff_prevents_later_events_from_reconnecting() = runTest {
        val socket = started(noNetwork)
        failNewest()

        socket.stop()
        send(wifi)
        socket.appDidBecomeActive()
        advance(600_000)

        assertEquals(1, factory.opened.size)
        assertEquals(ConnectionState.Disconnected, socket.state.value)
    }

    @Test
    fun stop_during_an_attempt_ignores_its_late_answer() = runTest {
        factory.holdsCallbacksAcrossCancel = true
        val socket = started(wifi)
        val connection = factory.opened.single()
        connection.open()

        socket.stop()
        runCurrent()
        assertTrue(connection.cancelled)
        connection.acceptHello()
        connection.deliverLateFailure(refused)
        advance(600_000)

        assertEquals(ConnectionState.Disconnected, socket.state.value)
        assertEquals(1, factory.opened.size)
    }

    @Test
    fun stop_while_connected_ends_the_session_for_good() = runTest {
        val socket = started(wifi)
        connectNewest()

        socket.stop()
        factory.opened.single().deliverLateFailure(refused)
        send(cellular)
        socket.appDidBecomeActive()
        advance(600_000)

        assertEquals(1, factory.opened.size)
        assertEquals(ConnectionState.Disconnected, socket.state.value)
    }

    // --- reported state ---

    @Test
    fun unreachable_gateway_is_temporary_and_keeps_the_diagnostic() = runTest {
        val socket = started(wifi)
        failNewest()
        assertEquals(
            ConnectionState.Reconnecting(NetworkAvailability.AVAILABLE, refused.message, 1),
            socket.state.value,
        )
        send(noNetwork)
        assertEquals(
            ConnectionState.Reconnecting(NetworkAvailability.UNAVAILABLE, refused.message, 1),
            socket.state.value,
        )
    }

    @Test
    fun retries_do_not_flicker_back_to_connecting() = runTest {
        val socket = started(wifi)
        failNewest()
        val before = socket.state.value
        advance(1_000)
        assertEquals(2, factory.opened.size)
        assertEquals(before, socket.state.value)
        factory.opened.last().open()
        runCurrent()
        assertEquals(before, socket.state.value)
    }

    @Test
    fun authentication_refusal_is_persistent_and_ignores_network_changes() = runTest {
        val socket = started(wifi)
        failNewest(java.net.ProtocolException("Expected HTTP 101"), code = 401)
        assertEquals(FailureKind.AUTHENTICATION, (socket.state.value as ConnectionState.Failed).kind)

        send(noNetwork)
        send(cellular)
        assertEquals("a new network cannot fix a refused credential", 1, factory.opened.size)

        advance(DeviceSocketReconnectLimits().refusedDelayMs - 1)
        assertEquals(1, factory.opened.size)
        socket.appDidBecomeActive()
        runCurrent()
        assertEquals("the user may have fixed it on the gateway", 2, factory.opened.size)
    }

    @Test
    fun hello_refusal_keeps_the_gateways_own_message() = runTest {
        val socket = started(wifi)
        val connection = factory.opened.single()
        connection.open()
        connection.rejectHello("protocol_version_mismatch", "client protocol 1 != gateway 2")
        runCurrent()
        assertEquals(
            ConnectionState.Failed(FailureKind.INCOMPATIBLE, "client protocol 1 != gateway 2"),
            socket.state.value,
        )
    }

    @Test
    fun certificate_failure_is_reported_and_every_retry_keeps_the_same_request() = runTest {
        val socket = started(wifi)
        failNewest(SSLHandshakeException("handshake").apply { initCause(CertificateException("pin mismatch")) })
        assertEquals(FailureKind.CERTIFICATE, (socket.state.value as ConnectionState.Failed).kind)

        advance(1_000)
        failNewest(SSLPeerUnverifiedException("host"))
        send(cellular)
        assertEquals("a Wi-Fi sign-in page can be the cause, so a new network retries", 3, factory.opened.size)

        for (request in factory.requests) {
            assertEquals("https://gateway.example.com:7600/device/ws", request.url.toString())
            assertEquals("Bearer omn_test", request.header("Authorization"))
        }
    }

    @Test
    fun rate_limited_upgrade_waits_out_the_limiter_window_and_ignores_wakes() = runTest {
        val socket = started(wifi)
        failNewest(java.net.ProtocolException("Expected HTTP 101"), code = 429)
        assertTrue(socket.state.value is ConnectionState.Reconnecting)

        send(cellular)
        socket.appDidBecomeActive()
        advance(59_999)
        assertEquals(1, factory.opened.size)
        advance(1)
        assertEquals(2, factory.opened.size)
    }

    @Test
    fun drop_after_connecting_is_temporary_and_retries_from_the_bottom_of_the_ladder() = runTest {
        val socket = started(wifi)
        connectNewest()
        failNewest(IOException("Connection reset"))
        assertEquals(
            ConnectionState.Reconnecting(NetworkAvailability.AVAILABLE, "Connection reset", 1),
            socket.state.value,
        )
        advance(1_000)
        assertEquals(2, factory.opened.size)
    }

    @Test
    fun a_handshake_that_never_answers_is_abandoned_with_its_own_diagnostic() = runTest {
        val socket = started(wifi)
        advance(30_000)
        val state = socket.state.value as ConnectionState.Reconnecting
        assertEquals("The gateway didn't answer in time.", state.lastError)
    }
}

class DeviceSocketReconnectPolicyTest {
    private val network = Network("x")

    @Test
    fun backoff_climbs_to_its_cap_with_bounded_jitter() {
        val policy = DeviceSocketReconnectPolicy()
        val delays = List(7) {
            policy.recordFailure(network)
            policy.retryDelayMs(0.0)
        }
        assertEquals(listOf(1_000L, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000), delays)
        assertEquals(37_500L, policy.retryDelayMs(1.0))
    }

    @Test
    fun restored_connectivity_restarts_the_ladder_but_keeps_the_last_failure() {
        val policy = DeviceSocketReconnectPolicy()
        repeat(6) { policy.recordFailure(network) }
        policy.connectivityRestored()
        assertEquals(network, policy.lastFailure)
        policy.recordFailure(network)
        assertEquals(1_000L, policy.retryDelayMs(0.0))
    }

    @Test
    fun budget_stays_below_the_gateway_upgrade_limits() {
        val policy = DeviceSocketReconnectPolicy()
        var now = 100_000L
        val attempts = mutableListOf<Long>()
        while (now < 100_000 + 3_600_000) {
            now += policy.budgetDelayMs(now)
            policy.recordAttemptStarted(now)
            attempts += now
        }
        fun most(windowMs: Long) = attempts.indices.maxOf { start ->
            attempts.drop(start).takeWhile { it - attempts[start] <= windowMs }.size
        }
        assertTrue(most(60_000) <= 8)
        assertTrue(most(3_600_000) < 200)
    }

    @Test
    fun plain_backoff_ladder_is_never_stretched_by_the_budget() {
        val policy = DeviceSocketReconnectPolicy()
        var now = 100_000L
        repeat(500) {
            policy.recordAttemptStarted(now)
            policy.recordFailure(network)
            val backoff = policy.retryDelayMs(0.0)
            assertEquals(0L, policy.budgetDelayMs(now + backoff))
            now += backoff
        }
    }

    @Test
    fun refusals_accept_only_a_foreground_check() {
        val policy = DeviceSocketReconnectPolicy()
        policy.recordFailure(DeviceSocketAttemptFailure.Authentication("x"))
        assertFalse(policy.accepts(DeviceSocketReconnectPolicy.WakeSignal.CONNECTIVITY_RESTORED))
        assertTrue(policy.accepts(DeviceSocketReconnectPolicy.WakeSignal.FOREGROUND))
        policy.recordFailure(DeviceSocketAttemptFailure.RateLimited)
        assertFalse(policy.accepts(DeviceSocketReconnectPolicy.WakeSignal.FOREGROUND))
        policy.recordFailure(DeviceSocketAttemptFailure.Trust("x"))
        assertTrue(policy.accepts(DeviceSocketReconnectPolicy.WakeSignal.CONNECTIVITY_RESTORED))
        policy.recordConnected()
        assertNull(policy.lastFailure)
    }

    @Test
    fun classification() {
        fun classify(error: Throwable, code: Int? = null, hello: Boolean = false) =
            DeviceSocketAttemptFailure.fromTransport(error, code, hello)
        assertEquals(Network("x"), classify(ConnectException("x")))
        assertEquals(DeviceSocketAttemptFailure.Server(503), classify(IOException("x"), code = 503))
        assertEquals(DeviceSocketAttemptFailure.RateLimited, classify(IOException("x"), code = 429))
        assertTrue(classify(IOException("x"), code = 401) is DeviceSocketAttemptFailure.Authentication)
        assertTrue(classify(IOException("x"), code = 403) is DeviceSocketAttemptFailure.Authentication)
        assertTrue(classify(SSLPeerUnverifiedException("x")) is DeviceSocketAttemptFailure.Trust)
        assertTrue(
            classify(SSLHandshakeException("x").apply { initCause(CertificateException("pin")) })
                is DeviceSocketAttemptFailure.Trust,
        )
        assertEquals(Network("x"), classify(IOException("x"), code = 101, hello = true))
        assertTrue(DeviceSocketAttemptFailure.fromHello("invalid_token", "m") is DeviceSocketAttemptFailure.Authentication)
        assertEquals(DeviceSocketAttemptFailure.RateLimited, DeviceSocketAttemptFailure.fromHello("rate_limited", "m"))
        assertEquals(
            DeviceSocketAttemptFailure.Incompatible("m"),
            DeviceSocketAttemptFailure.fromHello("protocol_version_mismatch", "m"),
        )
    }

    @Test
    fun path_transitions() {
        assertEquals(NetworkPathSnapshot.Transition.UNCHANGED, wifi.transitionFrom(null))
        assertEquals(NetworkPathSnapshot.Transition.UNCHANGED, wifi.transitionFrom(wifi))
        assertEquals(NetworkPathSnapshot.Transition.LOST, noNetwork.transitionFrom(wifi))
        assertEquals(NetworkPathSnapshot.Transition.UNCHANGED, noNetwork.transitionFrom(noNetwork))
        assertEquals(NetworkPathSnapshot.Transition.RESTORED, wifi.transitionFrom(noNetwork))
        assertEquals(NetworkPathSnapshot.Transition.RESTORED, cellular.transitionFrom(wifi))
        assertEquals(
            "passing a Wi-Fi sign-in page counts",
            NetworkPathSnapshot.Transition.RESTORED,
            wifi.copy(isValidated = true).transitionFrom(wifi),
        )
    }
}

class GatewayConnectionStatusTest {
    private fun reconnecting(network: NetworkAvailability, attempts: Int = 1) =
        GatewayConnectionStatus.of(ConnectionState.Reconnecting(network, "Failed to connect", attempts))

    private fun GatewayConnectionStatus.mentionsPairing() = explanation.orEmpty().lowercase().contains("pair")

    @Test
    fun offline_is_calm_and_never_mentions_pairing_however_long_it_lasts() {
        val status = reconnecting(NetworkAvailability.UNAVAILABLE, attempts = 500)
        assertEquals("Waiting for network", status.title)
        assertEquals(GatewayConnectionStatus.Tone.WAITING, status.tone)
        assertFalse(status.mentionsPairing())
        assertEquals("Failed to connect", status.diagnostic)
    }

    @Test
    fun brief_unreachability_does_not_mention_pairing() {
        val status = reconnecting(NetworkAvailability.AVAILABLE, GatewayConnectionStatus.SUSTAINED_FAILURE_ATTEMPTS - 1)
        assertEquals("Reconnecting to gateway", status.title)
        assertFalse(status.mentionsPairing())
    }

    @Test
    fun sustained_unreachability_adds_address_advice_while_still_retrying() {
        val status = reconnecting(NetworkAvailability.AVAILABLE, GatewayConnectionStatus.SUSTAINED_FAILURE_ATTEMPTS)
        assertEquals(GatewayConnectionStatus.Tone.PROGRESS, status.tone)
        assertTrue(status.explanation!!.contains("Tailscale"))
        assertTrue(status.mentionsPairing())
    }

    @Test
    fun persistent_failures_keep_their_detail_and_warn() {
        for (kind in FailureKind.values()) {
            val status = GatewayConnectionStatus.of(ConnectionState.Failed(kind, "gateway said no"))
            assertEquals(GatewayConnectionStatus.Tone.WARNING, status.tone)
            assertEquals("gateway said no", status.diagnostic)
        }
    }

    @Test
    fun steady_states_have_no_explanation() {
        assertEquals("Connecting…", GatewayConnectionStatus.of(ConnectionState.Connecting).title)
        val connected = GatewayConnectionStatus.of(ConnectionState.Connected("d", "n", emptyList()))
        assertEquals("Connected", connected.title)
        assertNull(connected.explanation)
    }
}

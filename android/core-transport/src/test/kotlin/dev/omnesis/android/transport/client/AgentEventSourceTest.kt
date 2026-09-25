// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.AgentEvent
import java.time.Duration
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The agent SSE stream must not lose an event, however far the collector falls behind.
 *
 * Nothing downstream can recover a dropped one: the connection stays healthy, so there is
 * no reconnect to replay it, and `Last-Event-ID` only ever advances over what was actually
 * delivered. A lost text delta silently truncates the answer mid-sentence, and a lost
 * `agent.message.end` strands the turn "running" — dots up, sub-agent cards never folded —
 * until the conversation is reopened.
 *
 * A streamed answer arrives in a burst far faster than the collector (reducer → state →
 * recomposition) drains it, so this is the ordinary case, not a pathological one.
 */
class AgentEventSourceTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    /**
     * Shaped like the streaming client production uses ([PinnedOkHttp.buildStreaming]): an agent
     * stream is long-lived and quiet between turns, so read and call timeouts are disabled. A
     * default-timeout client would fail on an idle stream the real one holds open.
     */
    private fun source() = AgentEventSource(
        OkHttpClient.Builder().readTimeout(Duration.ZERO).callTimeout(Duration.ZERO).build(),
        server.url("/").toString(),
        "tok",
    )

    private fun watchedSource(idleTimeoutMs: Long, watchdogIntervalMs: Long) = AgentEventSource(
        OkHttpClient.Builder().readTimeout(Duration.ZERO).callTimeout(Duration.ZERO).build(),
        server.url("/").toString(),
        "tok",
        idleTimeoutMs = idleTimeoutMs,
        watchdogIntervalMs = watchdogIntervalMs,
    )

    /** `count` text deltas followed by the `message.end` that retires the turn, as SSE frames. */
    private fun burst(count: Int): String = buildString {
        for (i in 1..count) {
            append("id: $i\n")
            append("""data: {"type":"agent.text.delta","payload":{"sessionId":"s1","messageId":"m1","delta":"$i "}}""")
            append("\n\n")
        }
        append("id: ${count + 1}\n")
        append("""data: {"type":"agent.message.end","payload":{"sessionId":"s1","messageId":"m1","stopReason":"end_turn"}}""")
        append("\n\n")
    }

    // 400 events is several times the 64-slot buffer a `callbackFlow` channel defaults to. The
    // collector pauses between events as a real one does (reduce, update state, recompose), so a
    // non-suspending `trySend` discards everything past the first ~64 — a truncated answer with
    // no terminal event, which is exactly the reported bug.
    @Test fun a_collector_slower_than_the_stream_still_receives_every_event() = runBlocking {
        val count = 400
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(burst(count)),
        )

        val received = mutableListOf<AgentStreamItem>()
        source().events().collect {
            received += it
            delay(1)
        }

        assertEquals("every delta and the terminal event arrive", count + 1, received.size)
        assertEquals("in the order the gateway sent them", (1..count + 1).map { it.toString() }, received.map { it.id })
        val deltas = received.mapNotNull { (it.event as? AgentEvent.TextDelta)?.delta }
        assertEquals("no delta is missing from the answer", (1..count).joinToString("") { "$it " }, deltas.joinToString(""))
        assertEquals(
            "and the turn's terminal event is delivered, so the UI can retire it",
            AgentEvent.MessageEnd("s1", "m1", "end_turn"),
            received.last().event,
        )
    }

    // A frame whose payload no longer decodes (a type this build knows, sent in a shape it
    // doesn't) is skipped, but the stream must continue past it: the deltas around it and the
    // turn's terminal `message.end` still arrive, so one bad frame can't strand the turn
    // "running" until the conversation is reopened. The skip is logged in production
    // (`Omnesis:agent-sse`) so logcat names the lost shape.
    @Test fun a_malformed_frame_is_skipped_without_breaking_the_stream() = runBlocking {
        val body = buildString {
            append("id: 1\n")
            append("""data: {"type":"agent.text.delta","payload":{"sessionId":"s1","messageId":"m1","delta":"a "}}""")
            append("\n\n")
            append("id: 2\n")
            append("""data: {"type":"agent.text.delta","payload":{"sessionId":"s1","messageId":"m1","delta":{"text":"a "}}}""")
            append("\n\n")
            append("id: 3\n")
            append("""data: {"type":"agent.text.delta","payload":{"sessionId":"s1","messageId":"m1","delta":"b "}}""")
            append("\n\n")
            append("id: 4\n")
            append("""data: {"type":"agent.message.end","payload":{"sessionId":"s1","messageId":"m1","stopReason":"end_turn"}}""")
            append("\n\n")
        }
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(body),
        )

        val received = withTimeout(10_000) { source().events().toList() }

        assertEquals("the bad frame is dropped, everything else arrives", 3, received.size)
        assertEquals(listOf("1", "3", "4"), received.map { it.id })
        assertEquals(
            "the surviving deltas still form the answer",
            "a b ",
            received.mapNotNull { (it.event as? AgentEvent.TextDelta)?.delta }.joinToString(""),
        )
        assertTrue(
            "and the terminal event retires the turn",
            received.last().event is AgentEvent.MessageEnd,
        )
    }

    // Suspending on a full buffer means the producer can be parked inside `send` when the
    // collector walks away. It has to unwind promptly and release the HTTP call rather than
    // leaving a coroutine blocked on a socket read that nothing will ever drain.
    @Test fun a_collector_that_stops_early_unwinds_a_suspended_producer() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(burst(5_000)),
        )
        val client = OkHttpClient.Builder().readTimeout(Duration.ZERO).callTimeout(Duration.ZERO).build()

        val received = withTimeout(10_000) {
            AgentEventSource(client, server.url("/").toString(), "tok").events().take(5).toList()
        }

        assertEquals("the collector gets what it asked for", 5, received.size)
        assertTrue(
            "and the stream's HTTP call is released rather than left running",
            await { client.dispatcher.runningCallsCount() == 0 },
        )
    }

    // A stream the gateway refuses must surface as a transport error the coordinator can back off
    // on, not as an empty stream that completes as though the turn had nothing more to say.
    @Test fun a_refused_stream_surfaces_the_status() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("nope"))

        val error = runCatching { source().events().toList() }.exceptionOrNull()

        assertTrue(error is GatewayException.Unauthorized)
    }

    @Test fun on_open_runs_only_after_the_stream_is_accepted() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(burst(1)),
        )
        var accepted = false

        source().events(onOpen = { accepted = true }).toList()

        assertTrue(accepted)

        server.enqueue(MockResponse().setResponseCode(403).setBody("disabled"))
        accepted = false
        val error = runCatching { source().events(onOpen = { accepted = true }).toList() }.exceptionOrNull()
        assertTrue("a rejected stream is never reported as attached", !accepted)
        assertTrue(error is GatewayException.Forbidden)
    }

    // A half-open socket — headers flushed, then nothing, as after a NAT rebind or a
    // Wi-Fi↔cellular handoff — must fail the flow so the coordinator's supervisor
    // reconnects and the gateway replays the tail. Before the watchdog this blocked in
    // the socket read forever: the turn's head rendered ("Thinking") while its text
    // and `message.end` never arrived, stranding the turn "running". Mirrors the iOS
    // `streamIdleTimeout` watchdog.
    @Test fun a_stream_that_goes_silent_fails_so_the_supervisor_can_reconnect() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBodyDelay(1, TimeUnit.SECONDS)
                .setBody(burst(1)),
        )
        var accepted = false

        val error = withTimeout(10_000) {
            runCatching {
                watchedSource(idleTimeoutMs = 300, watchdogIntervalMs = 50)
                    .events(onOpen = { accepted = true })
                    .toList()
            }.exceptionOrNull()
        }

        assertTrue("headers flushed, so the stream counts as attached", accepted)
        assertTrue(
            "silence past the idle ceiling surfaces as a transport error, not a hang",
            error is GatewayException.Network,
        )
        assertTrue(
            "naming the stall so logs point at the dead socket, not the turn",
            error?.message?.contains("stalled") == true,
        )
        // Let the server's delayed body land on the cancelled connection so its dispatch
        // task is done before tearDown shuts the server down.
        delay(1200)
    }

    // The watchdog must not fire on a healthy stream: silence within the window —
    // headers flushed, body still forming — completes normally. Guards against a
    // mis-initialised byte clock failing every stream on attach.
    @Test fun silence_within_the_window_does_not_fire_the_watchdog() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBodyDelay(300, TimeUnit.MILLISECONDS)
                .setBody(burst(2)),
        )

        val received = withTimeout(10_000) {
            watchedSource(idleTimeoutMs = 5_000, watchdogIntervalMs = 50).events().toList()
        }

        assertEquals("the burst and its terminal event arrive", 3, received.size)
        assertTrue(received.last().event is AgentEvent.MessageEnd)
    }

    // Degenerate tunables must fail at construction, not kill every healthy stream on
    // the watchdog's first check (`0` is OkHttp's own "no timeout" convention, so it
    // is the obvious wrong value to reach for here).
    @Test fun non_positive_watchdog_tunables_are_rejected() {
        val client = OkHttpClient.Builder().build()
        val url = server.url("/").toString()
        assertTrue(
            runCatching {
                AgentEventSource(client, url, "tok", idleTimeoutMs = 0, watchdogIntervalMs = 50)
            }.exceptionOrNull() is IllegalArgumentException,
        )
        assertTrue(
            runCatching {
                AgentEventSource(client, url, "tok", idleTimeoutMs = 60_000, watchdogIntervalMs = 0)
            }.exceptionOrNull() is IllegalArgumentException,
        )
    }

    /** Poll for a condition the OkHttp dispatcher settles into off the test thread. */
    private fun await(timeoutMs: Long = 5_000, predicate: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return true
            Thread.sleep(10)
        }
        return predicate()
    }
}

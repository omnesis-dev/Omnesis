// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.AgentEventSource
import dev.omnesis.android.transport.client.ConversationCapabilities
import dev.omnesis.android.transport.client.ConversationControls
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * A sent message is on screen from the moment Send is tapped until the gateway's own copy
 * replaces it, with no instant in between where it is nowhere.
 *
 * A message that starts a turn is a transcript bubble at once. A follow-up sent while a
 * turn runs is a pending row at once, and the controls snapshot that lists it as queued
 * replaces that row in the same state update. A refused send withdraws the bubble and
 * leaves the pending row to own the retry.
 *
 * All fixture data is invented.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AgentCoordinatorSentMessageTest {
    private lateinit var server: MockWebServer
    private val coordinators = mutableListOf<AgentCoordinator>()
    private val collectors = mutableListOf<Job>()

    /** Submissions the stub gateway queued, listed by its controls snapshot. */
    private val queuedIds = CopyOnWriteArrayList<String>()
    @Volatile private var submissionStatus = 202
    @Volatile private var submissionDelayMs = 300L

    @Before fun setUp() {
        Dispatchers.setMain(kotlinx.coroutines.test.UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.endsWith("/submissions") -> {
                        val body = request.body.readUtf8()
                        val id = Regex("\"clientMessageId\":\"([^\"]+)\"").find(body)?.groupValues?.get(1) ?: "unknown"
                        val text = Regex("\"text\":\"([^\"]+)\"").find(body)?.groupValues?.get(1) ?: ""
                        if (submissionStatus != 202) return MockResponse().setResponseCode(submissionStatus).setBody("""{"error":"nope"}""")
                        queuedIds += id
                        MockResponse().setResponseCode(202).setBodyDelay(submissionDelayMs, TimeUnit.MILLISECONDS)
                            .setBody("""{"submission":{"id":"$id","text":"$text","status":"queued"},"busy":true,"capabilities":{"coalescedQueue":true,"queueSendNow":true},"queuedMessages":[]}""")
                    }
                    path.endsWith("/controls") -> MockResponse().setBody(
                        """{"busy":true,"capabilities":{"coalescedQueue":true,"queueSendNow":true},"queuedMessages":[""" +
                            queuedIds.joinToString(",") { """{"id":"$it","text":"more","status":"queued"}""" } + "]}",
                    )
                    path.startsWith("/agent/events") -> MockResponse().setResponseCode(200).setBody("")
                    path.startsWith("/agent/conversations") ->
                        MockResponse().setBody("""{"conversations":[],"nextCursor":null}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun tearDown() {
        val scopeField = AgentCoordinator::class.java.getDeclaredField("scope").apply { isAccessible = true }
        try {
            runBlocking {
                withTimeout(5_000) {
                    collectors.forEach { it.cancelAndJoin() }
                    coordinators.forEach { it.teardown() }
                    coordinators.forEach { coordinator ->
                        val scope = scopeField.get(coordinator) as CoroutineScope
                        checkNotNull(scope.coroutineContext[Job]).cancelAndJoin()
                    }
                }
            }
        } finally {
            try {
                server.shutdown()
            } finally {
                Dispatchers.resetMain()
            }
        }
    }

    private fun client() = AgentClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
    private fun eventSource() = AgentEventSource(OkHttpClient(), server.url("/").toString(), "tok")

    private fun coordinator(chat: AgentChatState): Pair<AgentCoordinator, MutableList<AgentCoordinator.UiState>> {
        val coord = AgentCoordinator().also { coordinators += it }
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true, sessionId = "conv_a", controlsAvailable = true,
                controls = ConversationControls(busy = chat.busy, capabilities = ConversationCapabilities(coalescedQueue = true, queueSendNow = true)),
                chat = chat,
            ),
        )
        val observed = CopyOnWriteArrayList<AgentCoordinator.UiState>()
        collectors += CoroutineScope(Dispatchers.Unconfined).launch { coord.state.collect { observed += it } }
        return coord to observed
    }

    private fun await(timeoutMs: Long = 3_000, predicate: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return true
            Thread.sleep(15)
        }
        return predicate()
    }

    private fun AgentCoordinator.UiState.bubble(id: String) = chat.turns.any { it is AgentTurn.User && it.id == id }
    private fun AgentCoordinator.UiState.pendingRow(id: String) =
        composer.pending.any { it.clientMessageId == id } && id !in presentedSubmissionIds
    private fun AgentCoordinator.UiState.queuedCard(id: String) = controls.queuedMessages.any { it.id == id && it.status == "queued" }

    @Test
    fun a_turn_starting_send_is_a_transcript_bubble_before_the_gateway_answers() {
        val (coord, observed) = coordinator(AgentChatState())
        coord.submitFollowUp("hi")

        val now = coord.state.value
        val id = now.composer.pending.single().clientMessageId
        assertEquals(listOf(AgentTurn.User(id, "hi")), now.chat.turns)
        assertTrue("the bubble claims the turn", now.chat.busy)
        assertFalse("not also a pending row", now.pendingRow(id))

        assertTrue(await { coord.state.value.composer.pending.isEmpty() })
        assertTrue(coord.state.value.bubble(id))
        assertTrue(
            "the bubble never left while the send was confirmed",
            observed.dropWhile { !it.bubble(id) }.all { it.bubble(id) },
        )
    }

    @Test
    fun a_follow_up_while_a_turn_runs_is_never_nowhere_between_pending_and_queued() {
        val running = AgentChatState(turns = listOf(AgentTurn.User("u-0", "first"), AgentTurn.Assistant(id = "m-0")), busy = true)
        val (coord, observed) = coordinator(running)
        coord.submitFollowUp("more")

        val now = coord.state.value
        val id = now.composer.pending.single().clientMessageId
        assertEquals("the running turn's transcript is untouched", running.turns, now.chat.turns)
        assertTrue("a pending row at once", now.pendingRow(id))

        assertTrue(await { coord.state.value.queuedCard(id) })
        assertFalse("the queue card replaced the pending row", coord.state.value.pendingRow(id))
        val since = observed.dropWhile { !it.pendingRow(id) }
        assertTrue(since.isNotEmpty())
        assertTrue(
            "every state shows the follow-up as a pending row or a queued card",
            since.all { it.pendingRow(id) || it.queuedCard(id) },
        )
    }

    @Test
    fun a_refused_send_withdraws_the_bubble_and_leaves_the_pending_row_to_retry() {
        submissionStatus = 500
        val (coord, _) = coordinator(AgentChatState())
        coord.submitFollowUp("hi")
        val id = coord.state.value.composer.pending.single().clientMessageId
        assertTrue(coord.state.value.bubble(id))

        assertTrue(await { coord.state.value.chat.lastTurnError != null })
        val after = coord.state.value
        assertFalse("the transcript placeholder is gone", after.bubble(id))
        assertFalse("the turn it claimed is released", after.chat.busy)
        assertTrue("the pending row owns the retry", after.pendingRow(id))
    }
}

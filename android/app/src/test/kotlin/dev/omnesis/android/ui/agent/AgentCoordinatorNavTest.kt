// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.AgentEventSource
import dev.omnesis.android.transport.client.AgentStreamItem
import dev.omnesis.android.transport.dto.AgentConversationTerminalFailure
import dev.omnesis.android.transport.dto.AgentContextAssessment
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentPlanItem
import dev.omnesis.android.transport.dto.AgentTerminalFailure
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.UserPart
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonNull
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Exercises the snappy-navigation orchestration in [AgentCoordinator]: a new conversation clears
 * instantly with no network, a resume switches the surface immediately (title + skeleton) before
 * the transcript loads, the first send shows optimistically while its session is minted, and the
 * composer gate + failure paths behave. The Android twin of the iOS
 * `AgentCoordinatorResumeTests`.
 *
 * Drives the real [AgentClient] against a [MockWebServer]; coordinator coroutines run on the
 * real [Dispatchers.Unconfined] installed as `Main`, so a launched session request resumes
 * eagerly the instant the mocked response lands, and no test-scheduler state can leak into
 * later tests. State that settles after real I/O is awaited via [await].
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AgentCoordinatorNavTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() {
        Dispatchers.setMain(Dispatchers.Unconfined)
        server = MockWebServer()
        server.start()
    }

    @After fun tearDown() {
        server.shutdown()
        Dispatchers.resetMain()
    }

    private fun client(okHttp: OkHttpClient = OkHttpClient()) =
        AgentClient(GatewayHttp(okHttp, server.url("/").toString(), "tok"))

    private fun clientWithFinishedCalls(finished: CountDownLatch): AgentClient {
        val listener = object : EventListener() {
            override fun callEnd(call: Call) = finished.countDown()
            override fun callFailed(call: Call, ioe: IOException) = finished.countDown()
        }
        return client(OkHttpClient.Builder().eventListener(listener).build())
    }
    private fun eventSource() = AgentEventSource(OkHttpClient(), server.url("/").toString(), "tok")

    /** Route MockWebServer by path; `/messages` is checked before `/agent/sessions` (it's a prefix). */
    private fun routing(
        session: MockResponse? = null,
        message: MockResponse? = null,
        conversations: MockResponse? = null,
        cancel: MockResponse? = null,
    ): Dispatcher =
        object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.startsWith("/agent/events") -> MockResponse().setResponseCode(200).setBody("")
                    path.endsWith("/cancel") -> cancel ?: MockResponse().setBody("""{"ok":true}""")
                    path.contains("/messages") -> message ?: MockResponse().setBody("""{"messageId":"a1","userMessageId":"u1"}""")
                    path.startsWith("/agent/sessions") -> session ?: MockResponse().setResponseCode(404)
                    path.startsWith("/agent/conversations") ->
                        conversations ?: MockResponse().setBody("""{"conversations":[],"nextCursor":null}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

    private fun await(timeoutMs: Long = 3_000, predicate: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return true
            Thread.sleep(15)
        }
        return predicate()
    }

    @Test
    fun ephemeral_gate_auto_flushes_when_no_card_is_composed() {
        val coord = AgentCoordinator()
        coord.ephemeralGateMaxHoldMs = 25L
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_live"),
        )
        coord.applyEventForTesting(AgentEvent.MessageStart("s_live", "a1"))
        coord.applyEventForTesting(
            AgentEvent.ToolStart("s_live", "a1", "loops-1", "list_loops", JsonNull, null),
        )
        coord.applyEventForTesting(
            AgentEvent.ToolResult(
                "s_live",
                "a1",
                "loops-1",
                AgentToolResult.Structured("loops.listed", JsonNull),
                0.1,
            ),
        )
        coord.applyEventForTesting(AgentEvent.TextDelta("s_live", "a1", "Ready."))

        assertTrue(coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>()
            .last().parts.none { it is AgentPart.Text })
        assertTrue(await { coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>()
            .last().parts.filterIsInstance<AgentPart.Text>().singleOrNull()?.text == "Ready." })
    }

    @Test
    fun ephemeral_gate_timeout_cannot_flush_a_replaced_session() {
        val coord = AgentCoordinator()
        coord.ephemeralGateMaxHoldMs = 40L
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_old"),
        )
        coord.applyEventForTesting(AgentEvent.MessageStart("s_old", "a1"))
        coord.applyEventForTesting(
            AgentEvent.ToolStart("s_old", "a1", "loops-old", "list_loops", JsonNull, null),
        )
        coord.applyEventForTesting(
            AgentEvent.ToolResult(
                "s_old", "a1", "loops-old",
                AgentToolResult.Structured("loops.listed", JsonNull), 0.1,
            ),
        )
        coord.applyEventForTesting(AgentEvent.TextDelta("s_old", "a1", "stale"))

        val replacement = AgentCoordinator.UiState(
            hasClient = true,
            sessionId = "s_new",
            chat = AgentChatState(turns = listOf(AgentTurn.User("u-new", "Fresh conversation"))),
        )
        coord.attachForTesting(client(), eventSource(), replacement)
        Thread.sleep(75)

        assertEquals(replacement, coord.state.value)
    }

    @Test
    fun ephemeral_gate_timeout_rearms_for_a_queued_successor_gate() {
        val coord = AgentCoordinator()
        coord.ephemeralGateMaxHoldMs = 25L
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_live"),
        )
        coord.applyEventForTesting(AgentEvent.MessageStart("s_live", "a1"))
        fun start(id: String) = AgentEvent.ToolStart(
            "s_live", "a1", id, "list_loops", JsonNull, null,
        )
        fun result(id: String) = AgentEvent.ToolResult(
            "s_live", "a1", id,
            AgentToolResult.Structured("loops.listed", JsonNull), 0.1,
        )
        coord.applyEventForTesting(start("loops-1"))
        coord.applyEventForTesting(result("loops-1"))
        coord.applyEventForTesting(start("loops-2"))
        coord.applyEventForTesting(result("loops-2"))
        coord.applyEventForTesting(AgentEvent.TextDelta("s_live", "a1", "Both ready."))

        assertTrue(await { coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>()
            .last().parts.filterIsInstance<AgentPart.Text>().singleOrNull()?.text == "Both ready." })
    }

    @Test
    fun newConversation_clears_instantly_without_network() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_live",
                title = "Prior chat",
                chat = AgentChatState(turns = listOf(AgentTurn.User("u1", "hi"))),
                terminalFailure = AgentConversationTerminalFailure(
                    code = "context_window_exceeded",
                    message = "Context window reached.",
                    backend = "openai-compatible",
                    model = "fictional-model",
                    failedAt = "2026-07-29T12:00:00.000Z",
                ),
            ),
        )

        coord.newConversation()

        val st = coord.state.value
        assertNull("a fresh conversation carries no session id", st.sessionId)
        assertTrue("the transcript clears immediately", st.chat.turns.isEmpty())
        assertEquals("", st.title)
        assertFalse(st.transcriptLoading)
        assertNull(st.terminalFailure)
        assertTrue("a fresh conversation is typable immediately", st.canCompose)
        assertEquals("new conversation must not hit the network", 0, server.requestCount)
    }

    @Test
    fun pin_failure_uses_the_action_error_without_overwriting_list_load_errors() {
        server.enqueue(
            MockResponse()
                .setResponseCode(500)
                .setBody("""{"error":"pin refused"}"""),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_active",
                conversationsError = "Earlier list refresh failed",
            ),
        )

        coord.togglePin("s_active", true)

        assertTrue(await { coord.state.value.conversationActionError != null })
        assertTrue(coord.state.value.conversationActionError!!.startsWith("Could not pin this chat:"))
        assertEquals("Earlier list refresh failed", coord.state.value.conversationsError)
    }

    @Test
    fun duplicate_delete_is_suppressed_and_success_reconciles_after_navigation() {
        val deletes = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path?.startsWith("/agent/events") == true ->
                    MockResponse().setResponseCode(200).setBody("")
                request.method == "DELETE" -> {
                    deletes.incrementAndGet()
                    MockResponse()
                        .setBody("""{"ok":true}""")
                        .setBodyDelay(300, TimeUnit.MILLISECONDS)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_active",
                conversations = listOf(ConversationSummary(sessionId = "s_active", title = "Invented chat")),
            ),
        )

        coord.deleteConversation("s_active")
        coord.deleteConversation("s_active")
        coord.newConversation()

        assertTrue(await { coord.state.value.conversations.isEmpty() })
        assertEquals("only one DELETE reaches the gateway", 1, deletes.get())
        assertNull(coord.state.value.conversationActionError)
    }

    @Test
    fun active_delete_opens_a_fresh_chat_before_the_server_responds() {
        server.enqueue(
            MockResponse()
                .setBody("""{"ok":true}""")
                .setBodyDelay(300, TimeUnit.MILLISECONDS),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_active",
                title = "Invented chat",
                chat = AgentChatState(turns = listOf(AgentTurn.User("u1", "Summarize this."))),
                conversations = listOf(ConversationSummary(sessionId = "s_active", title = "Invented chat")),
            ),
        )

        coord.deleteConversation("s_active")

        val pending = coord.state.value
        assertNull("the active surface clears synchronously", pending.sessionId)
        assertTrue(pending.chat.turns.isEmpty())
        assertEquals(listOf("s_active"), pending.conversations.map { it.sessionId })

        assertTrue(await { coord.state.value.conversations.isEmpty() })
    }

    @Test
    fun failed_active_delete_keeps_the_fresh_surface_and_sidebar_row() {
        server.enqueue(
            MockResponse()
                .setResponseCode(503)
                .setBody("""{"error":"temporarily unavailable"}"""),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_active",
                title = "Invented chat",
                chat = AgentChatState(turns = listOf(AgentTurn.User("u1", "Summarize this."))),
                conversations = listOf(ConversationSummary(sessionId = "s_active", title = "Invented chat")),
            ),
        )

        coord.deleteConversation("s_active")

        assertNull(coord.state.value.sessionId)
        assertTrue(coord.state.value.chat.turns.isEmpty())
        assertTrue(await { coord.state.value.conversationActionError != null })
        assertEquals(listOf("s_active"), coord.state.value.conversations.map { it.sessionId })
        assertNull("the blank surface owns the failure banner", coord.state.value.conversationActionErrorSessionId)
    }

    @Test
    fun pin_updates_active_state_even_when_summary_is_not_loaded() {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_active"),
        )

        coord.togglePin("s_active", true)

        assertTrue(await { coord.state.value.activeConversationPinned })
        assertTrue(coord.state.value.conversations.isEmpty())
    }

    @Test
    fun stale_refresh_cannot_undo_a_successful_pin() {
        val listStarted = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.method == "GET" && request.path?.startsWith("/agent/conversations") == true -> {
                    listStarted.countDown()
                    MockResponse()
                        .setBody(
                            """{"conversations":[{"id":"s_active","title":"Invented chat","pinned":false}],"nextCursor":null}""",
                        )
                        .setBodyDelay(300, TimeUnit.MILLISECONDS)
                }
                request.method == "PATCH" -> MockResponse().setBody("""{"ok":true}""")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_active",
                conversations = listOf(ConversationSummary(sessionId = "s_active", title = "Invented chat")),
            ),
        )

        coord.refreshConversationsPublic()
        assertTrue(listStarted.await(1, TimeUnit.SECONDS))
        coord.togglePin("s_active", true)

        assertTrue(await { coord.state.value.activeConversationPinned })
        Thread.sleep(400)
        assertTrue(coord.state.value.activeConversationPinned)
        assertEquals(true, coord.state.value.conversations.single().pinned)
    }

    @Test
    fun first_send_shows_bubble_and_busy_state_while_session_mint_is_in_flight() {
        server.dispatcher = routing(
            session = MockResponse()
                .setBody("""{"sessionId":"s_minted","model":"m","backend":"b","messages":[]}""")
                .setBodyDelay(400, TimeUnit.MILLISECONDS),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true))

        coord.send("hello")

        val pending = coord.state.value
        assertNull("the session response is still held", pending.sessionId)
        assertEquals(
            "the user's message replaces the landing page before the mint returns",
            listOf("hello"),
            pending.chat.turns.filterIsInstance<AgentTurn.User>().map { it.text },
        )
        assertTrue("the pre-start working indicator owns the beat while busy", pending.chat.busy)
        assertTrue("the working dots trail the user bubble before message.start", pending.chat.turns.last() is AgentTurn.User)

        assertTrue("send mints a session when none exists", await { coord.state.value.sessionId == "s_minted" })
        assertEquals(
            "the mint preserves the optimistic bubble",
            listOf("hello"),
            coord.state.value.chat.turns.filterIsInstance<AgentTurn.User>().map { it.text },
        )
        assertTrue("the turn stays busy while the agent response is pending", coord.state.value.chat.busy)
        assertTrue("the message POST follows the mint", await { server.requestCount == 2 })
        assertEquals("the mint and message are each requested once", 2, server.requestCount)
    }

    @Test
    fun resume_switches_surface_immediately_then_loads() {
        server.dispatcher = routing(
            session = MockResponse()
                .setBody("""{"sessionId":"s_target","model":"m","backend":"b","title":"Trip planning","messages":[]}""")
                // Hold the body so the loading state is observable before the reconcile.
                .setBodyDelay(300, TimeUnit.MILLISECONDS),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_other",
                conversations = listOf(ConversationSummary(sessionId = "s_target", title = "Trip planning")),
            ),
        )

        coord.resumeConversation("s_target")

        // The surface flips to the target immediately — before the transcript round-trip lands.
        val mid = coord.state.value
        assertEquals("s_target", mid.sessionId)
        assertTrue("a loading skeleton shows immediately", mid.transcriptLoading)
        assertEquals("the known title shows during load", "Trip planning", mid.title)
        assertTrue(mid.chat.turns.isEmpty())
        assertFalse("the composer is disabled until the transcript lands", mid.canCompose)

        // Then the load reconciles and the skeleton clears.
        assertTrue(await { !coord.state.value.transcriptLoading })
        assertEquals("s_target", coord.state.value.sessionId)
    }

    @Test
    fun resume_ignores_retap_on_active_conversation() {
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true, sessionId = "s_active"))

        coord.resumeConversation("s_active")

        assertEquals("re-opening the active conversation makes no request", 0, server.requestCount)
        assertFalse(coord.state.value.transcriptLoading)
    }

    @Test
    fun snapshot_handoff_applies_only_events_newer_than_cursor() {
        val coord = AgentCoordinator()
        coord.applySnapshotForTesting(
            session = CreateSessionResponse(
                sessionId = "s1",
                model = "m",
                backend = "b",
                busy = true,
                messages = listOf(ChatMessage.Assistant(listOf(AssistantPart.Text("Snapshot ")))),
                replayEvents = listOf(
                    AgentEvent.ToolResult(
                        "s1",
                        "m1",
                        "plan",
                        AgentToolResult.PlanUpdated(listOf(AgentPlanItem("p1", "Inspect sources", "in_progress"))),
                    ),
                    AgentEvent.ToolStart("s1", "m1", "batch", "search_many", JsonNull),
                    AgentEvent.ToolChildStart("s1", "m1", "batch", 0, "search_documents", "first branch"),
                    AgentEvent.SubagentSpawned(
                        sessionId = "s1",
                        subagentId = "s1.sub.generic",
                        specialist = "generic",
                        task = "Inspect an independent branch",
                    ),
                ),
                eventCursor = 12,
            ),
            buffered = listOf(
                AgentStreamItem("12", AgentEvent.TextDelta("s1", "m1", "duplicate ")),
                AgentStreamItem("13", AgentEvent.TextDelta("s1", "m1", "after")),
            ),
        )

        val assistant = coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals("Snapshot after", assistant.parts.filterIsInstance<AgentPart.Text>().joinToString("") { it.text })
        assertEquals(listOf("p1"), coord.state.value.chat.planItems.map { it.id })
        assertEquals(1, assistant.parts.filterIsInstance<AgentPart.Tool>().single().call.children.size)
        assertEquals(1, assistant.parts.filterIsInstance<AgentPart.Subagent>().size)
        assertTrue("the resumed live turn keeps its busy state", coord.state.value.chat.busy)
        assertFalse("generic replay must not arm Deep Research", coord.state.value.chat.deepResearch)
    }

    @Test
    fun overlapping_snapshot_failure_drains_carried_same_session_buffer() {
        val coord = AgentCoordinator()
        coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId = "s1",
                model = "m",
                backend = "b",
                busy = true,
                messages = listOf(ChatMessage.Assistant(listOf(AssistantPart.Text("Snapshot ")))),
            ),
            emptyList(),
        )
        coord.beginSnapshotHandoffForTesting("s1")
        coord.bufferSnapshotEventForTesting(
            AgentStreamItem("11", AgentEvent.TextDelta("s1", "m1", "first ")),
        )
        val superseding = coord.beginSnapshotHandoffForTesting("s1")
        coord.bufferSnapshotEventForTesting(
            AgentStreamItem("99", AgentEvent.TextDelta("other", "m2", "wrong ")),
        )
        coord.bufferSnapshotEventForTesting(
            AgentStreamItem("12", AgentEvent.TextDelta("s1", "m1", "second")),
        )

        coord.failSnapshotHandoffForTesting(superseding, "s1")

        val assistant = coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals(
            "Snapshot first second",
            assistant.parts.filterIsInstance<AgentPart.Text>().joinToString("") { it.text },
        )
    }

    // A stream that outruns the in-flight snapshot must not restart it. Each restart re-opens
    // the same losing race, so a busy turn (a Deep Research fan-out) would leave the transcript
    // frozen mid-answer — text stuck, working dots up, finished cards never folded away — until
    // the conversation was reopened. The handoff instead latches "overflowed" and keeps ONE
    // snapshot in flight.
    @Test
    fun snapshot_handoff_flood_latches_overflow_without_restarting_the_snapshot() {
        val coord = AgentCoordinator()
        val original = coord.beginSnapshotHandoffForTesting("s1")
        repeat(300) { index ->
            coord.bufferSnapshotEventForTesting(
                AgentStreamItem(
                    (index + 1).toString(),
                    AgentEvent.TextDelta("s1", "m1", "x"),
                ),
            )
        }

        val overflow = checkNotNull(coord.snapshotHandoffStateForTesting())
        assertEquals("the snapshot in flight keeps ownership", original, overflow.first)
        assertTrue("the overflow is latched", overflow.third)
        assertEquals("the buffer is released, not merely capped", 0, overflow.second)

        coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId = "s1",
                model = "m",
                backend = "b",
                busy = true,
                messages = listOf(ChatMessage.Assistant(listOf(AssistantPart.Text("Recovered")))),
                eventCursor = 300,
            ),
            overflow.first,
        )
        val assistant = coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals(listOf("Recovered"), assistant.parts.filterIsInstance<AgentPart.Text>().map { it.text })
        assertNull(coord.snapshotHandoffStateForTesting())
    }

    // The dropped events exist nowhere else on the device: `lastEventId` had already advanced
    // past them (it tracks what was RECEIVED, not what was applied), so resuming the stream from
    // it would skip the gap for good. An overflowed handoff rewinds to the snapshot cursor and
    // lets the gateway replay.
    @Test
    fun overflowed_handoff_rewinds_the_stream_cursor_to_the_snapshot() {
        val coord = AgentCoordinator()
        val handoff = coord.beginSnapshotHandoffForTesting("s1")
        repeat(300) { index ->
            coord.bufferSnapshotEventForTesting(
                AgentStreamItem((index + 1).toString(), AgentEvent.TextDelta("s1", "m1", "x")),
            )
        }
        // What the live collector does for every delivered event, dropped or not.
        coord.noteStreamCursorForTesting("300")

        coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId = "s1",
                model = "m",
                backend = "b",
                busy = true,
                messages = listOf(ChatMessage.Assistant(listOf(AssistantPart.Text("Recovered")))),
                eventCursor = 120,
            ),
            handoff,
        )

        assertEquals("120", coord.lastEventIdForTesting())
    }

    // The rewind only helps if the client actually reconnects: the gateway replays a gap only
    // when asked for it with `Last-Event-ID`. A rewind that forgets to reconnect is WORSE than
    // the bug it fixes — the stream stays down with no recovery path — so assert the request.
    @Test
    fun overflowed_handoff_reconnects_the_stream_asking_the_gateway_to_replay() {
        server.dispatcher = routing()
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true, sessionId = "s1"))
        val handoff = coord.beginSnapshotHandoffForTesting("s1")
        repeat(300) { index ->
            coord.bufferSnapshotEventForTesting(
                AgentStreamItem((index + 1).toString(), AgentEvent.TextDelta("s1", "m1", "x")),
            )
        }
        coord.noteStreamCursorForTesting("300")

        coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId = "s1",
                model = "m",
                backend = "b",
                busy = true,
                messages = listOf(ChatMessage.Assistant(listOf(AssistantPart.Text("Recovered")))),
                eventCursor = 120,
            ),
            handoff,
        )

        assertTrue(
            "the stream reconnects from the snapshot cursor, not from the events it dropped",
            awaitEventStreamRequest { it.getHeader("Last-Event-ID") == "120" },
        )
    }

    // Foregrounding cancels the stream so the reconcile snapshot cannot race a live flood. A
    // reconcile that fails must still hand the stream back — otherwise the surface sits with no
    // live events at all until the next foreground, which is worse than never quiescing.
    @Test
    fun foreground_restores_the_stream_even_when_the_reconcile_fails() {
        server.dispatcher = routing(session = MockResponse().setResponseCode(500).setBody("boom"))
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true, sessionId = "s_local"))

        coord.onForeground()

        assertTrue("the event stream is reopened after a failed reconcile", awaitEventStreamRequest { true })
    }

    /** True once some `/agent/events` request satisfying [predicate] reaches the mock gateway. */
    private fun awaitEventStreamRequest(
        timeoutMs: Long = 5_000,
        predicate: (RecordedRequest) -> Boolean,
    ): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val request = server.takeRequest(250, TimeUnit.MILLISECONDS) ?: continue
            if (request.path?.startsWith("/agent/events") == true && predicate(request)) return true
        }
        return false
    }

    // A handoff that never overflowed keeps every buffered event, so there is no gap to replay
    // and the cursor must stay at the newest event seen.
    @Test
    fun unoverflowed_handoff_keeps_the_stream_cursor_ahead_of_the_snapshot() {
        val coord = AgentCoordinator()
        val handoff = coord.beginSnapshotHandoffForTesting("s1")
        coord.bufferSnapshotEventForTesting(
            AgentStreamItem("130", AgentEvent.TextDelta("s1", "m1", "tail")),
        )
        coord.noteStreamCursorForTesting("130")

        coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId = "s1",
                model = "m",
                backend = "b",
                busy = true,
                messages = listOf(ChatMessage.Assistant(listOf(AssistantPart.Text("Snapshot ")))),
                eventCursor = 120,
            ),
            handoff,
        )

        assertEquals("130", coord.lastEventIdForTesting())
        val assistant = coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>().last()
        assertEquals(
            "Snapshot tail",
            assistant.parts.filterIsInstance<AgentPart.Text>().joinToString("") { it.text },
        )
    }

    // An overflowed handoff dropped events that exist nowhere else on the device, so a snapshot
    // that fails cannot be written off as best-effort the way an ordinary one is: the handoff
    // keeps ownership and retries, rather than clearing and leaving the transcript behind.
    @Test
    fun a_failed_snapshot_keeps_ownership_when_the_handoff_overflowed() {
        server.dispatcher = routing(session = MockResponse().setResponseCode(500).setBody("boom"))
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true, sessionId = "s1"))
        val handoff = coord.beginSnapshotHandoffForTesting("s1")
        repeat(300) { index ->
            coord.bufferSnapshotEventForTesting(
                AgentStreamItem((index + 1).toString(), AgentEvent.TextDelta("s1", "m1", "x")),
            )
        }

        coord.failSnapshotHandoffForTesting(handoff, "s1")

        val state = checkNotNull(coord.snapshotHandoffStateForTesting()) {
            "an overflowed handoff must not be cleared by a failed snapshot"
        }
        assertEquals(handoff, state.first)
        assertTrue("and it stays marked overflowed so the retry keeps the rewind duty", state.third)
    }

    // `eventCursor` is absent from a cold-resume snapshot. An overflowed handoff cannot be
    // finished by one: it has no buffer left to fall back on and no cursor to rewind the stream
    // to, so accepting it would abandon the dropped events silently and for good.
    @Test
    fun a_cursorless_snapshot_cannot_finish_an_overflowed_handoff() {
        server.dispatcher = routing(session = MockResponse().setResponseCode(500).setBody("boom"))
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true, sessionId = "s1"))
        val handoff = coord.beginSnapshotHandoffForTesting("s1")
        repeat(300) { index ->
            coord.bufferSnapshotEventForTesting(
                AgentStreamItem((index + 1).toString(), AgentEvent.TextDelta("s1", "m1", "x")),
            )
        }
        coord.noteStreamCursorForTesting("300")

        coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId = "s1",
                model = "m",
                backend = "b",
                busy = true,
                messages = listOf(ChatMessage.Assistant(listOf(AssistantPart.Text("Cold resume")))),
                eventCursor = null,
            ),
            handoff,
        )

        val state = checkNotNull(coord.snapshotHandoffStateForTesting()) {
            "a cursor-less snapshot must not retire an overflowed handoff"
        }
        assertEquals(handoff, state.first)
        assertTrue("the rewind duty survives for the retry", state.third)
        assertEquals("and the cursor is not moved backwards to nowhere", "300", coord.lastEventIdForTesting())
    }

    // A handoff superseded while overflowed hands the rewind duty to its replacement — dropping
    // it would leave the gap unreplayed even though the new snapshot lands cleanly.
    @Test
    fun a_superseding_handoff_inherits_the_overflow() {
        val coord = AgentCoordinator()
        coord.beginSnapshotHandoffForTesting("s1")
        repeat(300) { index ->
            coord.bufferSnapshotEventForTesting(
                AgentStreamItem((index + 1).toString(), AgentEvent.TextDelta("s1", "m1", "x")),
            )
        }

        coord.beginSnapshotHandoffForTesting("s1")

        assertTrue(
            "the replacement carries the overflow forward",
            checkNotNull(coord.snapshotHandoffStateForTesting()).third,
        )
    }

    @Test
    fun failed_resume_surfaces_fatal_and_keeps_composer_disabled() {
        server.dispatcher = routing(session = MockResponse().setResponseCode(500).setBody("boom"))
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true, sessionId = "s_other"))

        coord.resumeConversation("s_target")

        assertTrue("a failed resume surfaces a fatal error", await { coord.state.value.fatalError != null })
        assertFalse("the loading skeleton clears on failure", coord.state.value.transcriptLoading)
        assertEquals("the target id stays adopted", "s_target", coord.state.value.sessionId)
        assertFalse("the composer stays disabled under a fatal error", coord.state.value.canCompose)
    }

    /** One stored page, in the shape `GET /agent/conversations/:id/messages` returns. */
    private fun storedTranscript(text: String) = MockResponse().setBody(
        """{"messages":[{"role":"assistant","parts":[{"kind":"text","text":"$text"}]}],""" +
            """"messagePageInfo":{"nextCursor":null},"messageCount":1,"messagesAreVisible":true}""",
    )

    @Test
    fun resume_without_a_runnable_model_still_shows_the_stored_transcript() {
        // 503 is how the agent routes report "the harness cannot run" — the case where the
        // transcript is perfectly readable and only continuing the thread is not.
        server.dispatcher = routing(
            session = MockResponse().setResponseCode(503)
                .setBody("""{"error":"Backend \"x\" is unreachable","code":"SERVICE_UNAVAILABLE"}"""),
            message = storedTranscript("stored answer"),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true))

        coord.resumeConversation("s_target")

        assertTrue(
            "the stored transcript renders",
            await { coord.state.value.chat.turns.isNotEmpty() },
        )
        assertNull("no error page over readable history", coord.state.value.fatalError)
        assertFalse("the skeleton clears", coord.state.value.transcriptLoading)
        assertEquals(
            AgentCoordinator.READ_ONLY_REASON,
            coord.state.value.liveSessionMissingReason,
        )
        assertFalse("sending stays withheld without a model", coord.state.value.canCompose)
        assertEquals("the target id stays adopted", "s_target", coord.state.value.sessionId)
    }

    @Test
    fun a_read_only_conversation_becomes_writable_once_the_model_returns() {
        server.dispatcher = routing(
            session = MockResponse().setResponseCode(503).setBody("""{"error":"down"}"""),
            message = storedTranscript("stored answer"),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true))
        coord.resumeConversation("s_target")
        assertTrue(await { coord.state.value.liveSessionMissingReason != null })

        // The model comes back; retry mints against the conversation on screen.
        server.dispatcher = routing(
            session = MockResponse().setBody(
                """{"sessionId":"s_target","model":"m","backend":"b","title":"T","messageCount":1,""" +
                    """"messages":[{"role":"assistant","parts":[{"kind":"text","text":"live"}]}],""" +
                    """"eventCursor":0}""",
            ),
        )
        coord.retryLiveSession()

        assertTrue(
            "the composer returns once a session is live",
            await { coord.state.value.liveSessionMissingReason == null },
        )
        assertTrue(coord.state.value.canCompose)
        assertEquals("s_target", coord.state.value.sessionId)
    }

    @Test
    fun resume_still_reports_a_fatal_error_when_the_transcript_is_unreadable_too() {
        // A 503 whose stored transcript also refuses is a genuine failure — the original
        // error is the accurate one to show, not a read-only screen with nothing in it.
        server.dispatcher = routing(
            session = MockResponse().setResponseCode(503).setBody("""{"error":"down"}"""),
            message = MockResponse().setResponseCode(500).setBody("boom"),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true))

        coord.resumeConversation("s_target")

        assertTrue(await { coord.state.value.fatalError != null })
        assertNull(coord.state.value.liveSessionMissingReason)
        assertFalse(coord.state.value.canCompose)
    }

    @Test
    fun send_failed_mint_rolls_back_visible_bubble_and_offers_text_back() {
        server.dispatcher = routing(
            session = MockResponse().setResponseCode(500).setBody("boom").setBodyDelay(300, TimeUnit.MILLISECONDS),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true))

        coord.send("hello")

        assertTrue("the bubble is visible while the failing mint is pending", coord.state.value.chat.turns.isNotEmpty())
        assertTrue(coord.state.value.chat.busy)
        assertTrue("the rejected text is offered back", await { coord.state.value.sendRejectedText == "hello" })
        assertNull("no session was created", coord.state.value.sessionId)
        assertTrue("the rejected optimistic bubble is removed", coord.state.value.chat.turns.isEmpty())
        assertFalse(coord.state.value.chat.busy)
    }

    @Test
    fun stop_during_session_mint_cancels_local_send_and_discards_late_response() {
        val finished = CountDownLatch(1)
        server.dispatcher = routing(
            session = MockResponse()
                .setBody("""{"sessionId":"s_minted","model":"m","backend":"b","messages":[]}""")
                .setBodyDelay(400, TimeUnit.MILLISECONDS),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true),
        )

        coord.send("hello")
        assertTrue("the mint request started", server.takeRequest(3, TimeUnit.SECONDS) != null)
        assertTrue(coord.state.value.chat.busy)

        coord.cancelTurn()

        assertFalse("Stop retires the local pending turn", coord.state.value.chat.busy)
        assertTrue("Stop removes the message that was never submitted", coord.state.value.chat.turns.isEmpty())
        assertEquals("hello", coord.state.value.sendRejectedText)
        assertTrue("the held mint eventually completes", finished.await(3, TimeUnit.SECONDS))
        assertNull("the late mint cannot resurrect its session", coord.state.value.sessionId)
        assertEquals("no message or cancel endpoint was called", 1, server.requestCount)
    }

    @Test
    fun busy_send_is_rejected_locally_and_offers_draft_back() {
        server.dispatcher = routing()
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_busy",
                chat = AgentChatState(busy = true),
            ),
        )

        coord.send("Follow up after stopping")

        assertEquals("Follow up after stopping", coord.state.value.sendRejectedText)
        assertEquals("busy guard must not touch the gateway", 0, server.requestCount)
    }

    @Test
    fun failed_cancel_surfaces_error_and_preserves_live_turn_and_plan() {
        server.dispatcher = routing(cancel = MockResponse().setResponseCode(500).setBody("boom"))
        val plan = AgentPlanItem("p1", "Inspect the records", "in_progress")
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_busy",
                chat = AgentChatState(busy = true, planItems = listOf(plan)),
            ),
        )

        coord.cancelTurn()

        assertTrue(await { coord.state.value.chat.lastTurnError?.startsWith("Stop failed:") == true })
        assertTrue(coord.state.value.chat.busy)
        assertEquals(listOf(plan), coord.state.value.chat.planItems)
    }

    @Test
    fun cancel_ok_false_is_a_visible_failure() {
        server.dispatcher = routing(cancel = MockResponse().setBody("""{"ok":false}"""))
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_busy",
                chat = AgentChatState(busy = true),
            ),
        )

        coord.cancelTurn()

        assertTrue(await { coord.state.value.chat.lastTurnError?.startsWith("Stop failed:") == true })
        assertTrue(coord.state.value.chat.busy)
    }

    @Test
    fun late_cancel_failure_does_not_stain_new_conversation() {
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                check(release.await(3, TimeUnit.SECONDS))
                return MockResponse().setResponseCode(500).setBody("boom")
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_old",
                chat = AgentChatState(busy = true),
            ),
        )

        coord.cancelTurn()
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        coord.newConversation()
        release.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertNull(coord.state.value.chat.lastTurnError)
        assertNull(coord.state.value.sessionId)
    }

    @Test
    fun older_cancel_failure_is_ignored_after_terminal_and_same_session_follow_up() {
        val releaseCancel = CountDownLatch(1)
        val finished = CountDownLatch(2)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.path?.endsWith("/cancel") == true) {
                    check(releaseCancel.await(3, TimeUnit.SECONDS))
                    MockResponse().setResponseCode(500).setBody("boom")
                } else {
                    MockResponse().setBody("""{"messageId":"a2","userMessageId":"u2"}""")
                }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_live",
                chat = AgentChatState(busy = true, turns = listOf(AgentTurn.Assistant("a1"))),
            ),
        )

        coord.cancelTurn()
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        coord.applyEventForTesting(AgentEvent.MessageEnd("s_live", "a1", "canceled"))
        coord.send("Continue in this conversation")
        releaseCancel.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertTrue(coord.state.value.chat.busy)
        assertNull(coord.state.value.chat.lastTurnError)
        assertTrue(coord.state.value.chat.turns.any { it is AgentTurn.User && it.text == "Continue in this conversation" })
    }

    @Test
    fun repeated_stop_ignores_the_older_failure() {
        val firstRelease = CountDownLatch(1)
        val firstEntered = CountDownLatch(1)
        val finished = CountDownLatch(2)
        val calls = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val call = calls.incrementAndGet()
                return if (call == 1) {
                    firstEntered.countDown()
                    check(firstRelease.await(3, TimeUnit.SECONDS))
                    MockResponse().setResponseCode(500).setBody("old failure")
                } else {
                    MockResponse().setBody("""{"ok":true}""")
                }
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_live", chat = AgentChatState(busy = true)),
        )

        coord.cancelTurn()
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        assertTrue(firstEntered.await(3, TimeUnit.SECONDS))
        coord.cancelTurn()
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        firstRelease.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertNull(coord.state.value.chat.lastTurnError)
    }

    @Test
    fun remote_message_start_claims_busy_turn_and_ignores_older_cancel_failure() {
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                check(request.path?.endsWith("/cancel") == true)
                check(release.await(3, TimeUnit.SECONDS))
                return MockResponse().setResponseCode(500).setBody("old failure")
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_live",
                chat = AgentChatState(busy = true),
            ),
        )

        coord.cancelTurn()
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        coord.applyEventForTesting(AgentEvent.MessageStart("s_live", "a_remote"))
        release.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertTrue(coord.state.value.chat.busy)
        assertNull(coord.state.value.chat.lastTurnError)
        assertEquals(
            "a_remote",
            coord.state.value.chat.turns.filterIsInstance<AgentTurn.Assistant>().last().id,
        )
    }

    @Test
    fun delayed_send_failure_cannot_mutate_a_new_conversation() {
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                check(release.await(3, TimeUnit.SECONDS))
                return MockResponse().setResponseCode(500).setBody("boom")
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_old"),
        )

        coord.send("Message on the old surface")
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        coord.newConversation()
        release.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertNull(coord.state.value.sessionId)
        assertTrue(coord.state.value.chat.turns.isEmpty())
        assertNull(coord.state.value.chat.lastTurnError)
        assertNull(coord.state.value.sendRejectedText)
    }

    @Test
    fun delayed_send_success_cannot_stamp_a_replacement_conversation() {
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                check(release.await(3, TimeUnit.SECONDS))
                return MockResponse().setBody("""{"messageId":"a-old","userMessageId":"u-old"}""")
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_old"),
        )

        coord.send("Message on the old surface")
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        coord.newConversation()
        release.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertNull(coord.state.value.sessionId)
        assertTrue(coord.state.value.chat.turns.isEmpty())
    }

    @Test
    fun success_after_terminal_still_dedupes_the_exact_optimistic_user() {
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                check(release.await(3, TimeUnit.SECONDS))
                return MockResponse().setBody("""{"messageId":"a1","userMessageId":"u1"}""")
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_live"),
        )

        coord.send("One message")
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        coord.applyEventForTesting(AgentEvent.UserMessage("s_live", "u1", "One message"))
        coord.applyEventForTesting(AgentEvent.MessageEnd("s_live", "a1", "end_turn"))
        release.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        // `callEnd` fires while the response body is still being parsed, so the latch only
        // proves the POST completed — the coordinator's dedupe applies a moment later. Poll
        // for the state it settles into rather than reading it on the latch.
        assertTrue(await { coord.state.value.chat.turns.filterIsInstance<AgentTurn.User>().size == 1 })
        val users = coord.state.value.chat.turns.filterIsInstance<AgentTurn.User>()
        assertEquals(listOf("u1"), users.map { it.id })
    }

    @Test
    fun delayed_send_failure_cannot_settle_a_newer_same_session_turn() {
        val releaseFirst = CountDownLatch(1)
        val firstEntered = CountDownLatch(1)
        val finished = CountDownLatch(2)
        val calls = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (calls.incrementAndGet() == 1) {
                    firstEntered.countDown()
                    check(releaseFirst.await(3, TimeUnit.SECONDS))
                    MockResponse().setResponseCode(500).setBody("old failure")
                } else {
                    MockResponse().setBody("""{"messageId":"a-new","userMessageId":"u-new"}""")
                }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_live"),
        )

        coord.send("First message")
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        assertTrue(firstEntered.await(3, TimeUnit.SECONDS))
        coord.applyEventForTesting(AgentEvent.MessageEnd("s_live", "a-old", "canceled"))
        coord.send("Newer message")
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        releaseFirst.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertTrue(coord.state.value.chat.busy)
        assertNull(coord.state.value.chat.lastTurnError)
        assertNull(coord.state.value.sendRejectedText)
        assertTrue(coord.state.value.chat.turns.any { it is AgentTurn.User && it.text == "Newer message" })
    }

    @Test
    fun same_session_snapshot_invalidates_pre_snapshot_send_failure() {
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                check(request.path?.contains("/messages") == true)
                check(release.await(3, TimeUnit.SECONDS))
                return MockResponse().setResponseCode(500).setBody("old failure")
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_live"),
        )

        coord.send("Question before the refresh")
        assertTrue(server.takeRequest(3, TimeUnit.SECONDS) != null)
        coord.applySnapshotForTesting(
            session = CreateSessionResponse(
                sessionId = "s_live",
                model = "fictional-model",
                backend = "openai-compatible",
                busy = true,
                messages = listOf(
                    ChatMessage.User(listOf(UserPart.Text("Question before the refresh"))),
                    ChatMessage.Assistant(listOf(AssistantPart.Text("Answer in progress"))),
                ),
            ),
            buffered = emptyList(),
        )
        release.countDown()

        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertTrue(coord.state.value.chat.busy)
        assertNull(coord.state.value.chat.lastTurnError)
        assertNull(coord.state.value.sendRejectedText)
        assertEquals(
            listOf("Question before the refresh"),
            coord.state.value.chat.turns.filterIsInstance<AgentTurn.User>().map { it.text },
        )
    }

    @Test
    fun successful_cancel_terminal_event_allows_follow_up_in_same_conversation() {
        server.dispatcher = routing(cancel = MockResponse().setBody("""{"ok":true}"""))
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_live",
                chat = AgentChatState(
                    busy = true,
                    turns = listOf(AgentTurn.Assistant("a1")),
                ),
            ),
        )

        coord.cancelTurn()
        assertTrue(await { server.requestCount == 1 })
        coord.applyEventForTesting(AgentEvent.MessageEnd("s_live", "a1", "canceled"))
        assertFalse(coord.state.value.chat.busy)

        coord.send("Continue with a shorter answer")

        assertTrue(await { server.requestCount >= 2 })
        assertTrue(
            coord.state.value.chat.turns.any {
                it is AgentTurn.User && it.text == "Continue with a shorter answer"
            },
        )
    }

    @Test
    fun canCompose_gates_on_client_loading_and_fatal() {
        assertFalse("no client → cannot compose", AgentCoordinator.UiState().canCompose)
        assertTrue("client + live session → can compose", AgentCoordinator.UiState(hasClient = true, sessionId = "s1").canCompose)
        assertTrue("a fresh, not-yet-minted conversation is typable", AgentCoordinator.UiState(hasClient = true).canCompose)
        assertFalse("loading disables the composer", AgentCoordinator.UiState(hasClient = true, transcriptLoading = true).canCompose)
        assertFalse(
            "a fatal error disables the composer",
            AgentCoordinator.UiState(hasClient = true, fatalError = RuntimeException("x")).canCompose,
        )
        assertFalse(
            "a terminal conversation is read-only",
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s-exhausted",
                terminalFailure = AgentConversationTerminalFailure(
                    code = "context_window_exceeded",
                    message = "Context window reached.",
                    backend = "openai-compatible",
                    model = "fictional-model",
                    failedAt = "2026-07-29T12:00:00.000Z",
                ),
            ).canCompose,
        )
    }

    @Test
    fun message_end_is_authoritative_for_context_freeze() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s-exhausted",
                model = "fictional-model",
                backend = "openai-compatible",
                chat = AgentChatState(
                    turns = listOf(
                        AgentTurn.Assistant(
                            id = "m1",
                            parts = listOf(AgentPart.Text("Partial answer")),
                        ),
                    ),
                    busy = true,
                ),
            ),
        )
        val message =
            "This conversation no longer fits in the selected model's context window. " +
                "Start a new conversation to continue."

        coord.applyEventForTesting(
            AgentEvent.ErrorEvent(
                sessionId = "s-exhausted",
                messageId = "m1",
                code = "context_window_exceeded",
                message = message,
            ),
        )
        assertNull("agent.error must not freeze the conversation", coord.state.value.terminalFailure)
        assertTrue(coord.state.value.chat.busy)
        assertNull((coord.state.value.chat.turns.last() as AgentTurn.Assistant).failure)

        coord.applyEventForTesting(
            AgentEvent.MessageEnd(
                sessionId = "s-exhausted",
                messageId = "m1",
                stopReason = "error",
                failure = AgentTerminalFailure(
                    code = "context_window_exceeded",
                    message = message,
                    backend = "openai-compatible",
                    model = "fictional-model",
                ),
                context = AgentContextAssessment(
                    inputTokens = 130_000,
                    contextWindowTokens = 128_000,
                    measurement = "provider_reported",
                    limitSource = "provider",
                ),
            ),
        )

        assertEquals("context_window_exceeded", coord.state.value.terminalFailure?.code)
        assertEquals(130_000, coord.state.value.terminalFailure?.context?.inputTokens)
        assertFalse(coord.state.value.chat.busy)
        assertNull((coord.state.value.chat.turns.last() as AgentTurn.Assistant).failure)
    }

    @Test
    fun message_end_is_authoritative_for_output_truncation_marker() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s-truncated",
                model = "fictional-model",
                backend = "openai-compatible",
                chat = AgentChatState(
                    turns = listOf(
                        AgentTurn.Assistant(
                            id = "m1",
                            parts = listOf(AgentPart.Text("Partial answer")),
                        ),
                    ),
                    busy = true,
                ),
            ),
        )
        val message = "The model reached its output limit before completing this response."

        coord.applyEventForTesting(
            AgentEvent.ErrorEvent(
                sessionId = "s-truncated",
                messageId = "m1",
                code = "output_truncated",
                message = message,
            ),
        )
        assertTrue("agent.error must not settle the turn", coord.state.value.chat.busy)
        assertNull((coord.state.value.chat.turns.last() as AgentTurn.Assistant).failure)

        coord.applyEventForTesting(
            AgentEvent.MessageEnd(
                sessionId = "s-truncated",
                messageId = "m1",
                stopReason = "max_tokens",
                failure = AgentTerminalFailure(
                    code = "output_truncated",
                    message = message,
                    backend = "openai-compatible",
                    model = "fictional-model",
                ),
            ),
        )

        val turn = coord.state.value.chat.turns.last() as AgentTurn.Assistant
        assertEquals("max_tokens", turn.stopReason)
        assertEquals(message, turn.failure?.message)
        assertFalse(coord.state.value.chat.busy)
        assertNull(coord.state.value.terminalFailure)
        assertTrue(coord.state.value.canCompose)
    }

    @Test
    fun resume_restores_durable_output_truncation_marker_without_freezing() {
        val message = "The model reached its output limit before completing this response."
        server.dispatcher = routing(
            session = MockResponse().setBody(
                """{"sessionId":"s-truncated","model":"fictional-model","backend":"openai-compatible","messages":[{"role":"user","parts":[{"kind":"text","text":"Explain the constraints."}]},{"role":"assistant","parts":[{"kind":"text","text":"The first constraint is"}]}],"lastTurnFailure":{"code":"output_truncated","message":"$message","retryable":false,"backend":"openai-compatible","model":"fictional-model"}}""",
            ),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true),
        )

        coord.resumeConversation("s-truncated")

        assertTrue(await { coord.state.value.sessionId == "s-truncated" && !coord.state.value.transcriptLoading })
        val state = coord.state.value
        val turn = state.chat.turns.last() as AgentTurn.Assistant
        assertEquals("max_tokens", turn.stopReason)
        assertEquals(message, turn.failure?.message)
        assertNull(state.terminalFailure)
        assertTrue(state.canCompose)
    }

    @Test
    fun frozen_send_conflict_reloads_gateway_terminal_state() {
        val terminalJson =
            """"terminalFailure":{"code":"context_window_exceeded","message":"This conversation no longer fits in the selected model's context window. Start a new conversation to continue.","retryable":false,"backend":"openai-compatible","model":"fictional-model","failedAt":"2026-07-29T12:00:00.000Z"}"""
        server.dispatcher = routing(
            message = MockResponse()
                .setResponseCode(409)
                .setBody(
                    """{"code":"CONTEXT_WINDOW_EXCEEDED","error":"Context window reached."}""",
                ),
            session = MockResponse().setBody(
                """{"sessionId":"s-exhausted","model":"fictional-model","backend":"openai-compatible","messages":[],$terminalJson}""",
            ),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s-exhausted",
                model = "fictional-model",
                backend = "openai-compatible",
            ),
        )

        coord.send("stale client retry")

        assertTrue(
            "the rejected stale send should reload the authoritative terminal state",
            await { coord.state.value.terminalFailure?.code == "context_window_exceeded" },
        )
        assertTrue(coord.state.value.chat.turns.isEmpty())
        assertNull("read-only recovery does not restore text into a hidden composer", coord.state.value.sendRejectedText)
        assertFalse(coord.state.value.canCompose)
    }

    @Test
    fun foreground_refreshes_conversation_list() {
        // A conversation created or advanced on another device is on the server but not yet in
        // local state; the SSE feed is scoped to the active session, so nothing pushed it to us.
        // onForeground must re-fetch the list so it appears without a relaunch — the Android twin
        // of the iOS `testForegroundRefreshesConversationList`.
        server.dispatcher = routing(
            // The active session's reconcile lands empty; the list carries the remote conversation.
            session = MockResponse().setBody("""{"sessionId":"s_local","model":"m","backend":"b","messages":[]}"""),
            conversations = MockResponse().setBody(
                """{"conversations":[{"id":"s_remote","title":"Created elsewhere","messageCount":1}],"nextCursor":null}""",
            ),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(client(), eventSource(), AgentCoordinator.UiState(hasClient = true, sessionId = "s_local"))
        assertTrue("the list starts empty before any refresh", coord.state.value.conversations.isEmpty())

        coord.onForeground()

        assertTrue(
            "onForeground re-fetches the list so a cross-device conversation appears",
            await { coord.state.value.conversations.any { it.sessionId == "s_remote" } },
        )
    }

    @Test
    fun conversation_refresh_supersedes_an_in_flight_snapshot_page() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (!request.path.orEmpty().startsWith("/agent/conversations")) {
                    return MockResponse().setResponseCode(404)
                }
                return if (request.requestUrl?.queryParameter("cursor") != null) {
                    MockResponse()
                        .setBody(
                            """{"conversations":[{"id":"s_stale_page","title":"Stale page"}],"nextCursor":"stale-next"}""",
                        )
                        .setBodyDelay(400, TimeUnit.MILLISECONDS)
                } else {
                    MockResponse().setBody(
                        """{"conversations":[{"id":"s_fresh","title":"Fresh first page"}],"nextCursor":"fresh-next"}""",
                    )
                }
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                conversations = listOf(ConversationSummary(sessionId = "s_old_first", title = "Old first page")),
                conversationsPaging = dev.omnesis.android.ui.common.CursorPagingState(
                    nextCursor = "old-next",
                ),
            ),
        )

        coord.loadMoreConversationsPublic()
        assertTrue("the old snapshot page should be in flight", await { server.requestCount == 1 })

        coord.refreshConversationsPublic()
        assertTrue(
            "the refreshed first page should land",
            await {
                val state = coord.state.value
                state.conversations.map { it.sessionId } == listOf("s_fresh") &&
                    state.conversationsPaging.nextCursor == "fresh-next" &&
                    !state.conversationsLoading
            },
        )

        Thread.sleep(500)
        val state = coord.state.value
        assertEquals(
            "the stale page must not append into the refreshed snapshot",
            listOf("s_fresh"),
            state.conversations.map { it.sessionId },
        )
        assertEquals(
            "the stale page must not replace the refreshed cursor",
            "fresh-next",
            state.conversationsPaging.nextCursor,
        )
        assertFalse(state.conversationsPaging.isLoadingMore)
    }

    @Test
    fun teardown_invalidates_a_delayed_conversation_list_response() {
        server.dispatcher = routing(
            conversations = MockResponse()
                .setBody(
                    """{"conversations":[{"id":"s_old_gateway","title":"Old gateway conversation"}],"nextCursor":"old-gateway-next"}""",
                )
                .setBodyDelay(400, TimeUnit.MILLISECONDS),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_live"),
        )

        coord.refreshConversationsPublic()
        assertTrue(
            "the previous pairing's conversation request should be in flight",
            await { server.requestCount == 1 },
        )

        coord.teardown()
        Thread.sleep(500)

        val state = coord.state.value
        assertTrue(state.conversations.isEmpty())
        assertNull(state.conversationsPaging.nextCursor)
        assertFalse(state.conversationsLoading)
        assertFalse(state.conversationsPaging.isLoadingMore)
        assertNull(state.conversationsError)
        assertFalse(state.hasClient)
    }

    @Test
    fun conversation_refresh_and_append_failures_use_independent_error_channels() {
        server.dispatcher = routing(
            conversations = MockResponse().setResponseCode(500).setBody("fictional failure"),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(),
            eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                conversations = listOf(
                    ConversationSummary(sessionId = "conversation-one", title = "Invented chat"),
                ),
                conversationsPaging = dev.omnesis.android.ui.common.CursorPagingState(
                    nextCursor = "page-two",
                ),
            ),
        )

        coord.loadMoreConversationsPublic()

        assertTrue(
            "the append failure should settle in the footer channel",
            await { coord.state.value.conversationsPaging.paginationError != null },
        )
        var state = coord.state.value
        assertNull(state.conversationsPaging.refreshError)
        assertNull(state.conversationsError)
        assertEquals(
            listOf("conversation-one"),
            state.conversations.map { it.sessionId },
        )

        coord.refreshConversationsPublic()

        assertTrue(
            "the first-page failure should settle in the section channel",
            await {
                val latest = coord.state.value
                !latest.conversationsLoading && latest.conversationsPaging.refreshError != null
            },
        )
        state = coord.state.value
        assertNull(state.conversationsPaging.paginationError)
        assertTrue(state.conversationsError.orEmpty().startsWith("Could not load conversations:"))
    }

    @Test
    fun a_newer_open_supersedes_an_in_flight_resume() {
        // Resume A's transcript is held in flight; resume B lands immediately. B must own the
        // surface and A's late response must be discarded (the sessionChoice guard).
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                if (path.startsWith("/agent/events")) return MockResponse().setResponseCode(200).setBody("")
                if (!path.startsWith("/agent/sessions")) return MockResponse().setResponseCode(404)
                return if (request.body.readUtf8().contains("s_A")) {
                    MockResponse()
                        .setBody("""{"sessionId":"s_A","model":"m","backend":"b","title":"A","messages":[]}""")
                        .setBodyDelay(400, TimeUnit.MILLISECONDS)
                } else {
                    MockResponse().setBody("""{"sessionId":"s_B","model":"m","backend":"b","title":"B","messages":[]}""")
                }
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                sessionId = "s_other",
                conversations = listOf(
                    ConversationSummary(sessionId = "s_A", title = "A"),
                    ConversationSummary(sessionId = "s_B", title = "B"),
                ),
            ),
        )

        coord.resumeConversation("s_A") // starts, held 400ms
        coord.resumeConversation("s_B") // supersedes, lands fast

        assertTrue("B owns the surface", await { coord.state.value.sessionId == "s_B" && !coord.state.value.transcriptLoading })
        // Let A's delayed response land — it must NOT clobber B.
        Thread.sleep(500)
        assertEquals("A's stale resume must be discarded", "s_B", coord.state.value.sessionId)
        assertFalse(coord.state.value.transcriptLoading)
    }

    @Test
    fun stale_foreground_fresh_state_supersedes_an_in_flight_resume() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                if (path.startsWith("/agent/events")) return MockResponse().setResponseCode(200).setBody("")
                if (!path.startsWith("/agent/sessions")) return MockResponse().setResponseCode(404)
                return MockResponse()
                    .setBody("""{"sessionId":"s_recent","model":"m","backend":"b","messages":[]}""")
                    .setBodyDelay(400, TimeUnit.MILLISECONDS)
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(hasClient = true, sessionId = "s_previous"),
        )

        val composerGeneration = coord.state.value.composerGeneration
        coord.resumeConversation("s_recent")
        coord.newConversation()

        assertNull("the hour-old foreground policy owns the surface", coord.state.value.sessionId)
        assertEquals(composerGeneration + 1, coord.state.value.composerGeneration)
        Thread.sleep(500)
        assertNull("the delayed resume cannot overwrite the fresh composer", coord.state.value.sessionId)
        assertFalse(coord.state.value.transcriptLoading)
        assertTrue(coord.state.value.canCompose)
    }

    @Test
    fun a_superseded_lazy_mint_does_not_leak_text_into_the_new_conversation() {
        val finished = CountDownLatch(1)
        server.dispatcher = routing(
            session = MockResponse()
                .setBody("""{"sessionId":"s_minted","model":"m","backend":"b","messages":[]}""")
                .setBodyDelay(400, TimeUnit.MILLISECONDS),
        )
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true),
        )

        coord.send("hello")     // starts the lazy mint, held 400ms
        coord.newConversation() // supersedes the mint before it returns

        assertTrue("the abandoned mint completes", finished.await(3, TimeUnit.SECONDS))
        assertNull("the superseding new conversation owns the surface", coord.state.value.sessionId)
        assertTrue("the superseding reset removes the abandoned optimistic bubble", coord.state.value.chat.turns.isEmpty())
        assertFalse(coord.state.value.chat.busy)
        assertNull("the abandoned prompt does not leak into the new composer", coord.state.value.sendRejectedText)
    }

    @Test
    fun resume_during_lazy_mint_does_not_leak_text_into_the_selected_conversation() {
        val sessionRequests = AtomicInteger(0)
        val finished = CountDownLatch(2)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                if (!path.startsWith("/agent/sessions")) return MockResponse().setResponseCode(404)
                return if (sessionRequests.getAndIncrement() == 0) {
                    MockResponse()
                        .setBody("""{"sessionId":"s_minted","model":"m","backend":"b","messages":[]}""")
                        .setBodyDelay(400, TimeUnit.MILLISECONDS)
                } else {
                    MockResponse().setBody(
                        """{"sessionId":"s_target","model":"m","backend":"b","title":"Selected","messages":[]}""",
                    )
                }
            }
        }
        val coord = AgentCoordinator()
        coord.attachForTesting(
            clientWithFinishedCalls(finished),
            eventSource(),
            AgentCoordinator.UiState(hasClient = true),
        )

        coord.send("hello")
        assertTrue("the first mint starts", await { server.requestCount == 1 })
        coord.resumeConversation("s_target")

        assertTrue("the selected conversation lands", await { coord.state.value.sessionId == "s_target" })
        assertTrue("both session requests complete", finished.await(3, TimeUnit.SECONDS))
        assertEquals("s_target", coord.state.value.sessionId)
        assertEquals("Selected", coord.state.value.title)
        assertTrue(coord.state.value.chat.turns.isEmpty())
        assertNull("the abandoned prompt does not leak into the selected composer", coord.state.value.sendRejectedText)
    }
}

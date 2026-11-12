// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.AgentSessionProfile
import dev.omnesis.android.transport.client.AgentStreamItem
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.SendMessageResponse
import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskToolOutcome
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The plans a watch relay runs the voice ask under: the long wait, the durable capture and the hand-off. */
@OptIn(ExperimentalCoroutinesApi::class)
class VoiceAskRelayPlanTest {
    private val answer = listOf(
        AgentStreamItem("1", AgentEvent.TextDelta("session-a", "message-a", "Tuesday at ten")),
        AgentStreamItem("2", AgentEvent.MessageEnd("session-a", "message-a")),
    )

    @Test
    fun a_relayed_ask_reports_its_milestones_and_returns_what_a_follow_up_needs() = runTest {
        val gateway = ScriptedGateway(
            stream = listOf(
                AgentStreamItem("1", AgentEvent.MessageStart("session-a", "message-a")),
                AgentStreamItem("2", AgentEvent.ToolInputStart("session-a", "message-a", "call-1", "search_documents")),
                AgentStreamItem("3", AgentEvent.ToolStart("session-a", "message-a", "call-1", "search_documents")),
                // Another conversation's tool on the caller-wide feed is not this ask's progress.
                AgentStreamItem("4", AgentEvent.ToolStart("session-b", "message-z", "call-9", "run_sql")),
                AgentStreamItem(
                    "5",
                    AgentEvent.ToolResult(
                        "session-a",
                        "message-a",
                        "call-1",
                        AgentToolResult.SearchResults(results = listOf(AgentDocRef("doc-1"), AgentDocRef("doc-1"))),
                    ),
                ),
            ) + answer,
        )
        val events = mutableListOf<AskActivityEvent>()

        val run = VoiceAskRunner({ gateway }, Continuity()) { 0L }.runRelayed("When is the review?") { events += it }

        assertEquals(VoiceAskOutcome.Answered("Tuesday at ten"), run.outcome)
        assertEquals("session-a", run.conversationId)
        assertEquals("message-a", run.messageId)
        assertEquals(
            listOf(
                AskActivityEvent.Connecting,
                AskActivityEvent.RequestSent,
                AskActivityEvent.AgentStarted,
                AskActivityEvent.ToolStarted("call-1", "search_documents"),
                AskActivityEvent.ToolStarted("call-1", "search_documents"),
                AskActivityEvent.ToolFinished("call-1", AskToolOutcome.Search(2)),
            ),
            events,
        )
        assertEquals(VoiceAskRunner.WATCH_RELAY_BUDGET_MILLIS.toInt(), gateway.notifyAfterMs)
        assertTrue("a watched ask leases the read state", gateway.viewingForMs != null)
    }

    @Test
    fun a_relayed_ask_waits_out_the_watch_budget_before_deferring_to_the_push() = runTest {
        val gateway = ScriptedGateway(hold = true)
        val runner = VoiceAskRunner({ gateway }, Continuity()) { testScheduler.currentTime * 1_000_000L }

        val run = runner.runRelayed("Question")

        assertEquals(VoiceAskOutcome.StillWorking, run.outcome)
        assertEquals(VoiceAskRunner.WATCH_RELAY_BUDGET_MILLIS, testScheduler.currentTime)
        assertFalse(run.notifyLocally)
    }

    @Test
    fun a_named_conversation_is_resumed_instead_of_the_continuity_thread() = runTest {
        val gateway = ScriptedGateway(stream = answer)
        val run = VoiceAskRunner({ gateway }, Continuity(resume = "session-old")) { 0L }
            .runRelayed("And after that?", resuming = "session-a")

        assertEquals(VoiceAskOutcome.Answered("Tuesday at ten"), run.outcome)
        assertEquals(listOf<String?>("session-a"), gateway.resumed)
    }

    @Test
    fun a_named_conversation_that_cannot_be_reopened_is_refused_not_replaced() = runTest {
        val gateway = ScriptedGateway(resumeFailure = GatewayException.NotFound())
        val run = VoiceAskRunner({ gateway }, Continuity()) { 0L }.runRelayed("And after that?", resuming = "session-gone")

        assertEquals(VoiceAskOutcome.Failed(VoiceAskRunner.RESUME_REFUSED), run.outcome)
        assertEquals(0, gateway.sendCount)
        assertEquals(listOf<String?>("session-gone"), gateway.resumed)
    }

    @Test
    fun a_follow_up_to_a_busy_conversation_is_not_sent() = runTest {
        val gateway = ScriptedGateway(sessions = mutableListOf(CreateSessionResponse(sessionId = "session-a", busy = true)))
        val run = VoiceAskRunner({ gateway }, Continuity()) { 0L }.runCapture("And after that?", resuming = "session-a")

        assertEquals(VoiceAskOutcome.Failed(VoiceAskRunner.BUSY_FOLLOW_UP), run.outcome)
        assertEquals("session-a", run.conversationId)
        assertTrue(run.notifyLocally)
        assertEquals(0, gateway.sendCount)
    }

    @Test
    fun a_capture_goes_to_a_fresh_conversation_when_the_continuity_thread_is_busy() = runTest {
        val gateway = ScriptedGateway(
            sessions = mutableListOf(
                CreateSessionResponse(sessionId = "session-old", busy = true),
                CreateSessionResponse(sessionId = "session-a"),
            ),
            stream = answer,
        )
        val run = VoiceAskRunner({ gateway }, Continuity(resume = "session-old")) { 0L }.runCapture("Question")

        assertEquals(VoiceAskOutcome.Answered("Tuesday at ten"), run.outcome)
        assertEquals("session-a", run.conversationId)
        assertEquals(listOf("session-old", null), gateway.resumed)
    }

    @Test
    fun a_capture_asks_the_gateway_to_announce_every_answer_and_takes_no_read_lease() = runTest {
        val gateway = ScriptedGateway(stream = answer)
        val run = VoiceAskRunner({ gateway }, Continuity()) { 0L }.runCapture("Question")

        assertEquals(0, gateway.notifyAfterMs)
        assertNull(gateway.viewingForMs)
        assertEquals("message-a", run.messageId)
        assertFalse("the gateway announces a settled capture", run.notifyLocally)
    }

    @Test
    fun a_hand_off_follows_the_turn_for_the_silent_window_only() = runTest {
        val gateway = ScriptedGateway(hold = true)
        val runner = VoiceAskRunner({ gateway }, Continuity()) { testScheduler.currentTime * 1_000_000L }

        val run = runner.handOff("Question")

        assertEquals(VoiceAskOutcome.StillWorking, run.outcome)
        assertEquals(VoiceAskRunner.MINIMUM_REMAINING_MILLIS, testScheduler.currentTime)
        assertEquals(VoiceAskRunner.MINIMUM_REMAINING_MILLIS.toInt(), gateway.notifyAfterMs)
        assertNull(gateway.viewingForMs)
        assertFalse("a turn still running is the push's to announce", run.notifyLocally)
    }

    @Test
    fun a_hand_off_that_settles_inside_the_silent_window_is_the_phone_to_announce() = runTest {
        val gateway = ScriptedGateway(stream = answer)
        val run = VoiceAskRunner({ gateway }, Continuity()) { 0L }.handOff("Question")

        assertEquals(VoiceAskOutcome.Answered("Tuesday at ten"), run.outcome)
        assertTrue(run.notifyLocally)
    }

    @Test
    fun an_ask_that_never_reaches_a_conversation_has_nothing_to_follow_up() = runTest {
        val run = VoiceAskRunner({ null }, Continuity()) { 0L }.runRelayed("Question")
        assertEquals(VoiceAskRun(VoiceAskOutcome.NotPaired, null, null, notifyLocally = true), run)
    }

    @Test
    fun a_batch_result_counts_what_its_children_found_and_opened() {
        val batch = AgentToolResult.DocumentBatch(
            listOf(
                AgentToolResult.DocumentResult(AgentDocRef("doc-1")),
                AgentToolResult.SearchBatch(listOf(AgentToolResult.SearchResults(results = listOf(AgentDocRef("doc-1"))))),
                AgentToolResult.ErrorResult(),
            ),
        )
        assertEquals(AskToolOutcome.Batch(found = 1, opened = 1), VoiceAskRunner.toolOutcome(batch))
        assertEquals(
            AskActivityEvent.ToolFinished("call-1#2", AskToolOutcome.DocumentOpened),
            VoiceAskRunner.activityEvent(
                AgentEvent.ToolChildResult(
                    "session-a",
                    "message-a",
                    "call-1",
                    2,
                    AgentToolResult.DocumentResult(AgentDocRef("doc-1")),
                ),
                "session-a",
                "message-a",
            ),
        )
        assertNull(
            VoiceAskRunner.activityEvent(AgentEvent.MessageStart("session-a", "message-b"), "session-a", "message-a"),
        )
    }

    private class Continuity(private val resume: String? = null) : VoiceAskContinuity {
        override fun conversationToResume(): String? = resume
        override fun record(conversationId: String) = Unit
    }

    private class ScriptedGateway(
        private val sessions: MutableList<CreateSessionResponse> = mutableListOf(),
        private val stream: List<AgentStreamItem> = emptyList(),
        private val hold: Boolean = false,
        private val resumeFailure: GatewayException? = null,
    ) : VoiceAskGateway {
        val resumed = mutableListOf<String?>()
        var notifyAfterMs: Int? = null
        var viewingForMs: Int? = null
        var sendCount = 0

        override suspend fun createSession(
            resumeFromId: String?,
            transcriptLimit: Int?,
            profile: AgentSessionProfile,
        ): CreateSessionResponse {
            resumed += resumeFromId
            if (resumeFromId != null) resumeFailure?.let { throw it }
            return sessions.removeFirstOrNull() ?: CreateSessionResponse(sessionId = "session-a")
        }

        override suspend fun sendMessage(
            sessionId: String,
            text: String,
            notifyAfterMs: Int,
            viewingForMs: Int?,
        ): SendMessageResponse {
            sendCount++
            this.notifyAfterMs = notifyAfterMs
            this.viewingForMs = viewingForMs
            return SendMessageResponse(messageId = "message-a")
        }

        override fun events(lastEventId: String?, onOpen: () -> Unit): Flow<AgentStreamItem> = flow {
            onOpen()
            if (hold) awaitCancellation()
            stream.forEach { emit(it) }
            awaitCancellation()
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.AgentSessionProfile
import dev.omnesis.android.transport.client.AgentStreamItem
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.SendMessageResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceAskRunnerTest {
    @Test
    fun fresh_voice_ask_attaches_before_send_and_speaks_the_message_scoped_stream() = runTest {
        val gateway = FakeGateway(
            streams = mutableListOf(
                listOf(
                    AgentStreamItem("1", AgentEvent.TextDelta("session-a", "message-a", "partial")),
                    AgentStreamItem("2", AgentEvent.MessageEnd("session-a", "message-a")),
                ),
            ),
        )
        val continuity = FakeContinuity()
        val runner = VoiceAskRunner({ gateway }, continuity) { 0L }

        assertEquals(VoiceAskOutcome.Answered("partial"), runner.run("Question"))
        assertEquals(listOf("open", "send"), gateway.order.take(2))
        assertEquals(AgentSessionProfile.VOICE, gateway.profile)
        assertEquals("session-a", continuity.recorded)
        assertEquals(VoiceAskRunner.ANSWER_BUDGET_MILLIS.toInt(), gateway.notifyAfterMs)
    }

    @Test
    fun reconnects_from_the_last_event_id_and_keeps_the_partial_fold() = runTest {
        val gateway = FakeGateway(
            streams = mutableListOf(
                listOf(AgentStreamItem("7", AgentEvent.TextDelta("session-a", "message-a", "First "))),
                listOf(
                    AgentStreamItem("8", AgentEvent.TextDelta("session-a", "message-a", "second")),
                    AgentStreamItem("9", AgentEvent.MessageEnd("session-a", "message-a")),
                ),
            ),
        )
        val runner = VoiceAskRunner({ gateway }, FakeContinuity()) { 0L }

        assertEquals(VoiceAskOutcome.Answered("First second"), runner.run("Question"))
        assertEquals(listOf(null, "7"), gateway.resumeIds)
    }

    @Test
    fun busy_continuity_thread_is_not_sent_a_second_question() = runTest {
        val continuity = FakeContinuity(resume = "session-old")
        val gateway = FakeGateway(created = CreateSessionResponse(sessionId = "session-old", busy = true))
        val runner = VoiceAskRunner({ gateway }, continuity) { 0L }

        assertEquals(VoiceAskOutcome.PreviousTurnRunning, runner.run("Follow up"))
        assertEquals(0, gateway.sendCount)
        assertEquals("session-old", continuity.recorded)
        assertEquals(0, gateway.transcriptLimit)
    }

    @Test
    fun maps_forbidden_token_and_missing_pairing_without_sending() = runTest {
        val forbidden = FakeGateway(createFailure = GatewayException.Forbidden())
        assertEquals(
            VoiceAskOutcome.Unauthorized,
            VoiceAskRunner({ forbidden }, FakeContinuity()) { 0L }.run("Question"),
        )
        assertEquals(
            VoiceAskOutcome.NotPaired,
            VoiceAskRunner({ null }, FakeContinuity()) { 0L }.run("Question"),
        )
    }

    @Test
    fun a_near_deadline_send_still_arms_the_gateway_minimum_notification_window() = runTest {
        var setupNanos = 0L
        val gateway = FakeGateway(
            onCreate = { setupNanos = 19_500_000_000L },
            sendDelayMillis = 750,
            streams = mutableListOf(
                listOf(AgentStreamItem("1", AgentEvent.MessageEnd("session-a", "message-a"))),
            ),
        )

        VoiceAskRunner({ gateway }, FakeContinuity()) {
            setupNanos + testScheduler.currentTime * 1_000_000L
        }.run("Question")

        assertEquals(VoiceAskRunner.MINIMUM_REMAINING_MILLIS.toInt(), gateway.notifyAfterMs)
        assertEquals(1, gateway.sendCount)
    }

    @Test
    fun a_rejected_initial_stream_reports_the_real_auth_state() = runTest {
        val forbidden = FakeGateway(streamFailure = GatewayException.Forbidden())
        assertEquals(
            VoiceAskOutcome.Unauthorized,
            VoiceAskRunner({ forbidden }, FakeContinuity()) { 0L }.run("Question"),
        )
        val unauthorized = FakeGateway(streamFailure = GatewayException.Unauthorized())
        assertEquals(
            VoiceAskOutcome.Unauthorized,
            VoiceAskRunner({ unauthorized }, FakeContinuity()) { 0L }.run("Question"),
        )
    }

    @Test
    fun clean_message_scoped_stream_returns_without_identity_free_reconciliation() = runTest {
        val gateway = FakeGateway(
            streams = mutableListOf(
                listOf(
                    AgentStreamItem("1", AgentEvent.TextDelta("session-a", "message-a", "Streamed answer")),
                    AgentStreamItem("2", AgentEvent.MessageEnd("session-a", "message-a")),
                ),
            ),
        )

        assertEquals(
            VoiceAskOutcome.Answered("Streamed answer"),
            VoiceAskRunner({ gateway }, FakeContinuity()) { 0L }.run("Question"),
        )
    }

    @Test
    fun silent_stream_uses_the_bounded_answer_window() = runTest {
        val gateway = FakeGateway(holdStream = true)
        val runner = VoiceAskRunner({ gateway }, FakeContinuity()) {
            testScheduler.currentTime * 1_000_000L
        }

        assertEquals(VoiceAskOutcome.StillWorking, runner.run("Question"))
        assertEquals(VoiceAskRunner.ANSWER_BUDGET_MILLIS, testScheduler.currentTime)
    }

    @Test
    fun resync_never_promotes_a_stream_with_a_known_replay_gap() = runTest {
        val gateway = FakeGateway(
            streams = mutableListOf(
                listOf(
                    AgentStreamItem("7", AgentEvent.TextDelta("session-a", "message-a", "Missing ")),
                    AgentStreamItem("8", AgentEvent.Resync()),
                    AgentStreamItem("9", AgentEvent.TextDelta("session-a", "message-a", "tail")),
                    AgentStreamItem("10", AgentEvent.MessageEnd("session-a", "message-a")),
                ),
            ),
        )

        assertEquals(
            VoiceAskOutcome.StillWorking,
            VoiceAskRunner({ gateway }, FakeContinuity()) { testScheduler.currentTime * 1_000_000L }
                .run("Question"),
        )
    }

    @Test
    fun compatibility_resume_fallback_preserves_cancellation() = runTest {
        val gateway = FakeGateway(
            createFailures = mutableListOf(
                GatewayException.ServerError(400, null),
                kotlinx.coroutines.CancellationException("activity stopped"),
            ),
        )
        var cancellationObserved = false

        try {
            VoiceAskRunner({ gateway }, FakeContinuity(resume = "session-old")) { 0L }.run("Question")
        } catch (_: kotlinx.coroutines.CancellationException) {
            cancellationObserved = true
        }

        assertTrue(cancellationObserved)
        assertEquals(2, gateway.createCount)
        assertEquals(0, gateway.sendCount)
    }

    @Test
    fun ambiguous_send_never_speaks_an_identity_free_transcript_answer() = runTest {
        val continuity = FakeContinuity()
        val gateway = FakeGateway(
            sendFailure = GatewayException.Network(java.io.IOException("response lost")),
        )

        assertEquals(
            VoiceAskOutcome.DeliveryUncertain,
            VoiceAskRunner({ gateway }, continuity) { 0L }.run("Question"),
        )
        assertEquals("session-a", continuity.recorded)
    }

    @Test
    fun send_auth_failures_keep_their_typed_outcome() = runTest {
        assertEquals(
            VoiceAskOutcome.Unauthorized,
            VoiceAskRunner(
                { FakeGateway(sendFailure = GatewayException.Unauthorized()) },
                FakeContinuity(),
            ) { 0L }.run("Question"),
        )
        assertEquals(
            VoiceAskOutcome.Unauthorized,
            VoiceAskRunner(
                { FakeGateway(sendFailure = GatewayException.Forbidden()) },
                FakeContinuity(),
            ) { 0L }.run("Question"),
        )
    }

    private class FakeContinuity(var resume: String? = null) : VoiceAskContinuity {
        var recorded: String? = null
        override fun conversationToResume(): String? = resume
        override fun record(conversationId: String) {
            recorded = conversationId
        }
    }

    private class FakeGateway(
        private val created: CreateSessionResponse = CreateSessionResponse(sessionId = "session-a"),
        private val createFailure: GatewayException? = null,
        private val createFailures: MutableList<Throwable> = mutableListOf(),
        private val streams: MutableList<List<AgentStreamItem>> = mutableListOf(),
        private val streamFailure: GatewayException? = null,
        private val holdStream: Boolean = false,
        private val sendDelayMillis: Long = 0,
        private val sendFailure: Exception? = null,
        private val holdAfterEvents: Boolean = false,
        private val onCreate: () -> Unit = {},
    ) : VoiceAskGateway {
        val order = mutableListOf<String>()
        val resumeIds = mutableListOf<String?>()
        var profile: AgentSessionProfile? = null
        var transcriptLimit: Int? = null
        var notifyAfterMs: Int? = null
        var sendCount = 0
        var createCount = 0

        override suspend fun createSession(
            resumeFromId: String?,
            transcriptLimit: Int?,
            profile: AgentSessionProfile,
        ): CreateSessionResponse {
            createCount++
            createFailures.removeFirstOrNull()?.let { throw it }
            createFailure?.let { throw it }
            onCreate()
            this.profile = profile
            this.transcriptLimit = transcriptLimit
            return created
        }

        override suspend fun sendMessage(
            sessionId: String,
            text: String,
            notifyAfterMs: Int,
            viewingForMs: Int,
        ): SendMessageResponse {
            if (sendDelayMillis > 0) delay(sendDelayMillis)
            order += "send"
            sendCount++
            this.notifyAfterMs = notifyAfterMs
            sendFailure?.let { throw it }
            return SendMessageResponse(messageId = "message-a")
        }

        override fun events(lastEventId: String?, onOpen: () -> Unit): Flow<AgentStreamItem> = flow {
            streamFailure?.let { throw it }
            resumeIds += lastEventId
            order += "open"
            onOpen()
            if (holdStream) awaitCancellation()
            streams.removeFirstOrNull()?.forEach { emit(it) }
            if (holdAfterEvents) awaitCancellation()
        }
    }
}

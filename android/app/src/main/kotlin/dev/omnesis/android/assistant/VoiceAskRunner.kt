// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.AgentSessionProfile
import dev.omnesis.android.transport.client.AgentStreamItem
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.SendMessageResponse
import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskToolOutcome
import java.time.Duration
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.ceil
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Runs one bounded voice-profile agent turn: the ask behind an Android App Action, and the
 * questions a watch relays through this phone.
 *
 * The stream attaches before the question is posted and survives ordinary connection drops with
 * Last-Event-ID replay. Only a clean, message-id-scoped terminal event is spoken; replay gaps and
 * ambiguous POST failures fall back to the visible conversation because transcript rows do not
 * carry enough identity to safely distinguish concurrent turns.
 *
 * Every entry point is one [VoiceAskPlan] over the same turn: how long the caller waits, which
 * conversation it continues, who announces an answer the caller does not see, and whether the
 * turn's milestones are reported.
 */
@Singleton
class VoiceAskRunner internal constructor(
    private val sessionProvider: () -> VoiceAskGateway?,
    private val continuity: VoiceAskContinuity,
    private val monotonicNanos: () -> Long,
) {
    @Inject
    constructor(sessions: SessionManager, continuity: VoiceAskContinuityStore) : this(
        sessionProvider = { sessions.session?.let(::ProductionVoiceAskGateway) },
        continuity = continuity,
        monotonicNanos = System::nanoTime,
    )

    /** The ask a person is watching on this phone: the answer, or why there is none, inside the budget. */
    suspend fun run(question: String): VoiceAskOutcome = execute(question, VoiceAskPlan()).outcome

    /**
     * A question a watch is waiting on. The watch shows its own progress, so the wait is longer
     * than the phone's and each milestone is reported through [onActivity]. [resuming] continues
     * the conversation whose answer is on the watch's screen.
     */
    suspend fun runRelayed(
        question: String,
        resuming: String? = null,
        onActivity: ((AskActivityEvent) -> Unit)? = null,
    ): VoiceAskRun = execute(
        question,
        VoiceAskPlan(budgetMillis = WATCH_RELAY_BUDGET_MILLIS, resuming = resuming, onActivity = onActivity),
    )

    /**
     * A recorded question the phone already holds durably, on a gateway that announces every
     * answer itself: the question is posted with no silent window, and a busy conversation
     * does not turn it away.
     */
    suspend fun runCapture(
        question: String,
        resuming: String? = null,
        onActivity: ((AskActivityEvent) -> Unit)? = null,
    ): VoiceAskRun = execute(
        question,
        VoiceAskPlan(
            budgetMillis = WATCH_RELAY_BUDGET_MILLIS,
            resuming = resuming,
            delivery = VoiceAskPlan.Delivery.GATEWAY_ANNOUNCES,
            onActivity = onActivity,
        ),
    )

    /**
     * A question nobody is waiting on. It is posted with the shortest silent window the gateway
     * accepts and followed for exactly that long: a turn that settles inside the window is
     * returned for the caller to announce, and one still running is the gateway's push to
     * deliver ([VoiceAskOutcome.StillWorking]).
     */
    suspend fun handOff(question: String, resuming: String? = null): VoiceAskRun = execute(
        question,
        VoiceAskPlan(
            resuming = resuming,
            delivery = VoiceAskPlan.Delivery.HAND_OFF,
            turnWaitMillis = MINIMUM_REMAINING_MILLIS,
        ),
    )

    private suspend fun execute(question: String, plan: VoiceAskPlan): VoiceAskRun {
        val cleaned = question.trim()
        if (cleaned.isEmpty()) return VoiceAskRun.ended(VoiceAskOutcome.EmptyAnswer)
        if (cleaned.length > MAX_QUESTION_LENGTH) {
            return VoiceAskRun.ended(
                VoiceAskOutcome.Failed("Questions are capped at $MAX_QUESTION_LENGTH characters."),
            )
        }

        val startedAt = monotonicNanos()
        val gateway = sessionProvider() ?: return VoiceAskRun.ended(VoiceAskOutcome.NotPaired)
        plan.onActivity?.invoke(AskActivityEvent.Connecting)
        var created = when (
            val opened = openSession(gateway, plan, startedAt, plan.resuming ?: continuity.conversationToResume())
        ) {
            is OpenedSession.Ended -> return VoiceAskRun.ended(opened.outcome)
            is OpenedSession.Opened -> opened.session
        }

        if (created.busy) {
            if (plan.resuming != null) {
                return VoiceAskRun(VoiceAskOutcome.Failed(BUSY_FOLLOW_UP), created.sessionId, null, notifyLocally = true)
            }
            if (plan.delivery == VoiceAskPlan.Delivery.CALLER_WAITS) {
                continuity.record(created.sessionId)
                return VoiceAskRun(VoiceAskOutcome.PreviousTurnRunning, created.sessionId, null, notifyLocally = false)
            }
            // Nobody is here to be told to ask again, so the question goes to a fresh
            // conversation instead of being dropped behind the running one.
            created = when (val opened = openSession(gateway, plan.copy(resuming = null), startedAt, null)) {
                is OpenedSession.Ended -> return VoiceAskRun.ended(opened.outcome)
                is OpenedSession.Opened -> opened.session
            }
        }

        val sent = PostedMessage()
        val outcome = collectTurn(
            gateway = gateway,
            created = created,
            question = cleaned,
            startedAt = startedAt,
            plan = plan,
            sent = sent,
        )
        return VoiceAskRun(outcome, created.sessionId, sent.messageId, plan.notifiesLocally(outcome))
    }

    private sealed interface OpenedSession {
        data class Opened(val session: CreateSessionResponse) : OpenedSession
        data class Ended(val outcome: VoiceAskOutcome) : OpenedSession
    }

    /** The assistant message a posted question was given, read after the turn however it ended. */
    private class PostedMessage {
        @Volatile var messageId: String? = null
    }

    private class ResumeRefused : Exception()

    private suspend fun openSession(
        gateway: VoiceAskGateway,
        plan: VoiceAskPlan,
        startedAt: Long,
        resumeId: String?,
    ): OpenedSession = try {
        beforeDeadline(startedAt, plan) { voiceSession(gateway, resumeId, strict = plan.resuming != null) }
            ?.let(OpenedSession::Opened)
            ?: OpenedSession.Ended(VoiceAskOutcome.Unreachable)
    } catch (_: ResumeRefused) {
        OpenedSession.Ended(VoiceAskOutcome.Failed(RESUME_REFUSED))
    } catch (_: GatewayException.Forbidden) {
        OpenedSession.Ended(VoiceAskOutcome.Unauthorized)
    } catch (_: GatewayException.Unauthorized) {
        OpenedSession.Ended(VoiceAskOutcome.Unauthorized)
    } catch (_: GatewayException) {
        OpenedSession.Ended(VoiceAskOutcome.Unreachable)
    }

    /**
     * The session to post to. A continuity thread that cannot be resumed falls back to a fresh
     * session; a conversation the caller named ([strict]) is refused instead, because its
     * follow-up would make no sense anywhere else.
     */
    private suspend fun voiceSession(
        gateway: VoiceAskGateway,
        resumeId: String?,
        strict: Boolean,
    ): CreateSessionResponse {
        if (resumeId != null) {
            val resumed = try {
                gateway.createSession(
                    resumeFromId = resumeId,
                    transcriptLimit = 0,
                    profile = AgentSessionProfile.VOICE,
                )
            } catch (error: GatewayException.ServerError) {
                if (error.status == 400) {
                    try {
                        gateway.createSession(
                            resumeFromId = resumeId,
                            profile = AgentSessionProfile.VOICE,
                        )
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: GatewayException) {
                        null
                    }
                } else {
                    null
                }
            } catch (_: GatewayException) {
                null
            }
            if (resumed != null && resumed.terminalFailure == null && resumed.origin == null) {
                return resumed
            }
            if (strict) throw ResumeRefused()
        }
        return gateway.createSession(profile = AgentSessionProfile.VOICE)
    }

    private suspend fun collectTurn(
        gateway: VoiceAskGateway,
        created: CreateSessionResponse,
        question: String,
        startedAt: Long,
        plan: VoiceAskPlan,
        sent: PostedMessage,
    ): VoiceAskOutcome = supervisorScope<VoiceAskOutcome> {
        val remainingBeforePost = operationWindowMillis(startedAt, plan)
        if (remainingBeforePost <= 0) return@supervisorScope VoiceAskOutcome.Unreachable

        val signals = Channel<StreamSignal>(capacity = STREAM_BUFFER_CAPACITY)
        val opened = CompletableDeferred<Unit>()
        var streamJob = attach(
            scope = this,
            gateway = gateway,
            lastEventId = null,
            signals = signals,
            opened = opened,
        )
        try {
            val attachFailure = try {
                withTimeout(remainingBeforePost) { opened.await() }
                null
            } catch (timeout: TimeoutCancellationException) {
                timeout
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                error
            }
            if (attachFailure != null) {
                return@supervisorScope when (attachFailure) {
                    is GatewayException.Unauthorized -> VoiceAskOutcome.Unauthorized
                    is GatewayException.Forbidden -> VoiceAskOutcome.Unauthorized
                    else -> VoiceAskOutcome.Unreachable
                }
            }

            val remaining = operationWindowMillis(startedAt, plan)
            if (remaining <= 0) return@supervisorScope VoiceAskOutcome.Unreachable
            val posted = try {
                withTimeout(remaining) {
                    gateway.sendMessage(
                        sessionId = created.sessionId,
                        text = question,
                        notifyAfterMs = when (plan.delivery) {
                            VoiceAskPlan.Delivery.CALLER_WAITS -> notificationMillis(remainingMillis(startedAt, plan))
                            VoiceAskPlan.Delivery.GATEWAY_ANNOUNCES -> 0
                            VoiceAskPlan.Delivery.HAND_OFF -> MINIMUM_REMAINING_MILLIS.toInt()
                        },
                        // The read-state lease is for a caller presenting the answer as it is
                        // produced. A question nobody watches stays unread for its notification.
                        viewingForMs = if (plan.delivery == VoiceAskPlan.Delivery.CALLER_WAITS) {
                            viewingForMillis(remaining)
                        } else {
                            null
                        },
                    )
                }
            } catch (_: TimeoutCancellationException) {
                return@supervisorScope ambiguousSendOutcome(created)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: GatewayException.Unauthorized) {
                return@supervisorScope VoiceAskOutcome.Unauthorized
            } catch (_: GatewayException.Forbidden) {
                return@supervisorScope VoiceAskOutcome.Unauthorized
            } catch (error: GatewayException) {
                return@supervisorScope if (
                    error is GatewayException.Network ||
                    error is GatewayException.InvalidResponse ||
                    error is GatewayException.Decoding
                ) {
                    ambiguousSendOutcome(created)
                } else {
                    VoiceAskOutcome.SendFailed
                }
            } catch (_: Exception) {
                return@supervisorScope VoiceAskOutcome.SendFailed
            }
            sent.messageId = posted.messageId
            plan.onActivity?.invoke(AskActivityEvent.RequestSent)
            continuity.record(created.sessionId)

            var collector = VoiceAnswerCollector(created.sessionId, posted.messageId)
            var lastEventId: String? = null
            val overallDeadlineNanos = startedAt + (plan.budgetMillis + SETTLE_GRACE_MILLIS) * NANOS_PER_MILLI
            val streamDeadlineNanos = minOf(
                overallDeadlineNanos,
                plan.turnWaitMillis?.let { monotonicNanos() + it * NANOS_PER_MILLI } ?: maxOf(
                    startedAt + plan.budgetMillis * NANOS_PER_MILLI,
                    monotonicNanos() + MINIMUM_REMAINING_MILLIS * NANOS_PER_MILLI,
                ),
            )
            while (true) {
                val waitMillis = Duration.ofNanos(
                    (streamDeadlineNanos - monotonicNanos()).coerceAtLeast(0),
                ).toMillis()
                if (waitMillis <= 0) {
                    return@supervisorScope VoiceAskOutcome.StillWorking
                }
                val signal = withTimeoutOrNull(waitMillis) { signals.receive() }
                    ?: return@supervisorScope VoiceAskOutcome.StillWorking
                when (signal) {
                    is StreamSignal.Item -> {
                        signal.item.id?.let { lastEventId = it }
                        if (signal.item.event is AgentEvent.Resync) {
                            // Transcript messages carry no ids. After a replay gap, speaking one
                            // could attribute a concurrent turn's answer to this question.
                            return@supervisorScope VoiceAskOutcome.StillWorking
                        }
                        plan.onActivity?.let { report ->
                            activityEvent(signal.item.event, created.sessionId, posted.messageId)?.let(report)
                        }
                        when (val result = collector.consume(signal.item.event)) {
                            is VoiceAnswerCollector.Result.Continue -> collector = result.collector
                            is VoiceAnswerCollector.Result.Answered -> {
                                val text = result.text
                                return@supervisorScope if (text.isBlank()) {
                                    VoiceAskOutcome.EmptyAnswer
                                } else {
                                    VoiceAskOutcome.Answered(text)
                                }
                            }
                            is VoiceAnswerCollector.Result.Failed ->
                                return@supervisorScope VoiceAskOutcome.Failed(result.message)
                        }
                    }
                    is StreamSignal.Ended -> {
                        if (signal.error is GatewayException.Unauthorized) {
                            return@supervisorScope VoiceAskOutcome.Unauthorized
                        }
                        if (signal.error is GatewayException.Forbidden) {
                            return@supervisorScope VoiceAskOutcome.Unauthorized
                        }
                        delay(REATTACH_DELAY_MILLIS)
                        if (monotonicNanos() >= streamDeadlineNanos) {
                            return@supervisorScope VoiceAskOutcome.StillWorking
                        }
                        streamJob.cancel()
                        streamJob = attach(
                            scope = this,
                            gateway = gateway,
                            lastEventId = lastEventId,
                            signals = signals,
                        )
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            VoiceAskOutcome.Unreachable
        } finally {
            streamJob.cancel()
            signals.close()
        }
    }

    private fun attach(
        scope: CoroutineScope,
        gateway: VoiceAskGateway,
        lastEventId: String?,
        signals: Channel<StreamSignal>,
        opened: CompletableDeferred<Unit>? = null,
    ): Job = scope.launch {
        var failure: Throwable? = null
        try {
            gateway.events(lastEventId) { opened?.complete(Unit) }.collect { item ->
                signals.send(StreamSignal.Item(item))
            }
        } catch (error: Throwable) {
            failure = error
            opened?.completeExceptionally(error)
        } finally {
            if (opened?.isCompleted == false) {
                opened.completeExceptionally(failure ?: GatewayException.InvalidResponse("agent SSE ended before opening"))
            }
            signals.send(StreamSignal.Ended(failure))
        }
    }

    /**
     * A failed non-idempotent POST has no safe client-side identity for reconciliation. Preserve
     * continuity and make the uncertainty explicit instead of speaking another concurrent turn.
     */
    private fun ambiguousSendOutcome(
        created: CreateSessionResponse,
    ): VoiceAskOutcome {
        continuity.record(created.sessionId)
        return VoiceAskOutcome.DeliveryUncertain
    }

    private suspend fun <T> beforeDeadline(startedAt: Long, plan: VoiceAskPlan, block: suspend () -> T): T? {
        val remaining = remainingMillis(startedAt, plan)
        if (remaining <= 0) return null
        return withTimeoutOrNull(remaining) { block() }
    }

    private fun remainingMillis(startedAt: Long, plan: VoiceAskPlan): Long {
        val elapsed = Duration.ofNanos((monotonicNanos() - startedAt).coerceAtLeast(0)).toMillis()
        return plan.budgetMillis - elapsed
    }

    private fun overallRemainingMillis(startedAt: Long, plan: VoiceAskPlan): Long {
        val elapsed = Duration.ofNanos((monotonicNanos() - startedAt).coerceAtLeast(0)).toMillis()
        return plan.budgetMillis + SETTLE_GRACE_MILLIS - elapsed
    }

    private fun operationWindowMillis(startedAt: Long, plan: VoiceAskPlan): Long =
        remainingMillis(startedAt, plan)
            .coerceAtLeast(MINIMUM_REMAINING_MILLIS)
            .coerceAtMost(overallRemainingMillis(startedAt, plan).coerceAtLeast(0))

    private fun viewingForMillis(remaining: Long): Int =
        ceil((remaining + SETTLE_GRACE_MILLIS).toDouble())
            .toLong()
            .coerceIn(1_000, 600_000)
            .toInt()

    private fun notificationMillis(remaining: Long): Int =
        remaining.coerceIn(MINIMUM_REMAINING_MILLIS, MAXIMUM_REMAINING_MILLIS).toInt()

    private sealed interface StreamSignal {
        data class Item(val item: AgentStreamItem) : StreamSignal
        data class Ended(val error: Throwable?) : StreamSignal
    }

    companion object {
        const val MAX_QUESTION_LENGTH = 10_000
        const val ANSWER_BUDGET_MILLIS = 20_000L

        /**
         * The wait for a question a watch relays. The watch shows progress for the whole of it, so
         * most turns settle in time to be shown on the wrist; it stays under the watch's own
         * patience for the reply (`RelayPatience.SEND_TIMEOUT`).
         */
        const val WATCH_RELAY_BUDGET_MILLIS = 45_000L
        const val MINIMUM_REMAINING_MILLIS = 1_000L
        const val MAXIMUM_REMAINING_MILLIS = 600_000L
        const val SETTLE_GRACE_MILLIS = 10_000L
        const val REATTACH_DELAY_MILLIS = 500L
        const val STREAM_BUFFER_CAPACITY = 64
        private const val NANOS_PER_MILLI = 1_000_000L
        internal const val BUSY_FOLLOW_UP =
            "Your follow-up was not sent because this conversation is still busy. Please ask again shortly."
        internal const val RESUME_REFUSED =
            "Couldn't reopen that conversation. Try again or start a new question."

        /**
         * The milestone a stream event marks for the watched turn, or null. The feed is
         * caller-wide, so an event of another session or message is never this ask's progress.
         * A batch call's child results are reported under `<call>#<index>`.
         */
        internal fun activityEvent(event: AgentEvent, sessionId: String, messageId: String): AskActivityEvent? {
            if (event.sessionId != sessionId) return null
            return when (event) {
                is AgentEvent.MessageStart ->
                    AskActivityEvent.AgentStarted.takeIf { event.messageId == messageId }
                is AgentEvent.ToolInputStart ->
                    AskActivityEvent.ToolStarted(event.toolCallId, event.tool).takeIf { event.messageId == messageId }
                is AgentEvent.ToolStart ->
                    AskActivityEvent.ToolStarted(event.toolCallId, event.tool).takeIf { event.messageId == messageId }
                is AgentEvent.ToolResult ->
                    AskActivityEvent.ToolFinished(event.toolCallId, toolOutcome(event.result))
                        .takeIf { event.messageId == messageId }
                is AgentEvent.ToolChildResult ->
                    AskActivityEvent.ToolFinished("${event.toolCallId}#${event.childIndex}", toolOutcome(event.result))
                        .takeIf { event.messageId == messageId }
                else -> null
            }
        }

        /** What a finished call retrieved, as counts only: nothing of what was searched or read. */
        internal fun toolOutcome(result: AgentToolResult): AskToolOutcome = when (result) {
            is AgentToolResult.SearchResults -> AskToolOutcome.Search(result.results.size)
            is AgentToolResult.DocumentResult -> AskToolOutcome.DocumentOpened
            is AgentToolResult.SearchBatch -> batchOutcome(result.items)
            is AgentToolResult.DocumentBatch -> batchOutcome(result.items)
            else -> AskToolOutcome.None
        }

        private fun batchOutcome(items: List<AgentToolResult>): AskToolOutcome {
            val outcomes = items.map(::toolOutcome)
            return AskToolOutcome.Batch(
                found = outcomes.sumOf {
                    when (it) {
                        is AskToolOutcome.Search -> it.found
                        is AskToolOutcome.Batch -> it.found
                        else -> 0
                    }
                },
                opened = outcomes.sumOf {
                    when (it) {
                        AskToolOutcome.DocumentOpened -> 1
                        is AskToolOutcome.Batch -> it.opened
                        else -> 0
                    }
                },
            )
        }
    }
}

/** How one ask is run. The default is the ask a person watches on this phone. */
internal data class VoiceAskPlan(
    /** The whole ask's wait, setup round trips included, measured from its start. */
    val budgetMillis: Long = VoiceAskRunner.ANSWER_BUDGET_MILLIS,
    /** A conversation the caller named; refused rather than replaced when it cannot be continued. */
    val resuming: String? = null,
    val delivery: Delivery = Delivery.CALLER_WAITS,
    /** How long the turn is followed once posted, when shorter than what is left of the budget. */
    val turnWaitMillis: Long? = null,
    val onActivity: ((AskActivityEvent) -> Unit)? = null,
) {
    /** Who tells the person about an answer the caller does not show. */
    enum class Delivery {
        /** The caller presents the answer; the gateway pushes one that outlives the wait. */
        CALLER_WAITS,

        /** The gateway announces every answer, and withdraws it once told the answer was seen. */
        GATEWAY_ANNOUNCES,

        /** The gateway pushes an answer that outlives the shortest silent window; an earlier one is the caller's. */
        HAND_OFF,
    }

    /**
     * Whether an ask that ended as [outcome], and was not shown, needs a notification from this
     * phone because the gateway will send none.
     */
    fun notifiesLocally(outcome: VoiceAskOutcome): Boolean = when (outcome) {
        is VoiceAskOutcome.Answered, is VoiceAskOutcome.Failed, VoiceAskOutcome.EmptyAnswer ->
            delivery == Delivery.HAND_OFF
        VoiceAskOutcome.StillWorking, VoiceAskOutcome.PreviousTurnRunning -> false
        else -> true
    }
}

/** How a relayed ask ended, and what a caller needs to deliver or follow up its answer. */
data class VoiceAskRun(
    val outcome: VoiceAskOutcome,
    /** The conversation the question went to, when it reached one. */
    val conversationId: String?,
    /** The assistant message holding the answer, once the question was posted. */
    val messageId: String?,
    /** No gateway notification will announce this outcome. */
    val notifyLocally: Boolean,
) {
    internal companion object {
        /** An ask that ended before reaching a conversation. */
        fun ended(outcome: VoiceAskOutcome) = VoiceAskRun(outcome, null, null, notifyLocally = true)
    }
}

/** Narrow transport port that keeps the voice runner independently scriptable in tests. */
internal interface VoiceAskGateway {
    suspend fun createSession(
        resumeFromId: String? = null,
        transcriptLimit: Int? = null,
        profile: AgentSessionProfile,
    ): CreateSessionResponse

    suspend fun sendMessage(
        sessionId: String,
        text: String,
        notifyAfterMs: Int,
        viewingForMs: Int?,
    ): SendMessageResponse

    fun events(lastEventId: String?, onOpen: () -> Unit): Flow<AgentStreamItem>
}

private class ProductionVoiceAskGateway(
    private val session: SessionManager.GatewaySession,
) : VoiceAskGateway {
    override suspend fun createSession(
        resumeFromId: String?,
        transcriptLimit: Int?,
        profile: AgentSessionProfile,
    ): CreateSessionResponse = session.agent.createSession(
        resumeFromId = resumeFromId,
        transcriptLimit = transcriptLimit,
        profile = profile,
    )

    override suspend fun sendMessage(
        sessionId: String,
        text: String,
        notifyAfterMs: Int,
        viewingForMs: Int?,
    ): SendMessageResponse = session.agent.sendMessage(
        sessionId = sessionId,
        text = text,
        notifyAfterMs = notifyAfterMs,
        viewingForMs = viewingForMs,
    )

    override fun events(lastEventId: String?, onOpen: () -> Unit): Flow<AgentStreamItem> =
        session.newAgentEventSource().events(lastEventId, onOpen)
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.AgentSessionProfile
import dev.omnesis.android.transport.client.AgentStreamItem
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.SendMessageResponse
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
 * Runs the bounded voice-profile agent turn behind an Android App Action.
 *
 * The stream attaches before the question is posted and survives ordinary connection drops with
 * Last-Event-ID replay. Only a clean, message-id-scoped terminal event is spoken; replay gaps and
 * ambiguous POST failures fall back to the visible conversation because transcript rows do not
 * carry enough identity to safely distinguish concurrent turns.
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

    suspend fun run(question: String): VoiceAskOutcome {
        val cleaned = question.trim()
        if (cleaned.isEmpty()) return VoiceAskOutcome.EmptyAnswer
        if (cleaned.length > MAX_QUESTION_LENGTH) {
            return VoiceAskOutcome.Failed("Questions are capped at $MAX_QUESTION_LENGTH characters.")
        }

        val startedAt = monotonicNanos()
        val gateway = sessionProvider() ?: return VoiceAskOutcome.NotPaired
        val created = try {
            beforeDeadline(startedAt) { voiceSession(gateway) }
                ?: return VoiceAskOutcome.Unreachable
        } catch (_: GatewayException.Forbidden) {
            return VoiceAskOutcome.Unauthorized
        } catch (_: GatewayException.Unauthorized) {
            return VoiceAskOutcome.Unauthorized
        } catch (_: GatewayException) {
            return VoiceAskOutcome.Unreachable
        }

        if (created.busy) {
            continuity.record(created.sessionId)
            return VoiceAskOutcome.PreviousTurnRunning
        }

        return collectTurn(
            gateway = gateway,
            created = created,
            question = cleaned,
            startedAt = startedAt,
        )
    }

    private suspend fun voiceSession(gateway: VoiceAskGateway): CreateSessionResponse {
        val resumeId = continuity.conversationToResume()
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
        }
        return gateway.createSession(profile = AgentSessionProfile.VOICE)
    }

    private suspend fun collectTurn(
        gateway: VoiceAskGateway,
        created: CreateSessionResponse,
        question: String,
        startedAt: Long,
    ): VoiceAskOutcome = supervisorScope<VoiceAskOutcome> {
        val remainingBeforePost = operationWindowMillis(startedAt)
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

            val remaining = operationWindowMillis(startedAt)
            if (remaining <= 0) return@supervisorScope VoiceAskOutcome.Unreachable
            val sent = try {
                withTimeout(remaining) {
                    gateway.sendMessage(
                        sessionId = created.sessionId,
                        text = question,
                        notifyAfterMs = notificationMillis(remainingMillis(startedAt)),
                        viewingForMs = viewingForMillis(remaining),
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
            continuity.record(created.sessionId)

            var collector = VoiceAnswerCollector(created.sessionId, sent.messageId)
            var lastEventId: String? = null
            val streamDeadlineNanos = minOf(
                startedAt + (ANSWER_BUDGET_MILLIS + SETTLE_GRACE_MILLIS) * NANOS_PER_MILLI,
                maxOf(
                    startedAt + ANSWER_BUDGET_MILLIS * NANOS_PER_MILLI,
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

    private suspend fun <T> beforeDeadline(startedAt: Long, block: suspend () -> T): T? {
        val remaining = remainingMillis(startedAt)
        if (remaining <= 0) return null
        return withTimeoutOrNull(remaining) { block() }
    }

    private fun remainingMillis(startedAt: Long): Long {
        val elapsed = Duration.ofNanos((monotonicNanos() - startedAt).coerceAtLeast(0)).toMillis()
        return ANSWER_BUDGET_MILLIS - elapsed
    }

    private fun overallRemainingMillis(startedAt: Long): Long {
        val elapsed = Duration.ofNanos((monotonicNanos() - startedAt).coerceAtLeast(0)).toMillis()
        return ANSWER_BUDGET_MILLIS + SETTLE_GRACE_MILLIS - elapsed
    }

    private fun operationWindowMillis(startedAt: Long): Long =
        remainingMillis(startedAt)
            .coerceAtLeast(MINIMUM_REMAINING_MILLIS)
            .coerceAtMost(overallRemainingMillis(startedAt).coerceAtLeast(0))

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
        const val MINIMUM_REMAINING_MILLIS = 1_000L
        const val MAXIMUM_REMAINING_MILLIS = 600_000L
        const val SETTLE_GRACE_MILLIS = 10_000L
        const val REATTACH_DELAY_MILLIS = 500L
        const val STREAM_BUFFER_CAPACITY = 64
        private const val NANOS_PER_MILLI = 1_000_000L
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
        viewingForMs: Int,
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
        viewingForMs: Int,
    ): SendMessageResponse = session.agent.sendMessage(
        sessionId = sessionId,
        text = text,
        notifyAfterMs = notifyAfterMs,
        viewingForMs = viewingForMs,
    )

    override fun events(lastEventId: String?, onOpen: () -> Unit): Flow<AgentStreamItem> =
        session.newAgentEventSource().events(lastEventId, onOpen)
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.RelayPatience
import dev.omnesis.android.wearprotocol.VoiceNudge
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds

/** How a relayed question ended, and the conversation it ran in when the phone named one. */
data class AskSettlement(val outcome: AskOutcome, val conversationId: String? = null)

/**
 * Relays one question to the phone and waits for how it ended.
 *
 * A phone app the system has evicted takes a while to start, so an
 * unreachable phone is retried for the whole [RelayPatience.DELIVERY_WINDOW];
 * past it the question is queued as a DataItem, which the system delivers
 * whenever the phone app next runs. Only an unreachable phone is retried:
 * every other outcome means the phone has the question, so it is never asked
 * twice.
 */
class AskRelay(
    private val link: PhoneLink,
    private val environment: WatchEnvironment,
    private val log: WatchLog,
) {
    private class Pending(val ref: String, val settled: CompletableDeferred<AskSettlement>)

    /**
     * The send in flight, settled by whichever of the phone's reply, its
     * separate result message, or the timeout comes first.
     */
    private var pending: Pending? = null

    /**
     * Relay [request] until the phone takes it or the delivery window closes,
     * then queue it. [onWaking] runs before each pause between attempts.
     * Cancelling the caller stops the relay at once and queues nothing: an
     * answer to a question the person replaced would arrive unprompted.
     */
    suspend fun relay(request: AskRequest, onWaking: () -> Unit): AskSettlement {
        val started = environment.now()
        var attempts = 0
        var lastCode: Int? = null
        while (true) {
            waitForReachability()
            attempts += 1
            val attempt = sendOnce(request)
            val elapsed = (environment.now() - started).milliseconds
            if (attempt.settlement.outcome != AskOutcome.PhoneUnreachable) {
                log.info("Relay reached the phone on attempt $attempts after ${elapsed.inWholeMilliseconds} ms")
                return attempt.settlement
            }
            lastCode = attempt.code
            log.info("Relay attempt $attempts found the phone unreachable after ${elapsed.inWholeMilliseconds} ms (code $lastCode)")
            if (attempt.phoneCannotReceive) return attempt.settlement
            val pause = RelayPatience.pause(attempts, elapsed) ?: break
            onWaking()
            delay(pause)
        }
        val queued = QueuedRelay(request, environment.now(), relayAttempts = attempts, relayLastError = lastCode)
        if (!link.putItem(WearDataLayer.queuedPath(request.ref), WearCodec.encode(queued))) {
            return AskSettlement(AskOutcome.PhoneUnreachable)
        }
        link.send(WearDataLayer.VOICE_NUDGE_PATH, WearCodec.encode(VoiceNudge))
        log.info("Relay queued for the phone after $attempts live attempts")
        return AskSettlement(AskOutcome.QueuedForPhone)
    }

    /**
     * The phone's result message for [ref], sent beside its reply so a lost
     * reply does not strand the wait. A result for any other question is
     * ignored.
     */
    fun resolve(ref: String, result: AskResult) {
        val waiting = pending?.takeIf { it.ref == ref } ?: return
        waiting.settled.complete(AskSettlement(result.toOutcome(), result.conversationId))
    }

    private class Attempt(val settlement: AskSettlement, val phoneCannotReceive: Boolean = false, val code: Int? = null)

    private suspend fun sendOnce(request: AskRequest): Attempt = coroutineScope {
        val settled = CompletableDeferred<AskSettlement>()
        val waiting = Pending(request.ref, settled)
        pending = waiting
        var unreachable: LinkReply.Unreachable? = null
        val send = launch {
            val reply = link.request(WearDataLayer.ASK_PATH, WearCodec.encode(request))
            unreachable = reply as? LinkReply.Unreachable
            settled.complete(settlement(reply, request.ref))
        }
        try {
            // Without this cap a reply the Data Layer lost would leave the watch waiting forever.
            val settlement = withTimeoutOrNull(RelayPatience.SEND_TIMEOUT) { settled.await() }
                ?: AskSettlement(AskOutcome.AnswerOnPhone)
            Attempt(settlement, unreachable?.phoneCannotReceive == true, unreachable?.code)
        } finally {
            send.cancel()
            if (pending === waiting) pending = null
        }
    }

    private fun settlement(reply: LinkReply, ref: String): AskSettlement = when (reply) {
        is LinkReply.Reply -> {
            val result = WearCodec.decode(reply.payload) as? AskResult
            if (result == null || (result.ref != null && result.ref != ref)) {
                AskSettlement(AskOutcome.RelayFailed)
            } else {
                AskSettlement(result.toOutcome(), result.conversationId)
            }
        }
        is LinkReply.Unreachable -> AskSettlement(AskOutcome.PhoneUnreachable)
        // The phone took the question but its answer outran the wait; the
        // phone delivers it as a notification.
        is LinkReply.TimedOut -> AskSettlement(AskOutcome.StillWorking)
        is LinkReply.LinkDown -> AskSettlement(AskOutcome.WatchLinkInactive)
        is LinkReply.Failed -> AskSettlement(AskOutcome.RelayFailed)
    }

    /**
     * Give the link a moment to report the phone connected. Returns either
     * way: an unreachable send still ends in the stated failure.
     */
    private suspend fun waitForReachability() {
        repeat(REACHABILITY_POLLS) {
            if (link.phoneReachable()) return
            delay(REACHABILITY_POLL_INTERVAL)
        }
    }

    private companion object {
        const val REACHABILITY_POLLS = 20
        val REACHABILITY_POLL_INTERVAL: Duration = 150.milliseconds
    }
}

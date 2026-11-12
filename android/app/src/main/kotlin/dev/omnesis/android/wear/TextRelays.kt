// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskActivitySnapshot
import dev.omnesis.android.wearprotocol.AskActivityTimeline
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskProgress
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.LiveAskLedger
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.RelayInbox
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Sends one question's progress to the watch, a step at a time and in the
 * order the steps happened. Best effort: a watch that misses one keeps the
 * previous step on screen, and no failure here reaches the question.
 *
 * [report] is called from whatever runs the turn and never suspends; [deliver]
 * sends what was reported and returns once [finish] has been called and the
 * last step is out.
 */
internal class AskProgressReporter(
    private val gateway: WearGateway,
    private val nodeId: String,
    private val ref: String?,
) {
    private val timeline = AskActivityTimeline()
    private val pending = Channel<AskProgress>(Channel.UNLIMITED)
    private var sent: AskActivitySnapshot? = null

    @Synchronized
    fun report(event: AskActivityEvent) {
        val snapshot = timeline.apply(event)
        // A replayed event leaves the snapshot as it was; the watch already shows it.
        if (snapshot == sent) return
        sent = snapshot
        pending.trySend(AskProgress.of(snapshot, ref))
    }

    fun finish() {
        pending.close()
    }

    suspend fun deliver() {
        for (progress in pending) {
            attempt { gateway.sendMessage(nodeId, WearDataLayer.PROGRESS_PATH, progress) }
        }
    }

    companion object {
        /** How long a finished question waits for its last step to leave before the result follows. */
        val DRAIN_TIMEOUT: Duration = 500.milliseconds

        /**
         * Runs [turn] with a reporter whose steps are sent while it runs, and
         * returns once the steps reported are out or [DRAIN_TIMEOUT] has passed,
         * so the result that follows never overtakes them.
         */
        suspend fun <T> reporting(
            gateway: WearGateway,
            nodeId: String?,
            ref: String?,
            turn: suspend (report: (AskActivityEvent) -> Unit) -> T,
        ): T {
            if (nodeId == null) return turn {}
            return coroutineScope {
                val reporter = AskProgressReporter(gateway, nodeId, ref)
                val delivery = launch { reporter.deliver() }
                try {
                    turn(reporter::report)
                } finally {
                    reporter.finish()
                    withTimeoutOrNull(DRAIN_TIMEOUT) { delivery.join() }
                    delivery.cancel()
                }
            }
        }
    }
}

/**
 * Answers a question the watch sent as a request. The reply is the result;
 * the same result is also sent on its own first, so a reply lost on the way
 * back does not strand the watch on an answer that exists. A later copy of a
 * question already taken is answered from the first and never asked again.
 */
class TextAskRelay(
    private val gateway: WearGateway,
    private val asker: WatchAsker,
    private val handled: HandledRefs,
) {
    private val ledger = LiveAskLedger<CompletableDeferred<AskResult>>()

    suspend fun onRequest(nodeId: String, request: AskRequest): AskResult {
        val ref = request.ref.takeIf { it.isNotEmpty() }
        val question = request.trimmedQuestion ?: return AskResult.of(AskOutcome.Failed(), ref)
        if (ref != null) {
            val waiter = CompletableDeferred<AskResult>()
            when (val claim = synchronized(ledger) { ledger.claim(ref, handled.claim(ref), waiter) }) {
                LiveAskLedger.Claim.Run -> Unit
                LiveAskLedger.Claim.Held -> return waiter.await()
                is LiveAskLedger.Claim.Reply -> return claim.result
                // Taken from a queued copy, or too long ago to remember: the answer is on its way another way.
                LiveAskLedger.Claim.Untracked -> return AskResult.of(AskOutcome.StillWorking, ref)
            }
        }
        val run = AskProgressReporter.reporting(gateway, nodeId, ref) { report ->
            report(AskActivityEvent.RelayReceived)
            asker.ask(question, request.resumedConversationId, report)
        }
        val result = AskResult.of(run.outcome, ref, run.conversationId, run.messageId)
        attempt { gateway.sendMessage(nodeId, WearDataLayer.RESULT_PATH, result) }
        if (ref != null) synchronized(ledger) { ledger.settle(ref, result) }.forEach { it.complete(result) }
        return result
    }
}

/** Saves a note the watch dictated as text and says what became of it. */
class TextNoteRelay(
    private val notes: WatchNoteSaver,
    private val handled: HandledRefs,
) {
    suspend fun onRequest(note: TextNote): NoteAck {
        val text = note.trimmedText
        val captureTime = note.captureTime
        if (text == null || captureTime == null) return NoteAck.of(NoteOutcome.RELAY_FAILED, note.ref)
        // An earlier copy is already being saved: say it reached the phone rather than save it twice.
        if (!handled.claim(note.ref)) return NoteAck.of(NoteOutcome.REACHED_PHONE, note.ref)
        return NoteAck.of(notes.save(text, captureTime, note.ref, audio = null), note.ref)
    }
}

/**
 * Acts on a relay the watch queued because the phone app never took it live.
 * A note is saved like a live one. A question is handed to the gateway and its
 * answer reaches the person as a notification: the gateway's push, or a local
 * one when the turn settled before a push was armed. A question too old to
 * answer is reported once, not dropped in silence. The item is deleted once
 * dealt with, whatever became of it.
 */
class QueuedRelayHandler(
    private val gateway: WearGateway,
    private val asker: WatchAsker,
    private val notes: WatchNoteSaver,
    private val handled: HandledRefs,
    private val notifier: RelayNotifier,
    private val now: () -> Long,
) {
    suspend fun handle(item: WearItem): RelayInbox.Action? {
        val queued = item.payload as? QueuedRelay
        val action = queued?.let { handled.route(it, now()) }
        when (action) {
            is RelayInbox.Action.SaveNote -> {
                val outcome = notes.save(action.text, action.captureTime, action.ref, audio = null)
                acknowledge(item, NoteAck.of(outcome, action.ref))
            }
            is RelayInbox.Action.Ask -> {
                val run = asker.handOff(action.question, action.conversationId)
                RelayNotice.queuedAsk(run.outcome, run.conversationId)?.let(notifier::post)
            }
            is RelayInbox.Action.Drop -> when (action.reason) {
                // Said once: the item is deleted below, but a copy the Data Layer delivers again must
                // not repeat the notice, nor report a question that was in fact answered live.
                RelayInbox.DropReason.EXPIRED ->
                    if (handled.claim((queued?.message as? AskRequest)?.ref)) notifier.post(RelayNotice.questionExpired)
                // The live copy of a note was saved; its queued copy only needs releasing.
                RelayInbox.DropReason.DUPLICATE -> (queued?.message as? TextNote)?.let {
                    acknowledge(item, NoteAck.of(NoteOutcome.REACHED_PHONE, it.ref))
                }
                RelayInbox.DropReason.NOTE_WITHOUT_CAPTURE_TIME, RelayInbox.DropReason.UNKNOWN_KIND -> Unit
            }
            null -> Unit
        }
        attempt { gateway.deleteItem(item.path, item.sourceNodeId) }
        return action
    }

    /** Tells the watch its outbox may release the note, when the watch is in reach to hear it. */
    private suspend fun acknowledge(item: WearItem, ack: NoteAck) {
        val node = item.sourceNodeId ?: return
        attempt { gateway.sendMessage(node, WearDataLayer.NOTE_PATH, ack) }
    }
}

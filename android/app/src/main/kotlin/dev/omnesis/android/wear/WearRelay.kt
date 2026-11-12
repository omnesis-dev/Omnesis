// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.DisplayedReceipt
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the relay asks of the system's scheduler. */
interface RelayKeepAlive {
    /** Keeps the app's process running until the relay is idle; called when work starts with none under way. */
    fun hold()

    /** Arranges for the gate to be published again each day, now that a watch is known to exist. */
    fun keepGateFresh()
}

/**
 * The phone side of the watch relay: everything a watch sends lands here and
 * is routed to the orchestrator that owns it.
 *
 * Work runs in [scope], which belongs to the app and not to whatever delivered
 * the event. The Data Layer's listener service lives only as long as its
 * callbacks, while a question takes most of a minute: the work must not end
 * because the callback that started it returned. While anything is under way
 * [keepAlive] holds the process; [awaitIdle] is what it waits on.
 */
class WearRelay(
    private val scope: CoroutineScope,
    private val gateway: WearGateway,
    private val gate: GatePublisher,
    private val asks: TextAskRelay,
    private val notes: TextNoteRelay,
    private val queued: QueuedRelayHandler,
    private val recordings: RecordingPipeline,
    private val state: RelayStateStore,
    private val keepAlive: RelayKeepAlive,
    private val knowledge: () -> GateKnowledge,
) {
    private val inFlight = MutableStateFlow(0)
    private val scan = Mutex()

    /**
     * Answers a request the watch is waiting on, as the reply's bytes. Null for
     * a path that is not a relay request. The reply is produced even when the
     * caller stops waiting for it.
     */
    suspend fun onRequest(nodeId: String, path: String, data: ByteArray): ByteArray? {
        watchSeen()
        val message = WearCodec.decode(data)
        val reply: Deferred<WearMessage> = when (path) {
            WearDataLayer.ASK_PATH -> work {
                val ask = message as? AskRequest
                ask?.let { attempt { asks.onRequest(nodeId, it) } } ?: AskResult.of(AskOutcome.Failed(), ask?.ref)
            }
            WearDataLayer.NOTE_PATH -> work {
                val note = message as? TextNote ?: return@work NoteAck.of(NoteOutcome.RELAY_FAILED, null)
                attempt { notes.onRequest(note) } ?: NoteAck.of(NoteOutcome.CAPTURE_FAILED, note.ref)
            }
            else -> return null
        }
        return WearCodec.encode(reply.await())
    }

    /** A message the watch sent without waiting for a reply. */
    fun onMessage(path: String, data: ByteArray) {
        watchSeen()
        when (path) {
            // Being woken is the point: whatever the watch put is acted on from its DataItem.
            WearDataLayer.VOICE_NUDGE_PATH -> work { resumePending() }
            WearDataLayer.DISPLAYED_PATH ->
                (WearCodec.decode(data) as? DisplayedReceipt)?.let { work { recordings.onDisplayed(it) } }
        }
    }

    /** A DataItem a watch put or changed. */
    fun onItem(item: WearItem) {
        watchSeen()
        when {
            WearDataLayer.recordingRef(item.path) != null -> work { recordings.onItem(item) }
            WearDataLayer.queuedRef(item.path) != null -> work { queued.handle(item) }
        }
    }

    /** A watch running the Omnesis app came into reach: tell it the gate, and pick up what it left. */
    fun onWatchConnected() {
        watchSeen()
        work {
            gate.update(knowledge(), force = true)
            resumePending()
        }
    }

    /**
     * Publishes the gate when what the phone knows — its pairing, the
     * gateway's status — implies a different one, or the last is a day old.
     * A single local write, so it holds nothing alive.
     */
    suspend fun refreshGate() {
        gate.update(knowledge())
    }

    /**
     * Acts on everything waiting: the recordings and queued relays the watch
     * put that no callback delivered to this process, and the recordings an
     * earlier process left unfinished.
     */
    suspend fun resumePending() = scan.withLock {
        attempt { gateway.items(WearDataLayer.RECORDING_PATH_PREFIX) }.orEmpty().forEach { recordings.onItem(it) }
        attempt { gateway.items(WearDataLayer.QUEUED_PATH_PREFIX) }.orEmpty().forEach { queued.handle(it) }
        recordings.resume()
    }

    /** Runs the recordings kept for retry again, as the person asked from settings. */
    fun retryRecordings() {
        work { recordings.resume() }
    }

    /** How many recordings are kept for a later run. */
    fun waitingRecordings(): Int = recordings.waiting()

    /** Keeps the daily gate refresh arranged on a phone a watch has reached before. */
    fun ensureGateRefresh() {
        if (state.watchKnown()) keepAlive.keepGateFresh()
    }

    /** Suspends until nothing the relay started is still running. */
    suspend fun awaitIdle() {
        inFlight.first { it == 0 }
    }

    /** The first sign of a watch is what arranges the daily gate refresh; a phone without one never has it. */
    private fun watchSeen() {
        if (state.watchKnown()) return
        state.markWatchKnown()
        keepAlive.keepGateFresh()
    }

    private fun <T> work(block: suspend () -> T): Deferred<T> {
        if (inFlight.getAndUpdate { it + 1 } == 0) keepAlive.hold()
        return scope.async {
            try {
                block()
            } finally {
                inFlight.update { it - 1 }
            }
        }
    }
}

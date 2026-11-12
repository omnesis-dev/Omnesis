// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.OutboxEntry
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.RelayQueue
import dev.omnesis.android.wearprotocol.VoiceNudge
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Hands the notes waiting in the [OutboxStore] to the phone, as
 * [OutboxPolicy] directs, and releases each when the phone confirms it.
 *
 * A recording goes as a DataItem carrying its audio; a text note goes as a
 * live request when the phone is reachable and as a queued DataItem
 * otherwise. A DataItem the system still holds is what carries a note between
 * launches, so a note is handed over again only when no item holds it.
 *
 * Nothing is handed over while no phone runs the phone app. Every pass ends
 * by scheduling the next one [OutboxPolicy.nextRetry] names, so while
 * anything waits there is always a pass to come, whether or not the phone
 * app's arrival is ever announced.
 */
class OutboxEngine(
    private val store: OutboxStore,
    private val link: PhoneLink,
    private val environment: WatchEnvironment,
    private val log: WatchLog,
    private val retry: RetryScheduler,
    private val scope: CoroutineScope,
    private val onDropped: () -> Unit,
) {
    private val passes = Mutex()

    /** Text notes whose live request is awaiting the phone's reply: carried, so not handed over again meanwhile. */
    private val liveNoteSends = mutableSetOf<String>()

    /**
     * Hand every waiting note that nothing carries to the Data Layer, drop
     * those that waited too long, and wake a reachable phone app for what is
     * outstanding. Returns the refs now carried.
     */
    suspend fun flush(trigger: OutboxPolicy.Trigger): Set<String> = passes.withLock {
        val now = environment.now()
        val entries = store.entries()
        val waiting = entries.associateBy { it.ref }
        val carried = (heldRecordings(waiting) + heldQueuedNotes(waiting, now) + liveNoteSends).toMutableSet()
        val reachable = link.phoneReachable()
        val installed = reachable || link.phoneAppInstalled()
        var dropped = 0
        for ((ref, action) in OutboxPolicy.plan(entries, carried, trigger, now)) {
            val entry = waiting.getValue(ref)
            when (action) {
                OutboxPolicy.Action.SEND -> if (installed && send(entry, reachable)) carried += ref
                OutboxPolicy.Action.DROP -> {
                    deleteItems(ref)
                    carried -= ref
                    store.drop(ref)
                    dropped += 1
                }
                OutboxPolicy.Action.WAIT -> Unit
            }
        }
        if (dropped > 0) {
            log.error("Dropped $dropped notes that waited too long for the phone")
            onDropped()
        }
        // A DataItem alone may not start the phone app promptly; a message does.
        if (carried.isNotEmpty() && reachable) link.send(WearDataLayer.VOICE_NUDGE_PATH, WearCodec.encode(VoiceNudge))
        retry.schedule(OutboxPolicy.nextRetry(store.entries(), carried, environment.now()))
        carried
    }

    /** The phone confirmed the note or recording named [ref]: it leaves the outbox, with any DataItem holding it. */
    fun confirmed(ref: String) {
        store.remove(ref)
        if (store.entries().isEmpty()) retry.schedule(null)
        scope.launch { deleteItems(ref) }
    }

    /** The refs of waiting recordings a DataItem holds. An item for a recording no longer waiting is deleted. */
    private suspend fun heldRecordings(waiting: Map<String, OutboxEntry>): Set<String> {
        val held = mutableSetOf<String>()
        for (item in link.items(WearDataLayer.RECORDING_PATH_PREFIX)) {
            val ref = WearDataLayer.recordingRef(item.path) ?: continue
            if (ref in waiting) held += ref else link.deleteItem(item.path)
        }
        return held
    }

    /**
     * The refs of waiting text notes a queued DataItem holds. A queued note
     * no longer waiting is deleted, and so is a queued question no phone ever
     * took; one that is merely too old to answer stays for the phone, which
     * tells the person.
     */
    private suspend fun heldQueuedNotes(waiting: Map<String, OutboxEntry>, now: Long): Set<String> {
        val held = mutableSetOf<String>()
        for (item in link.items(WearDataLayer.QUEUED_PATH_PREFIX)) {
            val ref = WearDataLayer.queuedRef(item.path) ?: continue
            val queued = item.payload?.let(WearCodec::decode) as? QueuedRelay
            when {
                ref in waiting -> held += ref
                queued != null && queued.message is AskRequest && !RelayQueue.askIsAbandoned(queued.queuedAt, now) -> Unit
                else -> link.deleteItem(item.path)
            }
        }
        return held
    }

    /** Hand one waiting note over. True when something now carries it. */
    private suspend fun send(entry: OutboxEntry, phoneReachable: Boolean): Boolean {
        val ref = entry.ref
        return when (OutboxPolicy.transport(entry, phoneReachable)) {
            OutboxPolicy.Transport.RECORDING_ITEM -> {
                val path = WearDataLayer.recordingPath(ref)
                link.putItem(path, WearCodec.encode(entry.content), store.audioFile(ref)).also { stored ->
                    if (!stored) failed(ref, "Recording hand-over")
                }
            }
            OutboxPolicy.Transport.QUEUED_ITEM -> queue(entry)
            OutboxPolicy.Transport.LIVE_MESSAGE -> {
                liveNoteSends += ref
                scope.launch { sendLive(entry) }
                true
            }
        }
    }

    /**
     * Send a text note as a request. Any reply means the phone has the note;
     * a request that fails puts the note on the queued channel instead.
     */
    private suspend fun sendLive(entry: OutboxEntry) {
        val reply = try {
            link.request(WearDataLayer.NOTE_PATH, WearCodec.encode(entry.content))
        } finally {
            liveNoteSends -= entry.ref
        }
        if (reply is LinkReply.Reply) {
            confirmed(entry.ref)
            return
        }
        log.info("Live note send failed, queueing it: ${reply::class.simpleName}")
        if (!passes.withLock { queue(entry) }) flush(OutboxPolicy.Trigger.RETRY)
    }

    /** Put a text note's queued copy, stamped with when it joined the outbox. */
    private suspend fun queue(entry: OutboxEntry): Boolean {
        val payload = WearCodec.encode(QueuedRelay(entry.content, entry.queuedAt))
        return link.putItem(WearDataLayer.queuedPath(entry.ref), payload).also { stored ->
            if (!stored) failed(entry.ref, "Queued note hand-over")
        }
    }

    private fun failed(ref: String, what: String) {
        log.error("$what failed, will retry")
        store.recordFailure(ref)
    }

    private suspend fun deleteItems(ref: String) {
        link.deleteItem(WearDataLayer.recordingPath(ref))
        link.deleteItem(WearDataLayer.queuedPath(ref))
    }
}

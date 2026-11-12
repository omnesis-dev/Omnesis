// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.RecentRefs
import dev.omnesis.android.wearprotocol.RelayInbox

/** What the relay keeps across process death. */
interface RelayStateStore {
    /** The gate last published to the watch. */
    fun loadGate(): DictationGate?

    fun saveGate(gate: DictationGate)

    /** The relay refs already acted on, oldest first. */
    fun loadHandledRefs(): List<String>

    fun saveHandledRefs(refs: List<String>)

    /** Whether a watch running the Omnesis app has ever reached this phone. */
    fun watchKnown(): Boolean

    fun markWatchKnown()
}

/**
 * The relay refs this phone has acted on, so a question or note that arrives
 * both live and queued is handled once. The same bounded window as
 * [RecentRefs], kept on disk as well: a queued copy is delivered by the system
 * whenever the watch next syncs, which can be to a later process than the one
 * that took the live copy.
 */
class HandledRefs(private val store: RelayStateStore) {
    private val recent = RecentRefs()
    private val order = ArrayDeque<String>()

    init {
        store.loadHandledRefs().takeLast(RecentRefs.CAPACITY).forEach {
            if (recent.insert(it)) order.addLast(it)
        }
    }

    /**
     * Records [ref] as handled; false when it already was. A relay without a
     * ref is always new.
     *
     * A question's ref is [durable] from the moment it is claimed: asked
     * twice is worse than not asked, so a process that dies mid-turn leaves
     * the question claimed. A note is the other way round. Saving one twice
     * is harmless, since its ref is its idempotency key, while a note claimed
     * on disk and never saved would be acknowledged to the watch from its
     * next copy and lost; so a note is claimed in memory and written down by
     * [settle] once its save has returned.
     */
    @Synchronized
    fun claim(ref: String?, durable: Boolean = true): Boolean {
        val usable = ref?.takeIf { it.isNotEmpty() }
        val fresh = recent.insert(usable)
        if (fresh && usable != null && durable) remember(usable)
        return fresh
    }

    /** Writes down a ref claimed without durability, now that what it names is done. */
    @Synchronized
    fun settle(ref: String) {
        if (ref.isNotEmpty() && ref !in order) remember(ref)
    }

    /**
     * Decides what to do with a queued relay, recording its ref when it is
     * acted on: a question's durably, a note's until [settle].
     */
    @Synchronized
    fun route(queued: QueuedRelay, now: Long): RelayInbox.Action {
        val action = RelayInbox.route(queued, now, recent)
        if (action is RelayInbox.Action.Ask) remember(action.ref)
        return action
    }

    private fun remember(ref: String) {
        order.addLast(ref)
        while (order.size > RecentRefs.CAPACITY) order.removeFirst()
        store.saveHandledRefs(order.toList())
    }
}

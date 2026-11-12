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

    /** Records [ref] as handled; false when it already was. A relay without a ref is always new. */
    @Synchronized
    fun claim(ref: String?): Boolean {
        val usable = ref?.takeIf { it.isNotEmpty() }
        val fresh = recent.insert(usable)
        if (fresh && usable != null) remember(usable)
        return fresh
    }

    /** Decides what to do with a queued relay, recording its ref when it is acted on. */
    @Synchronized
    fun route(queued: QueuedRelay, now: Long): RelayInbox.Action {
        val action = RelayInbox.route(queued, now, recent)
        when (action) {
            is RelayInbox.Action.SaveNote -> remember(action.ref)
            is RelayInbox.Action.Ask -> remember(action.ref)
            is RelayInbox.Action.Drop -> Unit
        }
        return action
    }

    private fun remember(ref: String) {
        order.addLast(ref)
        while (order.size > RecentRefs.CAPACITY) order.removeFirst()
        store.saveHandledRefs(order.toList())
    }
}

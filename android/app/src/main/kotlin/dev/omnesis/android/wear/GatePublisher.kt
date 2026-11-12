// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.GatePublishing
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the gateway's status says a watch recording may be used for. */
data class RelayGatewayStatus(
    /** The largest recording the gateway transcribes, null when it does not transcribe voice notes. */
    val dictationMaxAudioBytes: Long?,
    /** The gateway decides between a question and a note itself. */
    val decisionGate: Boolean,
)

/** What the phone knows that the watch's gate depends on. [status] is null until one was read. */
data class GateKnowledge(val paired: Boolean, val status: RelayGatewayStatus?)

/**
 * Tells the watch what it may do with a recording, as one DataItem. The rules
 * for what to say and when are [GatePublishing]'s; this applies them to the
 * gate last published and writes the item. The system syncs a DataItem to a
 * watch whenever it next connects, so nothing here needs a watch in reach.
 */
class GatePublisher(
    private val gateway: WearGateway,
    private val store: RelayStateStore,
    private val now: () -> Long,
) {
    private val mutex = Mutex()

    /**
     * Publishes the gate [knowledge] implies when it differs from the last one
     * published or that one is a day old. Nothing is published from ignorance:
     * a paired phone that has not read the gateway's status says nothing.
     *
     * [force] publishes regardless, for a watch that has just connected. Returns
     * whether a gate was written.
     */
    suspend fun update(knowledge: GateKnowledge, force: Boolean = false): Boolean = mutex.withLock {
        val current = now()
        val gate = GatePublishing.gate(
            paired = knowledge.paired,
            statusKnown = knowledge.status != null,
            gatewayMaxAudioBytes = knowledge.status?.dictationMaxAudioBytes,
            now = current,
            decisionGate = knowledge.status?.decisionGate == true,
            // The phone app processes recordings from the unified recorder whenever it is paired.
            captureSupported = true,
        ) ?: return@withLock false
        if (!force && !GatePublishing.shouldPublish(gate, store.loadGate(), current)) return@withLock false
        // Saved only once written, so a write that failed is tried again at the next update.
        attempt { gateway.putItem(WearDataLayer.GATE_PATH, gate) } ?: return@withLock false
        store.saveGate(gate)
        true
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.link

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import dev.omnesis.android.wear.WearApp
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer

/**
 * Receives everything the phone sends, whether or not the app is on screen:
 * the system starts this service for each event, so a recording's receipt or
 * a newly published gate reaches the watch even when the app is not running.
 * Events arrive on a background thread and are handed to the app's logic on
 * the main thread.
 */
class PhoneListenerService : WearableListenerService() {
    private val container get() = (application as WearApp).container

    override fun onMessageReceived(event: MessageEvent) {
        val path = event.path
        val payload = event.data
        container.onMain { received(path, payload, isRequest = false) }
    }

    override fun onRequest(nodeId: String, path: String, request: ByteArray): Task<ByteArray>? {
        val reply = TaskCompletionSource<ByteArray>()
        container.onMain { reply.setResult(received(path, request, isRequest = true) ?: ByteArray(0)) }
        return reply.task
    }

    override fun onDataChanged(events: DataEventBuffer) {
        // The buffer is only valid during this call, so the gate is decoded here.
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED || event.dataItem.uri.path != WearDataLayer.GATE_PATH) continue
            val payload = try {
                DataMapItem.fromDataItem(event.dataItem).dataMap.getByteArray(WearDataLayer.PAYLOAD_KEY)
            } catch (_: IllegalStateException) {
                // An item whose data cannot be read as a DataMap is not a gate.
                null
            }
            val gate = payload?.let(WearCodec::decode) as? DictationGate ?: continue
            container.onMain { gatePublished(gate) }
        }
    }

    override fun onCapabilityChanged(info: CapabilityInfo) {
        container.onMain { linkChanged() }
    }
}

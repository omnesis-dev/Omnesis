// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import com.google.android.gms.tasks.Task
import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.tasks.asTask

/**
 * Where the watch's events enter the phone app: requests it waits on,
 * messages, the DataItems it put, and a watch app coming into reach. Google
 * Play services starts the app's process for any of them, so this works with
 * the app not running.
 *
 * The service only routes. Each event is handed to the app-wide [WearRelay],
 * whose work belongs to the app and is held alive by a job of its own: the
 * system keeps this service bound just long enough to deliver, far less than a
 * question takes. The one thing tied to the service is the wait for a
 * request's reply, and a reply nobody is left to send still reaches the watch
 * as the relay's own result message.
 */
class WearRelayService : WearableListenerService() {
    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun wearRelayForService(): WearRelay

        fun wearGatewayForService(): PlayServicesWearGateway
    }

    /** Replaces the app's relay in a test. */
    internal var relayForTest: WearRelay? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val deps by lazy { EntryPointAccessors.fromApplication(applicationContext, Deps::class.java) }

    private val relay: WearRelay get() = relayForTest ?: deps.wearRelayForService()

    override fun onRequest(nodeId: String, path: String, request: ByteArray): Task<ByteArray>? {
        if (path != WearDataLayer.ASK_PATH && path != WearDataLayer.NOTE_PATH) return null
        val relay = relay
        return scope.async { relay.onRequest(nodeId, path, request) ?: ByteArray(0) }.asTask()
    }

    override fun onMessageReceived(event: MessageEvent) {
        relay.onMessage(event.path, event.data)
    }

    override fun onDataChanged(events: DataEventBuffer) {
        val gateway = deps.wearGatewayForService()
        // Frozen before this returns: the buffer is released with the callback.
        val items = events.filter { it.type == DataEvent.TYPE_CHANGED }.map { gateway.wearItem(it.dataItem.freeze()) }
        items.forEach(relay::onItem)
    }

    override fun onCapabilityChanged(capability: CapabilityInfo) {
        if (capability.name == WearDataLayer.WATCH_CAPABILITY && capability.nodes.isNotEmpty()) {
            relay.onWatchConnected()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}

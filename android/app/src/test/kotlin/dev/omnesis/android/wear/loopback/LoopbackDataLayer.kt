// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.loopback

import dev.omnesis.android.wear.WearGateway
import dev.omnesis.android.wear.WearItem
import dev.omnesis.android.wear.WearNode
import dev.omnesis.android.wear.WearRelay
import dev.omnesis.android.wear.core.LinkItem
import dev.omnesis.android.wear.core.LinkReply
import dev.omnesis.android.wear.core.PhoneLink
import dev.omnesis.android.wear.core.WatchCore
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearMessage
import java.io.File
import java.io.IOException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The Wearable Data Layer between one phone and one watch, in memory, for
 * tests that run both apps' logic against each other. It is both ends' port:
 * [watchLink] is what the watch logic speaks through and [phoneGateway] what
 * the phone relay does, so whatever one side sends arrives at the other the
 * way Play services would deliver it.
 *
 * - **Messages and requests** reach a connected peer after [LATENCY], or fail.
 * - **DataItems** live in a replica per node. A change syncs to the other node
 *   when the two are connected; while they are not, only the state that is
 *   left when they reconnect syncs, so an item put and deleted out of reach
 *   is never seen by the peer. The peer is told of an item that arrives the
 *   way its listener service is: the phone of recordings and queued relays,
 *   the watch of the gate.
 * - **Reachability** follows [connect] and [disconnect], which also deliver
 *   the capability change each app listens for.
 *
 * Everything runs on [scope]'s dispatcher, so one virtual clock drives both
 * sides.
 */
internal class LoopbackDataLayer(private val scope: CoroutineScope) {
    /** One DataItem as a node holds it. */
    private class Item(val owner: String, val path: String, val payload: ByteArray, val audio: ByteArray?) {
        fun holdsWhat(other: Item): Boolean =
            payload.contentEquals(other.payload) && (audio ?: EMPTY).contentEquals(other.audio ?: EMPTY)
    }

    private sealed interface Change {
        val path: String

        class Put(val item: Item) : Change {
            override val path: String get() = item.path
        }

        /** Removes the item [owner] put at [path], or every node's when [owner] is null. */
        class Removal(val owner: String?, override val path: String) : Change
    }

    /** One node's replica of the DataItems, and the changes on their way to it. */
    private inner class Replica(val deliver: (Item) -> Unit) {
        val items = LinkedHashMap<String, Item>()
        private val waiting = ArrayDeque<Change>()
        private val arrivals = Channel<Unit>(Channel.UNLIMITED)

        init {
            scope.launch {
                for (signal in arrivals) {
                    connection.first { it }
                    delay(LATENCY)
                    val change = waiting.removeFirstOrNull() ?: continue
                    apply(change)
                }
            }
        }

        fun find(owner: String?, path: String): List<Item> =
            items.values.filter { it.path == path && (owner == null || it.owner == owner) }

        fun put(item: Item) {
            items[item.owner + item.path] = item
        }

        fun remove(owner: String?, path: String): Boolean =
            find(owner, path).onEach { items.remove(it.owner + it.path) }.isNotEmpty()

        /** A change made on the other node, to arrive here when the link allows. */
        fun incoming(change: Change) {
            if (!connected && change is Change.Removal) {
                // Out of reach, a put the peer never synced and its removal cancel out.
                val unsynced = waiting.filter { it is Change.Put && it.path == change.path }
                if (unsynced.isNotEmpty() && find(change.owner, change.path).isEmpty()) {
                    waiting.removeAll(unsynced)
                    return
                }
            }
            waiting.addLast(change)
            arrivals.trySend(Unit)
        }

        private fun apply(change: Change) {
            when (change) {
                is Change.Put -> {
                    put(change.item)
                    deliver(change.item)
                }
                is Change.Removal -> remove(change.owner, change.path)
            }
        }
    }

    private val connection = MutableStateFlow(true)

    /** Whether the two devices are connected to each other. */
    val connected: Boolean get() = connection.value

    /** Whether the phone app is installed, and so advertises its capability. */
    var phoneApp = true

    /** How long the Data Layer lets a request from the watch wait for its reply; null for no limit. */
    var requestTimeout: Duration? = null

    /** The phone takes a request from the watch, and its reply never makes it back. */
    var losesReplies = false

    /** Messages from the phone to the watch are accepted and never arrive. */
    var losesMessagesToWatch = false

    /** How long the watch takes to answer a request, on top of the link's own latency. */
    var watchReplyDelay: Duration = Duration.ZERO

    /** The running phone app's relay, null between one process and the next. */
    var relay: WearRelay? = null

    var watch: WatchCore? = null

    /** Every item the phone app was handed, in order, as it was handed it. */
    val deliveredToPhone = mutableListOf<WearItem>()

    /** Every message the phone sent the watch, in order. */
    val sentToWatch = mutableListOf<Pair<String, WearMessage>>()

    private val onPhone = Replica { item ->
        // The phone app's listener is registered for recordings and queued relays only.
        val listened = WearDataLayer.recordingRef(item.path) != null || WearDataLayer.queuedRef(item.path) != null
        if (listened) {
            val delivered = wearItem(item)
            deliveredToPhone += delivered
            relay?.onItem(delivered)
        }
    }

    private val onWatch = Replica { item ->
        // The watch app's listener acts on the gate alone.
        if (item.path == WearDataLayer.GATE_PATH) {
            (WearCodec.decode(item.payload) as? DictationGate)?.let { watch?.gatePublished(it) }
        }
    }

    /** The devices come into reach of each other: both apps hear the other's capability appear. */
    fun connect() {
        if (connected) return
        connection.value = true
        scope.launch {
            delay(LATENCY)
            watch?.linkChanged()
            relay?.onWatchConnected()
        }
    }

    /** The devices go out of reach: the watch hears the phone's capability disappear. */
    fun disconnect() {
        if (!connected) return
        connection.value = false
        scope.launch { watch?.linkChanged() }
    }

    /** The paths of every DataItem either node still holds, apart from the gate, which is meant to stay. */
    fun leftovers(): Set<String> =
        (onPhone.items.values + onWatch.items.values).map { it.path }.filter { it != WearDataLayer.GATE_PATH }.toSet()

    /** The gate as the watch's replica holds it. */
    fun gateOnWatch(): DictationGate? =
        onWatch.find(null, WearDataLayer.GATE_PATH).firstOrNull()?.let { WearCodec.decode(it.payload) } as? DictationGate

    private fun wearItem(item: Item): WearItem {
        val copy: (suspend (File) -> Boolean)? = item.audio?.let { bytes ->
            { target ->
                target.writeBytes(bytes)
                true
            }
        }
        return WearItem(item.path, item.owner, WearCodec.decode(item.payload), copy)
    }

    /** The Data Layer as the watch logic uses it. */
    val watchLink: PhoneLink = object : PhoneLink {
        override suspend fun phoneReachable(): Boolean = connected && phoneApp

        override suspend fun phoneAppInstalled(): Boolean = phoneApp

        override suspend fun request(path: String, payload: ByteArray): LinkReply {
            val phone = relay
            if (!connected || !phoneApp || phone == null) return LinkReply.Unreachable(phoneCannotReceive = !phoneApp)
            val limit = requestTimeout ?: return LinkReply.Reply(exchange(phone, path, payload))
            return withTimeoutOrNull(limit) { exchange(phone, path, payload) }?.let { LinkReply.Reply(it) }
                ?: LinkReply.TimedOut()
        }

        private suspend fun exchange(phone: WearRelay, path: String, payload: ByteArray): ByteArray {
            delay(LATENCY)
            val reply = phone.onRequest(WATCH, path, payload) ?: EMPTY
            delay(LATENCY)
            if (losesReplies || !connected) awaitCancellation()
            return reply
        }

        override suspend fun send(path: String, payload: ByteArray): Boolean {
            if (!connected || !phoneApp) return false
            scope.launch {
                delay(LATENCY)
                relay?.onMessage(path, payload)
            }
            return true
        }

        override suspend fun putItem(path: String, payload: ByteArray, audio: File?): Boolean {
            val item = Item(WATCH, path, payload, audio?.readBytes())
            // An item put again unchanged is no change, and syncs nothing.
            if (onWatch.find(WATCH, path).firstOrNull()?.holdsWhat(item) == true) return true
            onWatch.put(item)
            onPhone.incoming(Change.Put(item))
            return true
        }

        override suspend fun deleteItem(path: String) {
            if (onWatch.remove(null, path)) onPhone.incoming(Change.Removal(null, path))
        }

        override suspend fun items(prefix: String): List<LinkItem> =
            onWatch.items.values.filter { it.path.startsWith(prefix) }.map { LinkItem(it.path, it.payload) }

        override suspend fun gate(): DictationGate? = gateOnWatch()
    }

    /** The Data Layer as the phone relay uses it. */
    val phoneGateway: WearGateway = object : WearGateway {
        override suspend fun available(): Boolean = true

        override suspend fun sendMessage(nodeId: String, path: String, message: WearMessage) {
            reach(nodeId)
            sentToWatch += path to message
            if (losesMessagesToWatch) return
            val payload = WearCodec.encode(message)
            scope.launch {
                delay(LATENCY)
                if (connected) watch?.received(path, payload, isRequest = false)
            }
        }

        override suspend fun sendRequest(nodeId: String, path: String, message: WearMessage): WearMessage? {
            reach(nodeId)
            sentToWatch += path to message
            delay(LATENCY)
            val reply = watch?.received(path, WearCodec.encode(message), isRequest = true)
            delay(watchReplyDelay + LATENCY)
            reach(nodeId)
            return reply?.let(WearCodec::decode)
        }

        override suspend fun putItem(path: String, message: WearMessage) {
            val item = Item(PHONE, path, WearCodec.encode(message), null)
            if (onPhone.find(PHONE, path).firstOrNull()?.holdsWhat(item) == true) return
            onPhone.put(item)
            onWatch.incoming(Change.Put(item))
        }

        override suspend fun deleteItem(path: String, sourceNodeId: String?) {
            if (onPhone.remove(sourceNodeId, path)) onWatch.incoming(Change.Removal(sourceNodeId, path))
        }

        override suspend fun items(pathPrefix: String): List<WearItem> =
            onPhone.items.values.filter { it.path.startsWith(pathPrefix) }.map(::wearItem)

        override suspend fun watchNodes(): List<WearNode> = connectedNodes()

        override suspend fun connectedNodes(): List<WearNode> =
            if (connected) listOf(WearNode(WATCH, "Pixel Watch")) else emptyList()

        private fun reach(nodeId: String) {
            if (!connected || nodeId != WATCH) throw IOException("node $nodeId is not connected")
        }
    }

    companion object {
        const val PHONE = "phone-node"
        const val WATCH = "watch-node"

        /** How long anything takes to cross from one device to the other. */
        val LATENCY: Duration = 40.milliseconds

        private val EMPTY = ByteArray(0)
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.WearMessage
import java.io.File
import kotlinx.coroutines.CancellationException

/** A device on the Wearable Data Layer, as the relay addresses it. */
data class WearNode(val id: String, val displayName: String)

/**
 * One DataItem a watch put: a recording, or a relay it could not deliver live.
 * [payload] is null when the item's bytes are not a message this build reads.
 */
class WearItem(
    val path: String,
    /** The node that put the item, which is where anything about it is sent. */
    val sourceNodeId: String?,
    val payload: WearMessage?,
    /**
     * Copies the item's audio into a file, returning false when it could not be
     * copied whole. Null for an item that carries no audio.
     */
    val audio: (suspend (File) -> Boolean)? = null,
)

/** Whether a watch can use the relay, as the phone's settings report it. */
sealed interface WatchLink {
    /** No watch is connected to this phone. */
    data object NoWatch : WatchLink

    /** A watch is connected, without the Omnesis watch app. */
    data class AppMissing(val watchName: String) : WatchLink

    /** A connected watch runs the Omnesis watch app. */
    data class Connected(val watchName: String) : WatchLink
}

/**
 * The Wearable Data Layer as the relay uses it. Every call fails by throwing:
 * a peer out of reach, a Data Layer that is not there. Callers decide what a
 * failure costs; none of them may let it end the relay.
 */
interface WearGateway {
    /** Whether this phone has a Data Layer to speak through at all. */
    suspend fun available(): Boolean

    /** Sends [message] to a connected node, expecting no reply. */
    suspend fun sendMessage(nodeId: String, path: String, message: WearMessage)

    /** Sends [message] as a request and returns the node's reply, null when it is unreadable. */
    suspend fun sendRequest(nodeId: String, path: String, message: WearMessage): WearMessage?

    /** Puts a DataItem holding [message], synced to every node whenever it next connects. */
    suspend fun putItem(path: String, message: WearMessage)

    /** Deletes the DataItem at [path] that [sourceNodeId] put, or every node's when null. */
    suspend fun deleteItem(path: String, sourceNodeId: String?)

    /** Every DataItem whose path starts with [pathPrefix], whichever node put it. */
    suspend fun items(pathPrefix: String): List<WearItem>

    /** The connected nodes that run the Omnesis watch app. */
    suspend fun watchNodes(): List<WearNode>

    /** Every connected node, with or without the watch app. */
    suspend fun connectedNodes(): List<WearNode>
}

/** What the phone's settings say about the watch. */
suspend fun WearGateway.watchLink(): WatchLink {
    watchNodes().firstOrNull()?.let { return WatchLink.Connected(it.displayName) }
    return connectedNodes().firstOrNull()?.let { WatchLink.AppMissing(it.displayName) } ?: WatchLink.NoWatch
}

/**
 * Runs a step whose failure the relay survives: the result, or null when it
 * threw. Cancellation is never swallowed.
 */
internal suspend fun <T> attempt(block: suspend () -> T): T? = try {
    block()
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    null
}

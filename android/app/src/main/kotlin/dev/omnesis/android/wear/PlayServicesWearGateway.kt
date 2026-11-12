// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.content.Context
import android.net.Uri
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.Asset
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearMessage
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

/** [WearGateway] on Google Play services' Wearable Data Layer. */
class PlayServicesWearGateway(private val context: Context) : WearGateway {
    private val messages get() = Wearable.getMessageClient(context)
    private val data get() = Wearable.getDataClient(context)
    private val capabilities get() = Wearable.getCapabilityClient(context)
    private val nodes get() = Wearable.getNodeClient(context)

    @Volatile
    private var knownAvailable = false

    /**
     * Whether Play services offers the Wearable API here. A phone without Play
     * services, or without its wearable module, has none; that is checked again
     * on each call until it changes, and remembered once it holds.
     */
    override suspend fun available(): Boolean {
        if (knownAvailable) return true
        val available = attempt {
            val playServices = GoogleApiAvailability.getInstance()
            // Asked first because it answers from the package manager alone: a phone without
            // Play services is never asked to connect to it.
            playServices.isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS &&
                run {
                    playServices.checkApiAvailability(data).await()
                    true
                }
        } == true
        knownAvailable = available
        return available
    }

    override suspend fun sendMessage(nodeId: String, path: String, message: WearMessage) {
        messages.sendMessage(nodeId, path, WearCodec.encode(message)).await()
    }

    override suspend fun sendRequest(nodeId: String, path: String, message: WearMessage): WearMessage? =
        messages.sendRequest(nodeId, path, WearCodec.encode(message)).await()?.let(WearCodec::decode)

    override suspend fun putItem(path: String, message: WearMessage) {
        val request = PutDataMapRequest.create(path).apply {
            dataMap.putByteArray(WearDataLayer.PAYLOAD_KEY, WearCodec.encode(message))
        }.asPutDataRequest().setUrgent()
        data.putDataItem(request).await()
    }

    override suspend fun deleteItem(path: String, sourceNodeId: String?) {
        data.deleteDataItems(itemUri(path, sourceNodeId), DataClient.FILTER_LITERAL).await()
    }

    override suspend fun items(pathPrefix: String): List<WearItem> {
        val buffer = data.getDataItems(itemUri(pathPrefix, null), DataClient.FILTER_PREFIX).await()
        return try {
            buffer.map { wearItem(it.freeze()) }
        } finally {
            buffer.release()
        }
    }

    override suspend fun watchNodes(): List<WearNode> =
        capabilities.getCapability(WearDataLayer.WATCH_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
            .await().nodes.map(::wearNode)

    override suspend fun connectedNodes(): List<WearNode> = nodes.connectedNodes.await().map(::wearNode)

    /**
     * [item] as the relay reads it. [item] must be frozen: its audio is copied
     * after the event that carried it. An item whose data cannot be read as a
     * DataMap comes back with no payload and no audio, which the relay treats
     * as something it can never process; one bad item must not end the
     * callback or the listing that carried it.
     */
    fun wearItem(item: DataItem): WearItem {
        val path = item.uri.path.orEmpty()
        val source = item.uri.host?.takeIf { it.isNotEmpty() && it != ANY_NODE }
        val map = try {
            DataMapItem.fromDataItem(item).dataMap
        } catch (_: IllegalStateException) {
            return WearItem(path, source, payload = null)
        } catch (_: IllegalArgumentException) {
            return WearItem(path, source, payload = null)
        }
        val asset = map.getAsset(WearDataLayer.AUDIO_KEY)
        val copy: (suspend (File) -> Boolean)? = if (asset == null) null else { target -> copyAsset(asset, target) }
        return WearItem(path, source, map.getByteArray(WearDataLayer.PAYLOAD_KEY)?.let(WearCodec::decode), copy)
    }

    private suspend fun copyAsset(asset: Asset, target: File): Boolean {
        val response = data.getFdForAsset(asset).await()
        return try {
            withContext(Dispatchers.IO) {
                response.inputStream.use { input -> target.outputStream().use { input.copyTo(it) } }
            }
            true
        } finally {
            response.release()
        }
    }

    private fun wearNode(node: Node) = WearNode(node.id, node.displayName)

    private fun itemUri(path: String, nodeId: String?): Uri = Uri.Builder()
        .scheme(PutDataRequest.WEAR_URI_SCHEME)
        .authority(nodeId ?: ANY_NODE)
        .path(path)
        .build()

    private companion object {
        /** The host that addresses every node's items. */
        const val ANY_NODE = "*"
    }
}

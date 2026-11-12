// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.link

import android.content.Context
import android.net.Uri
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.wearable.Asset
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableStatusCodes
import dev.omnesis.android.wear.core.LinkItem
import dev.omnesis.android.wear.core.LinkReply
import dev.omnesis.android.wear.core.PhoneLink
import dev.omnesis.android.wear.core.WatchLog
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/** [PhoneLink] over Google Play services' Wearable Data Layer. */
class GmsPhoneLink(context: Context, private val log: WatchLog) : PhoneLink {
    private val messages = Wearable.getMessageClient(context)
    private val data = Wearable.getDataClient(context)
    private val capabilities = Wearable.getCapabilityClient(context)

    override suspend fun phoneReachable(): Boolean = phoneNodes(CapabilityClient.FILTER_REACHABLE).isNotEmpty()

    override suspend fun phoneAppInstalled(): Boolean = phoneNodes(CapabilityClient.FILTER_ALL).isNotEmpty()

    override suspend fun request(path: String, payload: ByteArray): LinkReply {
        val node = try {
            nearest(queryPhoneNodes(CapabilityClient.FILTER_REACHABLE))
                ?: return LinkReply.Unreachable(phoneCannotReceive = !phoneAppInstalled())
        } catch (error: ApiException) {
            return LinkReply.LinkDown(error.statusCode)
        }
        return try {
            LinkReply.Reply(messages.sendRequest(node.id, path, payload).await())
        } catch (error: ApiException) {
            when (error.statusCode) {
                WearableStatusCodes.TARGET_NODE_NOT_CONNECTED ->
                    LinkReply.Unreachable(phoneCannotReceive = false, code = error.statusCode)
                CommonStatusCodes.TIMEOUT -> LinkReply.TimedOut(error.statusCode)
                CommonStatusCodes.API_NOT_CONNECTED, ConnectionResult.API_UNAVAILABLE ->
                    LinkReply.LinkDown(error.statusCode)
                else -> LinkReply.Failed(error.statusCode)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: RuntimeException) {
            log.error("Data Layer request $path failed: ${error.javaClass.simpleName}")
            LinkReply.Failed()
        }
    }

    override suspend fun send(path: String, payload: ByteArray): Boolean = attempt("send $path", false) {
        val node = nearest(queryPhoneNodes(CapabilityClient.FILTER_REACHABLE)) ?: return@attempt false
        messages.sendMessage(node.id, path, payload).await()
        true
    }

    override suspend fun putItem(path: String, payload: ByteArray, audio: File?): Boolean =
        attempt("put $path", false) {
            val request = PutDataMapRequest.create(path)
            request.dataMap.putByteArray(WearDataLayer.PAYLOAD_KEY, payload)
            if (audio != null) {
                val bytes = withContext(Dispatchers.IO) { audio.readBytes() }
                request.dataMap.putAsset(WearDataLayer.AUDIO_KEY, Asset.createFromBytes(bytes))
            }
            data.putDataItem(request.asPutDataRequest().setUrgent()).await()
            true
        }

    override suspend fun deleteItem(path: String) {
        attempt("delete $path", Unit) {
            data.deleteDataItems(itemUri(path), DataClient.FILTER_LITERAL).await()
            Unit
        }
    }

    override suspend fun items(prefix: String): List<LinkItem> = attempt("list $prefix", emptyList()) {
        val buffer = data.getDataItems(itemUri(prefix), DataClient.FILTER_PREFIX).await()
        try {
            buffer.mapNotNull { item ->
                val path = item.uri.path ?: return@mapNotNull null
                LinkItem(path, DataMapItem.fromDataItem(item).dataMap.getByteArray(WearDataLayer.PAYLOAD_KEY))
            }
        } finally {
            buffer.release()
        }
    }

    override suspend fun gate(): DictationGate? =
        items(WearDataLayer.GATE_PATH).firstOrNull { it.path == WearDataLayer.GATE_PATH }
            ?.payload?.let(WearCodec::decode) as? DictationGate

    private suspend fun phoneNodes(filter: Int): Set<Node> = attempt("capability", emptySet()) { queryPhoneNodes(filter) }

    private suspend fun queryPhoneNodes(filter: Int): Set<Node> =
        capabilities.getCapability(WearDataLayer.PHONE_CAPABILITY, filter).await().nodes

    private fun nearest(nodes: Set<Node>): Node? = nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull()

    /** A DataItem address on any node: the watch's own items, and the gate the phone puts. */
    private fun itemUri(path: String): Uri = Uri.Builder().scheme("wear").authority("*").path(path).build()

    /**
     * Run a Data Layer call, giving [fallback] when it fails: Play services
     * reported an error, or a recording could not be read.
     */
    private suspend fun <T> attempt(what: String, fallback: T, call: suspend () -> T): T = try {
        call()
    } catch (error: CancellationException) {
        throw error
    } catch (error: ApiException) {
        log.error("Data Layer $what failed with status ${error.statusCode}")
        fallback
    } catch (error: IOException) {
        log.error("Data Layer $what failed: ${error.javaClass.simpleName}")
        fallback
    } catch (error: RuntimeException) {
        log.error("Data Layer $what failed: ${error.javaClass.simpleName}")
        fallback
    }
}

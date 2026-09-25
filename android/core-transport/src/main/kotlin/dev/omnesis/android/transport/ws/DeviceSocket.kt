// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.ws

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.DeviceCapabilities
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import kotlin.random.Random

/**
 * Device WebSocket (`/device/ws`). Faithful port of the iOS `DeviceSocket`:
 * `hello` handshake (protocolVersion 1), `kind`-discriminated envelopes, ping-drop,
 * mandatory acks to inbound commands, and exponential-backoff reconnect with jitter.
 * The agent transcript streams over SSE, not this socket — the socket carries
 * presence + live status events.
 */
class DeviceSocket(
    private val client: OkHttpClient,
    private val gatewayUrl: String,
    private val token: String,
    private val scope: CoroutineScope,
    private val capabilities: DeviceCapabilities = DeviceCapabilities.android(emptyList()),
) {
    sealed interface ConnectionState {
        data object Disconnected : ConnectionState
        data object Connecting : ConnectionState
        data object Authenticating : ConnectionState
        data class Connected(
            val deviceId: String,
            val deviceName: String,
            val scopes: List<String>,
        ) : ConnectionState

        data class Failed(val message: String) : ConnectionState
    }

    data class WsEvent(val type: String, val payload: JsonObject)

    /** A gateway-originated command frame (`{kind:"command", id, type, payload}`). */
    data class WsCommand(val id: String, val type: String, val payload: JsonObject)

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<WsEvent> = _events.asSharedFlow()

    private val _commands = MutableSharedFlow<WsCommand>(extraBufferCapacity = 64)

    /**
     * Inbound gateway commands (source.sync, source.debug, …), emitted before the
     * mandatory generic ack goes back. Handlers run their action asynchronously —
     * the gateway treats the ack as "received", not "done".
     */
    val commands: SharedFlow<WsCommand> = _commands.asSharedFlow()

    /**
     * Starts a sync for one source, reporting whether a feature actually took
     * it on. Set by the session before `start()`, once the feature coordinators
     * exist; null means this build hosts nothing.
     *
     * The answer becomes the `source.sync` acknowledgement. It has to come from
     * the dispatch itself rather than a list of hosted types: the gateway turns
     * a negative ack into a 502 the operator can read, so anything short of
     * "a feature is now syncing" would report success for work that never runs
     * — a disabled feature, an id no integration matches, or a dropped
     * emission all look identical from a static allow-list.
     */
    @Volatile
    var dispatchSync: ((String) -> Boolean)? = null

    private var loop: Job? = null
    private var helloId: String? = null
    private var attempt = 0
    private val lifecycleLock = Any()
    private var connectionGeneration = 0L

    @Volatile
    private var activeWs: WebSocket? = null

    fun start() {
        val job = synchronized(lifecycleLock) {
            if (loop != null) return
            scope.launch(start = CoroutineStart.LAZY) {
                while (isActive) {
                    val ended = CompletableDeferred<Unit>()
                    val request = Request.Builder()
                        .url(wsUrl())
                        .header("Authorization", "Bearer $token")
                        .build()
                    val generation = synchronized(lifecycleLock) {
                        if (loop?.isActive != true) return@launch
                        connectionGeneration += 1
                        activeWs = null
                        _state.value = ConnectionState.Connecting
                        connectionGeneration
                    }
                    val ws = client.newWebSocket(request, listener(ended, generation))
                    val accepted = synchronized(lifecycleLock) {
                        if (connectionGeneration == generation && loop?.isActive == true) {
                            activeWs = ws
                            true
                        } else {
                            false
                        }
                    }
                    if (!accepted) {
                        ws.cancel()
                        break
                    }

                    val handshakeTimeout = launch {
                        delay(HANDSHAKE_TIMEOUT_MS)
                        if (_state.value !is ConnectionState.Connected) ws.cancel()
                    }
                    ended.await()
                    handshakeTimeout.cancel()
                    if (!isActive) break

                    val backoff = backoffDelayMs(attempt)
                    attempt += 1
                    if (_state.value !is ConnectionState.Failed) {
                        _state.value = ConnectionState.Disconnected
                    }
                    delay(backoff)
                }
            }.also { loop = it }
        }
        job.start()
    }

    fun stop() {
        val (job, ws, wasConnected) = synchronized(lifecycleLock) {
            connectionGeneration += 1
            val stoppedJob = loop
            loop = null
            val stoppedWs = activeWs
            val stoppedWhileConnected = _state.value is ConnectionState.Connected
            activeWs = null
            _state.value = ConnectionState.Disconnected
            Triple(stoppedJob, stoppedWs, stoppedWhileConnected)
        }
        job?.cancel()
        if (wasConnected) {
            ws?.close(1000, "client stopped")
        } else {
            ws?.cancel()
        }
    }

    /**
     * Sends a `{kind:"event", type, payload}` frame — the device→gateway event
     * channel (sync.status, …), mirroring the iOS `emitEvent`. Returns false and
     * sends nothing unless the socket is authenticated.
     */
    fun sendEvent(type: String, payload: JsonObject): Boolean {
        val ws = synchronized(lifecycleLock) {
            activeWs?.takeIf { _state.value is ConnectionState.Connected }
        } ?: return false
        val frame = buildJsonObject {
            put("kind", "event")
            put("type", type)
            put("payload", payload)
        }
        return ws.send(OmnesisJson.encodeToString(JsonObject.serializer(), frame))
    }

    private fun listener(
        ended: CompletableDeferred<Unit>,
        generation: Long,
    ) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            // The callback may beat newWebSocket() returning, or arrive after
            // stop() cancelled this generation. The generation guard handles
            // both orderings without accepting a stale socket.
            val accepted = synchronized(lifecycleLock) {
                if (connectionGeneration == generation && loop?.isActive == true) {
                    activeWs = webSocket
                    _state.value = ConnectionState.Authenticating
                    true
                } else {
                    false
                }
            }
            if (!accepted) {
                webSocket.cancel()
                return
            }
            val id = UUID.randomUUID().toString()
            helloId = id
            val hello = buildJsonObject {
                put("kind", "command")
                put("id", id)
                put("type", "hello")
                putJsonObject("payload") {
                    put("capabilities", OmnesisJson.encodeToJsonElement(DeviceCapabilities.serializer(), capabilities))
                    put("protocolVersion", PROTOCOL_VERSION)
                }
            }
            webSocket.send(OmnesisJson.encodeToString(JsonObject.serializer(), hello))
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val current = synchronized(lifecycleLock) {
                connectionGeneration == generation && activeWs === webSocket
            }
            if (current) handleFrame(webSocket, text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            synchronized(lifecycleLock) {
                if (connectionGeneration == generation && activeWs === webSocket) activeWs = null
            }
            if (!ended.isCompleted) ended.complete(Unit)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            synchronized(lifecycleLock) {
                if (connectionGeneration == generation && activeWs === webSocket) {
                    activeWs = null
                    _state.value = ConnectionState.Failed(t.message ?: "websocket failure")
                }
            }
            if (!ended.isCompleted) ended.complete(Unit)
        }
    }

    private fun handleFrame(webSocket: WebSocket, text: String) {
        val obj = runCatching { OmnesisJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (obj["kind"]?.jsonPrimitive?.contentOrNull) {
            "response" -> {
                if (obj["correlationId"]?.jsonPrimitive?.contentOrNull != helloId) return
                val ok = obj["ok"]?.jsonPrimitive?.booleanOrNull ?: false
                if (ok) {
                    val result = obj["result"]?.jsonObject
                    synchronized(lifecycleLock) {
                        if (activeWs !== webSocket) return
                        attempt = 0
                        _state.value = ConnectionState.Connected(
                            deviceId = result?.get("deviceId")?.jsonPrimitive?.contentOrNull.orEmpty(),
                            deviceName = result?.get("deviceName")?.jsonPrimitive?.contentOrNull.orEmpty(),
                            scopes = result?.get("scopes")?.jsonArray
                                ?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
                        )
                    }
                } else {
                    val msg = obj["error"]?.jsonObject?.get("message")
                        ?.jsonPrimitive?.contentOrNull ?: "authentication failed"
                    synchronized(lifecycleLock) {
                        if (activeWs !== webSocket) return
                        _state.value = ConnectionState.Failed(msg)
                    }
                    webSocket.cancel()
                }
            }

            "event" -> {
                val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return
                if (type == "ping") return
                _events.tryEmit(WsEvent(type, obj["payload"]?.jsonObject ?: JsonObject(emptyMap())))
            }

            "command" -> {
                val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return
                val type = obj["type"]?.jsonPrimitive?.contentOrNull
                val payload = obj["payload"]?.jsonObject ?: JsonObject(emptyMap())
                if (type != null) _commands.tryEmit(WsCommand(id, type, payload))
                // Replying is mandatory — the gateway's sendCommand blocks ~30s otherwise.
                webSocket.send(
                    OmnesisJson.encodeToString(JsonObject.serializer(), commandReply(id, type, payload)),
                )
            }
        }
    }

    /**
     * Build the response envelope for a gateway-originated command.
     *
     * The gateway validates a successful response's `result` against that
     * command's schema in `ws-messages.ts`, so an ack has to carry the fields
     * its command declares — an empty object reads as a protocol error rather
     * than as "done". A refusal travels as an error envelope instead, which
     * the gateway surfaces as a structured command error.
     */
    private fun commandReply(id: String, type: String?, payload: JsonObject): JsonObject {
        fun ok(result: JsonObject) = buildJsonObject {
            put("kind", "response")
            put("correlationId", id)
            put("ok", true)
            put("result", result)
        }
        fun refuse(code: String, message: String) = buildJsonObject {
            put("kind", "response")
            put("correlationId", id)
            put("ok", false)
            putJsonObject("error") {
                put("code", code)
                put("message", message)
            }
        }

        return when (type) {
            "source.sync" -> {
                val sourceId = payload["sourceId"]?.jsonPrimitive?.contentOrNull
                when {
                    sourceId.isNullOrEmpty() ->
                        refuse("invalid_payload", "source.sync requires a sourceId")
                    dispatchSync?.invoke(sourceId) != true ->
                        refuse("not_hosted", "$sourceId is not syncing on this device")
                    // `triggered` counts syncs started, not finished: the
                    // feature handlers run async and a full cycle outruns the
                    // gateway's 30s command timeout.
                    else -> ok(buildJsonObject { put("ok", true); put("triggered", 1) })
                }
            }
            // The gateway owns the source registry and the app re-reads it on
            // reconnect, so this acks receipt without claiming to have applied
            // the delta. See #54.
            "source.added", "source.updated", "sources.snapshot" ->
                ok(buildJsonObject { put("ok", true); put("applied", false) })
            "source.removed" ->
                ok(buildJsonObject { put("ok", true); put("applied", false); putJsonArray("deleted") {} })
            "source.debug" -> ok(buildJsonObject { putJsonObject("status") {
                put("sourceId", payload["sourceId"]?.jsonPrimitive?.contentOrNull.orEmpty())
                put("note", "Live debug not yet implemented on Android — source is hosted here")
            } })
            else -> refuse("unsupported", "${type ?: "unknown"} is not handled on Android")
        }
    }

    private fun wsUrl(): String {
        // OkHttp upgrades an http(s) request to a WebSocket; keep the original scheme.
        val base = gatewayUrl.toHttpUrl()
        return base.newBuilder().addPathSegment("device").addPathSegment("ws").build().toString()
    }

    private fun backoffDelayMs(attempt: Int): Long {
        val base = minOf(1000L * (1L shl minOf(attempt, 5)), 30_000L)
        val jitter = Random.nextLong(0, (base / 4) + 1)
        return base + jitter
    }

    companion object {
        /**
         * Wire protocol version this client speaks. Must match the gateway's
         * `PROTOCOL_VERSION` exported from `@omnesis/core/ws-messages.ts`: a
         * hello carrying any other number is refused outright, so this is the
         * one version that can stop a paired phone connecting at all. Public
         * because the app reports it in Settings → About, where that refusal
         * is diagnosed.
         */
        const val PROTOCOL_VERSION = 1 // PARITY:device-ws-protocol-version

        private const val HANDSHAKE_TIMEOUT_MS = 30_000L
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.ws

import android.util.Log
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.routing.DirectGatewayRoute
import dev.omnesis.android.transport.routing.DirectGatewayProbe
import dev.omnesis.android.transport.routing.DirectGatewayProbing
import dev.omnesis.android.transport.routing.GatewayConnectionPath
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
import okhttp3.Request
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import kotlin.math.max
import kotlin.random.Random

/**
 * Device WebSocket (`/device/ws`). Faithful port of the iOS `DeviceSocket`:
 * `hello` handshake (protocolVersion 1), `kind`-discriminated envelopes, ping-drop,
 * mandatory acks to inbound commands. The agent transcript streams over SSE, not this
 * socket — the socket carries presence + live status events.
 *
 * It reconnects by itself for as long as it is started. The lifecycle contract:
 *
 * - A failed attempt waits out [DeviceSocketReconnectPolicy]'s backoff, and every attempt
 *   spends from its budget, whatever triggered it.
 * - Network-path changes and [appDidBecomeActive] are advisory wake signals: they shorten a
 *   pending wait or replace a stale attempt, but only the hello response counts as being
 *   connected. With cloud connectivity an open socket is asked to answer within
 *   [DeviceSocketReconnectLimits.probeTimeoutMs] and replaced if it does not, so a connection left
 *   on a network that is gone is noticed in seconds rather than by the client's ping interval.
 *   Without it an open socket is left alone.
 * - [ConnectionState.Reconnecting] is the temporary state; [ConnectionState.Failed] means
 *   retries continue but are unlikely to help until something else changes.
 * - Each attempt goes through the one [client], so a retry can never use a different
 *   transport, token or TLS trust than the pairing's.
 * - [stop] is terminal for the running loop: no later signal, timer or callback has any effect.
 */
class DeviceSocket(
    private val client: WebSocket.Factory,
    private val gatewayUrl: String,
    private val token: String,
    private val scope: CoroutineScope,
    private val capabilities: DeviceCapabilities = DeviceCapabilities.android(emptyList()),
    directRoute: DirectGatewayRoute? = null,
    private val directProbe: DirectGatewayProbing = DirectGatewayProbe,
    expectedDeviceId: String? = null,
    refreshHints: (suspend () -> Unit)? = null,
    private val webSockets: WebSocket.Factory = client,
    /** Off unless the build enables cloud connectivity. Off, routing, identity checks and the reworked lifecycle are unused. */
    private val cloudRelay: Boolean = false,
    private val pathObserver: NetworkPathObserver = NetworkPathObserver.None,
    /**
     * Told when the way to the gateway may have changed: the network changed, the home network
     * answered a check, or this socket connected on another path. The session uses it to let
     * its other clients find the right path again. Never called without cloud connectivity.
     */
    private val onRouteEvent: (RouteEvent) -> Unit = {},
    limits: DeviceSocketReconnectLimits = DeviceSocketReconnectLimits(),
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
    private val randomUnit: () -> Double = { Random.nextDouble() },
) {
    private val directRoute = directRoute.takeIf { cloudRelay }
    private val expectedDeviceId = expectedDeviceId.takeIf { cloudRelay }
    private val refreshHints = refreshHints.takeIf { cloudRelay }
    private val probeClient = client as? OkHttpClient
    init { require(this.directRoute == null || probeClient != null) { "direct probing requires the paired TLS client" } }

    enum class NetworkAvailability { UNKNOWN, AVAILABLE, UNAVAILABLE }

    enum class RouteEvent {
        /** The phone's network changed: every path is worth trying again. */
        NETWORK_CHANGED,

        /** A check reached the gateway on the home network. */
        HOME_REACHABLE,

        /** This socket connected on a different path than its last connection. */
        PATH_CHANGED,
    }

    enum class FailureKind { AUTHENTICATION, CERTIFICATE, INCOMPATIBLE }

    sealed interface ConnectionState {
        data object Disconnected : ConnectionState
        data object Connecting : ConnectionState
        data object Authenticating : ConnectionState
        data class Connected(
            val deviceId: String,
            val deviceName: String,
            val scopes: List<String>,
            val connectionPath: GatewayConnectionPath? = null,
        ) : ConnectionState

        /** No session is up and automatic retries are expected to restore one. */
        data class Reconnecting(
            val network: NetworkAvailability,
            /** The most recent attempt's failure, kept for diagnosis. */
            val lastError: String?,
            /** Failures while the network looked usable, since it last changed. */
            val failedAttemptsOnNetwork: Int,
        ) : ConnectionState

        /** No session is up and the gateway's answer points at something a retry is unlikely to change. */
        data class Failed(val kind: FailureKind, val message: String) : ConnectionState
    }

    /** What the run loop is doing, which decides what a wake signal means. */
    private enum class Phase { IDLE, ATTEMPTING, CONNECTED, WAITING }

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
    private var pathJob: Job? = null
    private var promotion: Job? = null
    /** The hello a build without cloud connectivity matches replies against. */
    private var sharedHelloId: String? = null
    private val lifecycleLock = Any()
    private var connectionGeneration = 0L
    private val policy = DeviceSocketReconnectPolicy(limits)
    private var phase = Phase.IDLE
    private var attemptStartedAtMs = 0L
    private var attemptEnded: CompletableDeferred<Unit>? = null

    /** The current attempt's outcome. Null when it was replaced, which says nothing about the gateway. */
    private var attemptFailure: DeviceSocketAttemptFailure? = null

    /** The next attempt should not wait out the backoff. */
    private var retryWithoutBackoff = false
    private var currentPath: NetworkPathSnapshot? = null
    private var isForeground = true

    /** A path was restored while backgrounded; the next foreground acts on it. */
    private var restoredWhileBackgrounded = false
    private var failedAttemptsOnNetwork = 0
    private var lastConnectionError: String? = null
    private val wakes = Channel<Unit>(Channel.CONFLATED)

    /** The liveness question an open socket has not answered yet, and the connection it was asked on. */
    private var probeId: String? = null
    private var probeGeneration = 0L
    private var probeTimer: Job? = null
    private var lastConnectedPath: GatewayConnectionPath? = null

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
                        attemptEnded = ended
                        attemptFailure = null
                        retryWithoutBackoff = false
                        phase = Phase.ATTEMPTING
                        attemptStartedAtMs = nowMs()
                        policy.recordAttemptStarted(attemptStartedAtMs)
                        publishAttemptProgress(ConnectionState.Connecting)
                        connectionGeneration
                    }
                    val ws = webSockets.newWebSocket(request, listener(ended, generation))
                    val accepted = synchronized(lifecycleLock) {
                        if (!cloudRelay) {
                            if (loop?.isActive != true) {
                                false
                            } else {
                                if (connectionGeneration == generation) activeWs = ws
                                true
                            }
                        } else if (loop?.isActive == true && connectionGeneration == generation && !ended.isCompleted) {
                            activeWs = ws
                            true
                        } else false
                    }
                    if (!accepted) {
                        ws.cancel()
                        if (!cloudRelay || !isActive) break
                        waitForNextAttempt()
                        continue
                    }

                    val handshakeTimeout = launch {
                        delay(HANDSHAKE_TIMEOUT_MS)
                        val timedOut = synchronized(lifecycleLock) {
                            val current = connectionGeneration == generation && phase == Phase.ATTEMPTING
                            if (current) endAttempt(DeviceSocketAttemptFailure.Network(HANDSHAKE_TIMEOUT_MESSAGE))
                            current
                        }
                        if (timedOut) ws.cancel()
                    }
                    if (!cloudRelay) {
                        ended.await()
                        handshakeTimeout.cancel()
                        // A replaced attempt may still be ending; its callbacks are already ignored.
                        ws.cancel()
                    } else try { ended.await() }
                    finally {
                        handshakeTimeout.cancel()
                        val cancel = synchronized(lifecycleLock) {
                            val current = connectionGeneration == generation
                            val owns = activeWs === ws
                            if (!isActive && current) {
                                activeWs = null
                                phase = Phase.IDLE
                                _state.value = ConnectionState.Disconnected
                            }
                            current && (owns || loop?.isActive == true)
                        }
                        if (cancel) ws.cancel()
                    }
                    if (!isActive) break
                    waitForNextAttempt()
                }
            }.also { loop = it }.also {
                pathJob = scope.launch {
                    pathObserver.paths()
                        // The signal is advisory: without it the backoff still reconnects.
                        .catch { error -> Log.w(LOG_TAG, "Network path updates stopped: $error") }
                        .collect { path -> handlePath(path) }
                }
            }
        }
        job.start()
        if (directRoute != null) synchronized(lifecycleLock) {
            if (loop !== job || !job.isActive) return
            promotion = scope.launch {
                while (isActive) {
                    delay(30_000)
                    try { refreshDirectPath() }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Rejected hints preserve current routes and trust. */ }
                }
            }
        }
    }

    fun stop() {
        val (job, ws, wasConnected) = synchronized(lifecycleLock) {
            promotion?.cancel()
            promotion = null
            connectionGeneration += 1
            val stoppedJob = loop
            loop = null
            pathJob?.cancel()
            pathJob = null
            val stoppedWs = activeWs
            val stoppedWhileConnected = _state.value is ConnectionState.Connected
            activeWs = null
            phase = Phase.IDLE
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
     * Replaces the transport: the open socket stopped answering, so the next attempt starts at
     * once and finds its own path. An unanswered liveness check ends here.
     */
    fun recoverAfterInterruption() {
        if (!cloudRelay) return
        val replaced = synchronized(lifecycleLock) {
            if (loop?.isActive != true || !policy.accepts(DeviceSocketReconnectPolicy.WakeSignal.FOREGROUND)) return
            replaceCurrentAttempt()
        }
        replaced?.cancel()
    }

    /** Called under lifecycleLock; the reconnect loop remains the only attempt/budget owner. */
    private fun replaceCurrentAttempt(): WebSocket? {
        connectionGeneration += 1
        attemptFailure = null
        retryWithoutBackoff = true
        phase = Phase.IDLE
        _state.value = ConnectionState.Connecting
        val previous = activeWs
        activeWs = null
        attemptEnded?.complete(Unit)
        wakes.trySend(Unit)
        return previous
    }

    /** A verified LAN path replaces only this socket and spends the normal attempt budget. */
    suspend fun promoteDirectPath() {
        if (!cloudRelay) return
        val before = synchronized(lifecycleLock) {
            val connected = _state.value as? ConnectionState.Connected ?: return
            if (loop?.isActive != true || phase != Phase.CONNECTED) return
            connected to connectionGeneration
        }
        val route = directRoute ?: return
        val trusted = probeClient ?: return
        if (before.first.connectionPath != GatewayConnectionPath.RELAY || !directProbe.reachable(route, trusted)) return
        // The device is home again: new connections try the home network first from now on.
        route.hintsMayBeReachable()
        onRouteEvent(RouteEvent.HOME_REACHABLE)
        val replaced = synchronized(lifecycleLock) {
            if (connectionGeneration != before.second || _state.value != before.first ||
                phase != Phase.CONNECTED || loop?.isActive != true) return
            replaceCurrentAttempt()
        }
        replaced?.cancel()
    }

    suspend fun refreshDirectPath() {
        if (!cloudRelay) return
        synchronized(lifecycleLock) { if (loop?.isActive != true) return }
        refreshHints?.invoke()
        promoteDirectPath()
    }

    /** The user returned to the app, so a retry parked on a long backoff should not make them wait. */
    fun appDidBecomeActive() {
        val restored = synchronized(lifecycleLock) {
            isForeground = true
            restoredWhileBackgrounded.also { restoredWhileBackgrounded = false }
        }
        if (restored) wake(DeviceSocketReconnectPolicy.WakeSignal.CONNECTIVITY_RESTORED)
        wake(DeviceSocketReconnectPolicy.WakeSignal.FOREGROUND)
    }

    /**
     * Path changes wait for the next foreground from here on: nobody is looking at the connection,
     * and the backoff schedule keeps running regardless.
     */
    fun appDidEnterBackground() {
        synchronized(lifecycleLock) { isForeground = false }
    }

    /** Waits for the backoff and the budget, whichever is later. A wake can shorten only the backoff. */
    private suspend fun waitForNextAttempt() {
        val backoff = synchronized(lifecycleLock) {
            if (loop?.isActive != true) return
            attemptEnded = null
            attemptFailure?.let { failure ->
                policy.recordFailure(failure)
                record(failure)
            }
            val superseded = attemptFailure == null
            // A refusal keeps its earned wait even if a wake arrived mid-attempt.
            val skipsBackoff = superseded ||
                (retryWithoutBackoff && policy.accepts(DeviceSocketReconnectPolicy.WakeSignal.CONNECTIVITY_RESTORED))
            val earned = if (skipsBackoff) 0 else policy.retryDelayMs(randomUnit())
            wakes.tryReceive()
            phase = Phase.WAITING
            earned
        }
        var deadline = nowMs() + max(backoff, synchronized(lifecycleLock) { policy.budgetDelayMs(nowMs()) })
        while (true) {
            val remaining = deadline - nowMs()
            if (remaining <= 0) return
            withTimeoutOrNull(remaining) { wakes.receive() } ?: return
            deadline = minOf(deadline, nowMs() + synchronized(lifecycleLock) { policy.budgetDelayMs(nowMs()) })
        }
    }

    private fun handlePath(path: NetworkPathSnapshot) {
        var changed = false
        val restored = synchronized(lifecycleLock) {
            if (loop == null) return
            val transition = path.transitionFrom(currentPath)
            currentPath = path
            // A connected socket stays as it is on LOST: only the socket itself can say the
            // session ended, and a brief loss may not end it.
            if (_state.value is ConnectionState.Reconnecting) publishReconnecting()
            if (transition != NetworkPathSnapshot.Transition.RESTORED) {
                changed = cloudRelay && transition != NetworkPathSnapshot.Transition.UNCHANGED
                false
            } else {
                changed = cloudRelay
                if (!isForeground) restoredWhileBackgrounded = true
                isForeground
            }
        }
        if (changed) {
            // What was out of reach on the old network says nothing about this one.
            directRoute?.hintsMayBeReachable()
            onRouteEvent(RouteEvent.NETWORK_CHANGED)
        }
        if (restored) wake(DeviceSocketReconnectPolicy.WakeSignal.CONNECTIVITY_RESTORED)
    }

    /**
     * Asks an open socket to answer. The gateway answers every command with a response that
     * carries its id, whatever the command, so any response to this one proves the connection
     * still carries traffic both ways. One question at a time per connection.
     */
    private fun probeOpenSocket() {
        val (ws, id, generation) = synchronized(lifecycleLock) {
            if (!cloudRelay || loop?.isActive != true || phase != Phase.CONNECTED) return
            if (probeId != null && probeGeneration == connectionGeneration) return
            val ws = activeWs ?: return
            val id = UUID.randomUUID().toString()
            probeId = id
            probeGeneration = connectionGeneration
            Triple(ws, id, connectionGeneration)
        }
        val frame = buildJsonObject {
            put("kind", "command")
            put("id", id)
            put("type", "ping")
            putJsonObject("payload") {}
        }
        val sent = ws.send(OmnesisJson.encodeToString(JsonObject.serializer(), frame))
        val timer = scope.launch {
            if (sent) delay(policy.limits.probeTimeoutMs)
            val unanswered = synchronized(lifecycleLock) {
                val current = probeId == id && connectionGeneration == generation
                if (current) probeId = null
                current
            }
            if (unanswered) recoverAfterInterruption()
        }
        synchronized(lifecycleLock) {
            if (probeId == id) probeTimer = timer else timer.cancel()
        }
    }

    /** Called under lifecycleLock when a response names the pending liveness question. */
    private fun probeAnswered() {
        probeId = null
        probeTimer?.cancel()
        probeTimer = null
    }

    private fun wake(signal: DeviceSocketReconnectPolicy.WakeSignal) {
        if (cloudRelay && synchronized(lifecycleLock) { loop != null && phase == Phase.CONNECTED }) {
            probeOpenSocket()
            return
        }
        val stale = synchronized(lifecycleLock) {
            if (loop == null || phase == Phase.CONNECTED || !policy.accepts(signal)) return
            if (signal == DeviceSocketReconnectPolicy.WakeSignal.CONNECTIVITY_RESTORED) {
                policy.connectivityRestored()
                failedAttemptsOnNetwork = 0
                if (_state.value is ConnectionState.Reconnecting) publishReconnecting()
            }
            when (phase) {
                Phase.WAITING -> {
                    wakes.trySend(Unit)
                    null
                }

                Phase.ATTEMPTING -> {
                    // The attempt may have started on the network that is now gone, or just
                    // ahead of this signal as a backoff fell due on resume.
                    retryWithoutBackoff = true
                    if (nowMs() - attemptStartedAtMs >= policy.limits.supersedeInFlightAfterMs) {
                        attemptFailure = null
                        connectionGeneration += 1
                        val replaced = activeWs
                        activeWs = null
                        attemptEnded?.complete(Unit)
                        replaced
                    } else {
                        null
                    }
                }

                // The attempt has ended and the run loop is about to read its outcome.
                else -> {
                    retryWithoutBackoff = true
                    null
                }
            }
        }
        stale?.cancel()
    }

    /**
     * Records why the connection is over. The first reason wins: a timeout or a hello refusal
     * cancels the socket after naming itself, and that cancellation then calls back. Leaving
     * [Phase.ATTEMPTING] here keeps a wake from replacing an attempt whose outcome is known.
     */
    private fun endAttempt(failure: DeviceSocketAttemptFailure) {
        attemptFailure = attemptFailure ?: failure
        phase = Phase.IDLE
    }

    /**
     * A first connection shows its progress. After a failure the state keeps saying what is wrong
     * through each retry, so the UI does not flicker back to "connecting" every time one starts.
     */
    private fun publishAttemptProgress(state: ConnectionState) {
        if (policy.lastFailure == null) _state.value = state
    }

    private fun record(failure: DeviceSocketAttemptFailure) {
        when (failure) {
            is DeviceSocketAttemptFailure.Network -> noteTemporaryFailure(failure.detail)
            is DeviceSocketAttemptFailure.Server ->
                noteTemporaryFailure("The gateway answered with status ${failure.status}.")
            DeviceSocketAttemptFailure.RateLimited ->
                noteTemporaryFailure("The gateway is limiting connection attempts.")
            is DeviceSocketAttemptFailure.Trust ->
                _state.value = ConnectionState.Failed(FailureKind.CERTIFICATE, failure.detail)
            is DeviceSocketAttemptFailure.Authentication ->
                _state.value = ConnectionState.Failed(FailureKind.AUTHENTICATION, failure.detail)
            is DeviceSocketAttemptFailure.Incompatible ->
                _state.value = ConnectionState.Failed(FailureKind.INCOMPATIBLE, failure.detail)
        }
    }

    private fun noteTemporaryFailure(detail: String) {
        lastConnectionError = detail
        if (currentPath?.isUsable != false) failedAttemptsOnNetwork += 1
        publishReconnecting()
    }

    private fun publishReconnecting() {
        val network = when (currentPath?.isUsable) {
            true -> NetworkAvailability.AVAILABLE
            false -> NetworkAvailability.UNAVAILABLE
            null -> NetworkAvailability.UNKNOWN
        }
        _state.value = ConnectionState.Reconnecting(network, lastConnectionError, failedAttemptsOnNetwork)
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
        private val helloId = UUID.randomUUID().toString()

        override fun onOpen(webSocket: WebSocket, response: Response) {
            // The callback may beat newWebSocket() returning, or arrive after
            // stop() cancelled this generation. The generation guard handles
            // both orderings without accepting a stale socket.
            val accepted = synchronized(lifecycleLock) {
                if (connectionGeneration == generation && loop?.isActive == true) {
                    activeWs = webSocket
                    publishAttemptProgress(ConnectionState.Authenticating)
                    true
                } else {
                    false
                }
            }
            if (!accepted) {
                webSocket.cancel()
                return
            }
            val id = if (cloudRelay) helloId else UUID.randomUUID().toString().also { sharedHelloId = it }
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
            if (!cloudRelay) {
                val current = synchronized(lifecycleLock) {
                    connectionGeneration == generation && activeWs === webSocket
                }
                if (current) handleFrame(webSocket, text, sharedHelloId)
                return
            }
            synchronized(lifecycleLock) {
                if (connectionGeneration == generation && activeWs === webSocket && loop?.isActive == true &&
                    !ended.isCompleted && (phase == Phase.ATTEMPTING || phase == Phase.CONNECTED)) {
                    handleFrame(webSocket, text, helloId)
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            synchronized(lifecycleLock) {
                if (connectionGeneration == generation) {
                    if (activeWs === webSocket) activeWs = null
                    endAttempt(DeviceSocketAttemptFailure.Network("The gateway closed the connection (code $code)."))
                }
            }
            if (!ended.isCompleted) ended.complete(Unit)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            synchronized(lifecycleLock) {
                if (connectionGeneration == generation) {
                    if (activeWs === webSocket) activeWs = null
                    endAttempt(
                        DeviceSocketAttemptFailure.fromTransport(
                            t,
                            response?.code,
                            helloCompleted = phase == Phase.CONNECTED,
                        ),
                    )
                }
            }
            if (!ended.isCompleted) ended.complete(Unit)
        }
    }

    private fun handleFrame(webSocket: WebSocket, text: String, helloId: String?) {
        val obj = runCatching { OmnesisJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        val kind = obj["kind"]?.jsonPrimitive?.contentOrNull
        if (cloudRelay && kind != "response" && phase != Phase.CONNECTED) return
        when (kind) {
            "response" -> {
                val answered = obj["correlationId"]?.jsonPrimitive?.contentOrNull
                if (cloudRelay && answered != null && answered == probeId) {
                    // Any answer will do, an error included: the connection carried it.
                    probeAnswered()
                    return
                }
                if (cloudRelay && phase != Phase.ATTEMPTING) return
                if (obj["correlationId"]?.jsonPrimitive?.contentOrNull != helloId) return
                val ok = obj["ok"]?.jsonPrimitive?.booleanOrNull ?: false
                if (ok) {
                    val result = if (cloudRelay) obj["result"] as? JsonObject else obj["result"]?.jsonObject
                    synchronized(lifecycleLock) {
                        if (activeWs !== webSocket) return
                        if (expectedDeviceId != null && (result?.get("deviceId") as? JsonPrimitive)?.contentOrNull != expectedDeviceId) {
                            endAttempt(DeviceSocketAttemptFailure.Authentication("Gateway returned a different device identity"))
                            attemptEnded?.complete(Unit)
                            webSocket.cancel()
                            return
                        }
                        policy.recordConnected()
                        failedAttemptsOnNetwork = 0
                        lastConnectionError = null
                        retryWithoutBackoff = false
                        phase = Phase.CONNECTED
                        _state.value = ConnectionState.Connected(
                            deviceId = result?.get("deviceId")?.jsonPrimitive?.contentOrNull.orEmpty(),
                            deviceName = result?.get("deviceName")?.jsonPrimitive?.contentOrNull.orEmpty(),
                            connectionPath = directRoute?.connectionPath?.value,
                            scopes = result?.get("scopes")?.jsonArray
                                ?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
                        )
                    }
                    directRoute?.connectionPath?.value?.takeIf { it != GatewayConnectionPath.RECONNECTING }?.let { path ->
                        val moved = synchronized(lifecycleLock) { (lastConnectedPath != null && lastConnectedPath != path).also { lastConnectedPath = path } }
                        if (moved) onRouteEvent(RouteEvent.PATH_CHANGED)
                        sendEvent("connection.path", buildJsonObject { put("path", if (path == GatewayConnectionPath.LOCAL) "local" else "relay") })
                    }
                } else {
                    val msg = obj["error"]?.jsonObject?.get("message")
                        ?.jsonPrimitive?.contentOrNull ?: "authentication failed"
                    val code = obj["error"]?.jsonObject?.get("code")?.jsonPrimitive?.contentOrNull
                    synchronized(lifecycleLock) {
                        if (activeWs !== webSocket) return
                        endAttempt(DeviceSocketAttemptFailure.fromHello(code, msg))
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

        private const val LOG_TAG = "Omnesis"
        private const val HANDSHAKE_TIMEOUT_MS = 30_000L
        private const val HANDSHAKE_TIMEOUT_MESSAGE = "The gateway didn't answer in time."
    }
}

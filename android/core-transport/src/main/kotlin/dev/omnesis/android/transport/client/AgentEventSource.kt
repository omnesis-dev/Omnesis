// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import android.util.Log
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.sse.SSEFrameParser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicLong

/**
 * One decoded agent SSE event plus the SSE `id:` it arrived with ([id] is null when
 * the frame carried no id — e.g. control events like `agent.resync`). The coordinator
 * tracks the latest non-null [id] and passes it as `Last-Event-ID` on reconnect so the
 * gateway replays exactly what was missed. Mirrors the iOS `AgentStreamItem`.
 */
data class AgentStreamItem(val id: String?, val event: AgentEvent)

/**
 * The agent SSE stream (`GET /agent/events`) as a cold, cancellable [Flow] of
 * [AgentStreamItem]. Faithful to the iOS setup: `Accept: text/event-stream`, identity
 * encoding (no gzip stalls), byte-level [SSEFrameParser], and an idle watchdog over the
 * byte loop. The flow completes when the stream closes and throws on transport error;
 * the caller supervises reconnect with backoff. Use the long-lived (streaming) OkHttp
 * client so reads never time out at the socket layer — stall detection is the
 * watchdog's job (see [idleTimeoutMs]).
 */
class AgentEventSource(
    private val client: OkHttpClient,
    private val gatewayUrl: String,
    private val token: String,
    /**
     * Hard ceiling on stream silence before the connection is treated as a half-open
     * socket: a NAT rebind or Wi-Fi↔cellular handoff that left TCP a zombie, which the
     * OS otherwise never fails. The gateway emits a `: hb` heartbeat every ~25s, so
     * the 60s default (more than two missed heartbeats) distinguishes a quiet stream
     * from a dead one. Firing fails the flow, the coordinator reconnects with
     * `Last-Event-ID`, and the gateway replays the tail. Mirrors the iOS
     * `streamIdleTimeout`.
     */
    private val idleTimeoutMs: Long = STREAM_IDLE_TIMEOUT_MS,
    /**
     * How often the watchdog checks the byte clock. Mirrors the iOS
     * `watchdogCheckInterval`.
     */
    private val watchdogIntervalMs: Long = WATCHDOG_CHECK_INTERVAL_MS,
) {
    init {
        // A non-positive ceiling would fire on the first check and kill every healthy
        // stream (and `0` is OkHttp's own "no timeout" convention, live in this
        // codebase), while a non-positive interval breaks `delay()`. Fail fast at
        // construction instead.
        require(idleTimeoutMs > 0) { "idleTimeoutMs must be positive (was $idleTimeoutMs)" }
        require(watchdogIntervalMs > 0) { "watchdogIntervalMs must be positive (was $watchdogIntervalMs)" }
    }
    /**
     * Open the stream. [lastEventId], when set, is sent as the `Last-Event-ID`
     * request header so the gateway replays the buffered events past that point
     * (mirrors the iOS `AgentClient.events(lastEventId:)`).
     */
    fun events(
        lastEventId: String? = null,
        onOpen: (() -> Unit)? = null,
    ): Flow<AgentStreamItem> = callbackFlow {
        val url = gatewayUrl.toHttpUrl().newBuilder()
            .addPathSegment("agent").addPathSegment("events").build()
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .header("Accept-Encoding", "identity")
            .apply {
                if (!lastEventId.isNullOrEmpty()) header("Last-Event-ID", lastEventId)
            }
            .build()
        val call = client.newCall(request)

        // Last byte arrival, in nanos. Touched by the reader on every byte — event frames
        // and heartbeat comments alike — and read by the watchdog below; the two run on
        // different dispatchers, hence atomic. Mirrors the iOS `ActivityClock`.
        val lastActivityNanos = AtomicLong(System.nanoTime())

        val reader = launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) {
                        val error = when (response.code) {
                            401 -> GatewayException.Unauthorized()
                            403 -> GatewayException.Forbidden()
                            else -> GatewayException.ServerError(response.code, null)
                        }
                        close(error)
                        return@use
                    }
                    val source = response.body?.source()
                    if (source == null) {
                        close(GatewayException.InvalidResponse("agent SSE has no body"))
                        return@use
                    }
                    // A voice caller must attach before posting its question: a fresh stream has
                    // no cursor to replay from, so POST-before-attach can lose the first delta.
                    // Signal only after the successful response and body are both available.
                    onOpen?.invoke()
                    val parser = SSEFrameParser()
                    while (isActive && !source.exhausted()) {
                        val byte = source.readByte().toInt() and 0xFF
                        lastActivityNanos.set(System.nanoTime())
                        val frame = parser.consume(byte)
                        if (frame != null && frame.data.isNotBlank()) {
                            // An unrecognised event `type` decodes to `AgentEvent.Unknown` rather
                            // than throwing, so a failure here is a malformed payload for a type
                            // this build does know — nothing the client can act on, so it is
                            // skipped. Logged (not silent): a skipped `message.end` strands the
                            // turn "running" until the conversation is reopened, and without this
                            // line logcat gives no hint that frames were lost. The log carries
                            // only the frame's shape (id, byte length, decoder error) — never
                            // payload bytes, which may hold message content.
                            val event = runCatching { OmnesisJson.decodeFromString<AgentEvent>(frame.data) }
                                .getOrElse { error ->
                                    Log.w(
                                        TAG,
                                        "agent SSE dropped an undecodable frame id=${frame.id} " +
                                            "bytes=${frame.data.toByteArray().size}: $error",
                                    )
                                    null
                                }
                            // SUSPENDING send, never `trySend`: a dropped event is unrecoverable
                            // here. Nothing re-requests it — the connection is healthy, so no
                            // reconnect replays it and `Last-Event-ID` never rewinds over it — so a
                            // drop silently truncates the transcript, and a dropped `message.end`
                            // strands the turn "running" until the conversation is reopened.
                            // Suspending instead stops draining the socket while the collector
                            // catches up, which is what TCP backpressure is for.
                            if (event != null) send(AgentStreamItem(frame.id, event))
                        }
                    }
                    close()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                close(e)
            }
        }

        // Idle watchdog: a stream that goes silent past [idleTimeoutMs] is a half-open
        // socket the OS won't fail until the request timeout — which is disabled on the
        // streaming client. Close with a transport error first (so the flow fails with
        // the stall, not the generic cancel that follows), then cancel the call to
        // unblock the reader's socket read; the coordinator's supervisor reconnects
        // promptly, resuming via Last-Event-ID. Mirrors the iOS watchdog task.
        val watchdog = launch {
            // Saturated: an absurdly large ceiling must mean "effectively never", not an
            // overflowed negative that fires immediately.
            val idleTimeoutNanos = try {
                Math.multiplyExact(idleTimeoutMs, 1_000_000L)
            } catch (_: ArithmeticException) {
                Long.MAX_VALUE
            }
            while (isActive && !isClosedForSend) {
                delay(watchdogIntervalMs)
                if (System.nanoTime() - lastActivityNanos.get() > idleTimeoutNanos) {
                    close(
                        GatewayException.Network(
                            SocketTimeoutException(
                                "agent SSE stream stalled: no bytes for ${idleTimeoutMs}ms",
                            ),
                        ),
                    )
                    call.cancel()
                    return@launch
                }
            }
        }

        awaitClose {
            call.cancel()
            reader.cancel()
            watchdog.cancel()
        }
    }

    companion object {
        /** Default silence ceiling; mirrors the iOS `streamIdleTimeout`. */
        const val STREAM_IDLE_TIMEOUT_MS = 60_000L
        /** Default watchdog cadence; mirrors the iOS `watchdogCheckInterval`. */
        const val WATCHDOG_CHECK_INTERVAL_MS = 10_000L

        private const val TAG = "Omnesis:agent-sse"
    }
}

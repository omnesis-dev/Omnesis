// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

/**
 * Typed errors surfaced by the gateway transport clients. Mirrors the iOS
 * `GatewayClient.Error` enum so every client maps HTTP failures identically and
 * the UI error classifier can pick the right copy from the throwable.
 */
sealed class GatewayException(message: String? = null, cause: Throwable? = null) :
    Exception(message, cause) {
    class Unauthorized : GatewayException("unauthorized")
    class Forbidden : GatewayException("forbidden")
    /** [body] is the gateway's error message when the 404 carried its envelope, e.g. "source not found". */
    class NotFound(val body: String? = null) : GatewayException("not found")
    /**
     * A 4xx/5xx the gateway answered with its error envelope,
     * `{ "error": <message>, "code": <CODE>, "detail"?: <unknown> }`.
     *
     * [body] is the unwrapped `error` message — several surfaces put it
     * straight on screen, so the envelope is opened once at the transport
     * boundary rather than by each of them. A response that is not the
     * envelope (a proxy's HTML, a truncated body) arrives here unchanged.
     * [code] is the machine-readable half, for callers that branch on a
     * specific failure rather than showing it.
     */
    class ServerError(val status: Int, val body: String?, val code: String? = null) :
        GatewayException("server error $status")
    class InvalidResponse(detail: String) : GatewayException(detail)
    class Decoding(detail: String, cause: Throwable? = null) : GatewayException(detail, cause)
    class Network(cause: Throwable) : GatewayException(cause.message ?: "network error", cause)
}

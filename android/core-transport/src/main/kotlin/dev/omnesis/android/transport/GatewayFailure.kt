// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

/** What a failed gateway call means for whoever wants to send the same payload again. */
enum class GatewayFailureKind {
    /**
     * The pairing itself is the problem. Neither a retry nor a different
     * payload helps; the user has to re-pair.
     */
    NEEDS_ATTENTION,

    /**
     * The request never got a verdict, or got one that says "later". Nothing
     * is known to be wrong with the payload, so re-sending it unchanged is
     * the right move — however long the condition lasts.
     */
    TRANSIENT,

    /**
     * The gateway read the payload and refused it. Re-sending it unchanged
     * reproduces the refusal, so a caller that keeps a copy of the payload
     * must eventually stop rather than block everything behind it.
     */
    PERMANENT,
}

/**
 * Statuses in the 4xx range that answer "later", not "no": a reverse proxy
 * timing out a slow request body on a weak uplink returns 408, a client that
 * got ahead of the server returns 425, and a rate limiter returns 429. None
 * of them is a verdict on the payload, and treating them as one would put the
 * largest pushes on the worst connections first in line to be given up on.
 */
private val RETRY_LATER_STATUSES = setOf(408, 425, 429)

/**
 * The one classifier every device-hosted source uses to decide what a failed
 * push means. It exists as a single function because the answer is a property
 * of HTTP and of [GatewayException], not of any one source, and because the
 * cost of the sources disagreeing is data: a caller that counts transient
 * failures against a give-up budget discards data an outage would have
 * delivered.
 *
 * Everything that is not a 4xx verdict is [GatewayFailureKind.TRANSIENT],
 * deliberately — including a reply the app cannot decode. A captive portal's
 * login page and a proxy error page produce that as readily as a real
 * protocol mismatch, and paying for the mismatch with data is the worse trade.
 */
fun classifyGatewayFailure(cause: Throwable): GatewayFailureKind = when {
    cause is GatewayException.Unauthorized || cause is GatewayException.Forbidden ->
        GatewayFailureKind.NEEDS_ATTENTION

    cause is GatewayException.ServerError &&
        cause.status in 400..499 &&
        cause.status !in RETRY_LATER_STATUSES -> GatewayFailureKind.PERMANENT

    else -> GatewayFailureKind.TRANSIENT
}

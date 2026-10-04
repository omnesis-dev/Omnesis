// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException

/**
 * Whether the paired gateway adds graph context to `POST /search`, as last read
 * from `GET /search/readiness`. One [SearchClient] talks to one gateway with one
 * token, so the answer is kept for that client and asked again only after
 * [invalidate] — which the app calls whenever it re-reads the gateway's
 * `/status` or the device socket reconnects, the moments a gateway update or
 * restart becomes visible. Mirrors the iOS `SearchGraphCapability`.
 *
 * Only a conclusive answer is kept: a decoded readiness body, or a refusal the
 * gateway itself sent (an older gateway's 404, a 403). A transport failure or a
 * server error leaves the capability unknown, so the next search asks again.
 */
internal class SearchGraphCapability {
    /** The kept answer, with the generation a probe must present to store a new one. */
    data class Snapshot(val value: Boolean?, val generation: Long)

    private var known: Boolean? = null
    private var generation = 0L

    @Synchronized
    fun read(): Snapshot = Snapshot(known, generation)

    /** Drops the answer of a probe that an [invalidate] overtook while it was in flight. */
    @Synchronized
    fun store(value: Boolean, probedGeneration: Long) {
        if (probedGeneration == generation) known = value
    }

    @Synchronized
    fun invalidate() {
        known = null
        generation++
    }

    companion object {
        fun isConclusive(error: Exception): Boolean =
            error is GatewayException.NotFound || error is GatewayException.Forbidden
    }
}

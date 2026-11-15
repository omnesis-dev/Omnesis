// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import java.time.Instant
import kotlinx.serialization.Serializable

/**
 * A device on the owner's Tailscale network that asked to join the gateway and waits for an
 * administrator's decision. One row of `GET /admin/tailscale/join-requests`. Only `id`, `name`
 * and the two times are required; the rest describe the Tailscale node when the gateway knows it.
 */
@Serializable
data class TailscaleJoinRequest(
    val id: String,
    val name: String,
    /** The device kind it will pair as, such as `collector`. */
    val kind: String? = null,
    /** The Tailscale machine name. */
    val machine: String? = null,
    val os: String? = null,
    /** The Tailscale account the machine is logged in as. */
    val login: String? = null,
    /** ISO-8601 instants. */
    val requestedAt: String,
    val expiresAt: String,
) {
    /** [requestedAt] in epoch milliseconds, or null when it can't be read. */
    val requestedAtMillis: Long? get() = epochMillis(requestedAt)

    /** [expiresAt] in epoch milliseconds, or null when it can't be read. */
    val expiresAtMillis: Long? get() = epochMillis(expiresAt)

    /** Whether it ran out by [nowMillis]; a time that can't be read never counts as run out. */
    fun expired(nowMillis: Long): Boolean = expiresAtMillis?.let { it <= nowMillis } == true

    private fun epochMillis(instant: String): Long? = runCatching { Instant.parse(instant).toEpochMilli() }.getOrNull()
}

@Serializable
internal data class TailscaleJoinRequests(val requests: List<TailscaleJoinRequest> = emptyList())

@Serializable
internal data class TailscaleJoinDecisionBody(val approve: Boolean)

@Serializable
internal data class TailscaleJoinDecisionResult(val status: String)

/** The gateway's waiting Tailscale join requests, read and decided by an administrator. */
interface TailscaleJoinApproving {
    suspend fun tailscaleJoinRequests(): List<TailscaleJoinRequest>

    /**
     * Approves or denies one request; returns the gateway's `status` (`approved` or `denied`).
     * A request that expired or was already decided is a [dev.omnesis.android.transport.GatewayException.NotFound].
     */
    suspend fun decideTailscaleJoin(id: String, approve: Boolean): String
}

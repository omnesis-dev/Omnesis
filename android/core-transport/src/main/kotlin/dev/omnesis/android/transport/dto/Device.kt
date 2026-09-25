// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * `GET /admin/devices`. Mirrors the iOS `DeviceRecord`. `online` is appended by the
 * gateway from current WebSocket connection state (not part of the stored record).
 * `capabilities` is decoded just far enough to surface a host name or external-agent
 * integration identity; the rest of the capability blob is ignored. A revoked device
 * keeps its row (and the sources it hosts) with [revokedAt] set; only a forget removes it.
 */
@Serializable
data class DeviceRecord(
    val id: String,
    val name: String = "",
    val kind: String = "",
    val pairedAt: Long = 0,
    val lastSeenAt: Long? = null,
    val capabilities: DeviceCapabilities? = null,
    val online: Boolean? = null,
    val revokedAt: Long? = null,
) {
    val revoked: Boolean get() = revokedAt != null
}

/**
 * Subset of a device's `capabilities` blob the device list surfaces: the
 * software-side `hostname` and an external-agent integration identity.
 */
@Serializable
data class DeviceCapabilities(
    val hostname: String? = null,
    val agentIntegration: AgentIntegrationCapability? = null,
)

/** Display-safe portion of `capabilities.agentIntegration`. */
@Serializable
data class AgentIntegrationCapability(
    val harness: String = "",
    val deliveryProtocolMin: Int = 2,
    val deliveryProtocolMax: Int = 2,
    val maxConcurrentRuns: Int = 1,
)

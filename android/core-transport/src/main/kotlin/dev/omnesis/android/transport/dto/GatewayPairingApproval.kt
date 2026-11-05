// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

@Serializable
data class GatewayPairingApprovalRequest(
    val requestId: String,
    val kind: String,
    val name: String,
    val status: String,
    val verificationCode: String,
    val expiresAt: Long,
)

interface GatewayPairingApproving {
    suspend fun pairingApprovalRequests(): List<GatewayPairingApprovalRequest>
    suspend fun decidePairingApproval(requestId: String, approve: Boolean)
}

@Serializable
internal data class GatewayPairingApprovalRequests(val items: List<GatewayPairingApprovalRequest>)

@Serializable
internal data class GatewayPairingApprovalDecision(val requestId: String, val approve: Boolean)

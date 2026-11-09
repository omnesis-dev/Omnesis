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
    /** A verified sign-in that is not trusted yet, which approving can add to Trusted sign-ins. */
    val canTrustSignIn: Boolean = false,
    /** `google` or `passkey`, when the request carried a sign-in the gateway verified. */
    val signIn: String? = null,
)

interface GatewayPairingApproving {
    suspend fun pairingApprovalRequests(): List<GatewayPairingApprovalRequest>
    suspend fun decidePairingApproval(requestId: String, approve: Boolean, trustSignIn: Boolean = false)
}

@Serializable
internal data class GatewayPairingApprovalRequests(val items: List<GatewayPairingApprovalRequest>)

/** `trustSignIn` is left out unless it is set. */
@Serializable
internal data class GatewayPairingApprovalDecision(val requestId: String, val approve: Boolean, val trustSignIn: Boolean? = null)

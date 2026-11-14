// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

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

/**
 * Where a passkey ceremony on this gateway runs, as `/devices/account/config` advertises it
 * (`gatewayPasskey`): the relay's host as RP ID and the gateway's own origin. Absent when the
 * gateway has no origin of its own, such as a custom domain.
 */
@Serializable
data class GatewayPasskeyLocation(val rpId: String, val origin: String)

/**
 * A passkey ceremony the gateway issued (`GatewayPasskeyCeremony` in
 * `packages/cloud-relay/src/gateway-account-link.ts`). The app uses `rpId`, `challenge` and
 * `binding`; `origin` and `webauthnChallenge` name the gateway's web page and are never used
 * here, since the app computes the challenge with its own origin.
 */
@Serializable
data class GatewayPasskeyCeremony(
    val purpose: String,
    val rpId: String,
    val origin: String? = null,
    val challenge: String,
    val binding: String,
    val webauthnChallenge: String? = null,
    /** Unix milliseconds. */
    val expiresAt: Long,
)

interface GatewayPairingApproving {
    suspend fun pairingApprovalRequests(): List<GatewayPairingApprovalRequest>
    suspend fun decidePairingApproval(requestId: String, approve: Boolean, trustSignIn: Boolean = false)
    /** Where this gateway runs passkey ceremonies, or null when it offers none. */
    suspend fun pairingPasskeyLocation(): GatewayPasskeyLocation? = null
    /** `POST /devices/account/approval/options`: an `approve-request` ceremony for one held request. */
    suspend fun pairingApprovalCeremony(requestId: String): GatewayPasskeyCeremony =
        throw UnsupportedOperationException("passkey approval is not available")
    /** `POST /devices/account/approval`: approves the request with a `gateway-passkey` proof. */
    suspend fun approvePairingWithPasskey(requestId: String, proof: JsonObject, trustSignIn: Boolean = false): Unit =
        throw UnsupportedOperationException("passkey approval is not available")
}

@Serializable
internal data class GatewayPairingApprovalRequests(val items: List<GatewayPairingApprovalRequest>)

/** `trustSignIn` is left out unless it is set. */
@Serializable
internal data class GatewayPairingApprovalDecision(val requestId: String, val approve: Boolean, val trustSignIn: Boolean? = null)

/** The body of `POST /devices/account/approval` from an app: no device signature, which only a portal's request needs. */
@Serializable
internal data class GatewayPairingPasskeyApproval(val requestId: String, val proof: JsonObject, val trustSignIn: Boolean? = null)

@Serializable
internal data class GatewayPairingApprovalCeremonyRequest(val requestId: String)

/** Only the field the app reads from `/devices/account/config`. */
@Serializable
internal data class GatewayAccountPairingConfig(val gatewayPasskey: GatewayPasskeyLocation? = null)

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.postJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/**
 * Replaces a device token every 30 days, proving the device key that joined. Opportunistic: any
 * failure, including a gateway without these routes, leaves the current token in use.
 */
class DeviceTokenRotator(
    private val keys: DeviceKeyStore,
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Serializable private data class Empty(val unused: String? = null)
    @Serializable private data class Challenge(val challenge: String)
    @Serializable private data class RotateBody(val challenge: String, val signature: String)
    @Serializable private data class Rotated(val token: String, val tokenId: String? = null)

    fun due(pairing: Pairing): Boolean =
        pairing.deviceKeyRecorded && pairing.deviceId != null && pairing.spkiFingerprint != null &&
            now() - (pairing.tokenRotatedAt ?: 0L) >= ROTATION_INTERVAL_MILLIS

    /** True when a new token was stored; the caller rebuilds its clients around it. */
    suspend fun rotate(pairing: Pairing, http: GatewayHttp, service: PairingService): Boolean {
        if (!due(pairing)) return false
        return try {
            val key = withContext(Dispatchers.Default) { keys.loadOrCreate() }
            val challenge = http.postJson<Empty, Challenge>("devices/token/challenge", Empty()).challenge
            val signature = withContext(Dispatchers.Default) {
                key.sign(DeviceEnrollmentContract.tokenRotationTranscript(
                    pairing.deviceId!!, pairing.spkiFingerprint!!, challenge, key.publicKey,
                ))
            }
            val rotated = http.postJson<RotateBody, Rotated>("devices/token/rotate", RotateBody(challenge, signature))
            rotated.token.isNotBlank() && service.replaceToken(pairing, rotated.token, rotated.tokenId, now())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            false
        }
    }

    companion object {
        const val ROTATION_INTERVAL_MILLIS = 30L * 24 * 60 * 60 * 1000
    }
}

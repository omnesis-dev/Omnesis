// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.util.Base64

/**
 * Sign-in enrollment wire contract. `packages/cloud-relay/src/device-enrollment.ts` is
 * authoritative and its vectors are repeated in DeviceEnrollmentContractTest. Every transcript
 * is a JSON array of ASCII strings, so names and secrets are hashed before they enter one.
 */
object DeviceEnrollmentContract {
    private fun hex(value: ByteArray) = cloudSha256(value).joinToString("") { "%02x".format(it) }
    private fun hex(value: String) = hex(value.toByteArray(Charsets.UTF_8))

    /** SHA-256 of the DER SubjectPublicKeyInfo, used wherever a device key is named. */
    fun deviceKeyThumbprint(devicePublicKey: String): String = hex(cloudDecodeBase64Url(devicePublicKey))

    /** The one value a sign-in commits to: it names this request and this device key. */
    fun enrollmentNonce(requestId: String, kind: String, name: String, secret: String, devicePublicKey: String): String =
        cloudDigestUrl(cloudTranscript(listOf(
            "omnesis-device-enrollment-v3", requestId, kind, hex(name), hex(secret), deviceKeyThumbprint(devicePublicKey),
        )))

    fun googleProofNonce(salt: String, nonce: String): String =
        cloudDigestUrl(cloudTranscript(listOf("omnesis-google-proof-v3", salt, nonce)))

    /** `issuedAt` is Unix seconds as a decimal string. */
    fun passkeyProofChallenge(salt: String, issuedAt: String, nonce: String): String =
        cloudDigestUrl(cloudTranscript(listOf("omnesis-passkey-proof-v3", salt, issuedAt, nonce)))

    /** What a `gateway-passkey` assertion is for (`gatewayPasskeyPurposeSchema`). */
    val GATEWAY_PASSKEY_PURPOSES = setOf("device-enrollment", "approve-request", "pin-passkey", "step-up")

    /**
     * The WebAuthn challenge of a `gateway-passkey` assertion: the purpose, the origin the
     * assertion is made from, the gateway's one-use value and what it approves. In this app the
     * origin is always the app's own `android:apk-key-hash:` origin, never one a server names.
     */
    fun gatewayPasskeyChallenge(purpose: String, origin: String, gatewayChallenge: String, binding: String): String {
        require(purpose in GATEWAY_PASSKEY_PURPOSES && OPAQUE.matches(gatewayChallenge))
        return cloudDigestUrl(cloudTranscript(listOf("omnesis-gateway-passkey-v1", purpose, origin, gatewayChallenge, binding)))
    }

    /**
     * The WebAuthn origin Credential Manager reports for passkeys used in an app signed with
     * this certificate: `android:apk-key-hash:` and the base64url SHA-256 of its DER encoding.
     */
    fun androidApkKeyHashOrigin(signingCertificate: ByteArray): String =
        "android:apk-key-hash:" + Base64.getUrlEncoder().withoutPadding().encodeToString(cloudSha256(signingCertificate))

    private val OPAQUE = Regex("^[A-Za-z0-9_-]{43}$")

    fun enrollmentSignatureTranscript(
        requestId: String,
        kind: String,
        name: String,
        gatewaySpkiFingerprint: String,
        challenge: String,
        devicePublicKey: String,
    ): ByteArray = cloudTranscript(listOf(
        "omnesis-device-enrollment-signature-v3", requestId, kind, hex(name), gatewaySpkiFingerprint, challenge,
        deviceKeyThumbprint(devicePublicKey),
    ))

    fun tokenRotationTranscript(
        deviceId: String,
        gatewaySpkiFingerprint: String,
        challenge: String,
        devicePublicKey: String,
    ): ByteArray = cloudTranscript(listOf(
        "omnesis-device-token-rotation-v1", deviceId, gatewaySpkiFingerprint, challenge, deviceKeyThumbprint(devicePublicKey),
    ))
}

/** This install's P-256 key. */
interface DeviceKey {
    /** base64url DER SubjectPublicKeyInfo. */
    val publicKey: String
    /** base64url DER ECDSA over SHA-256. */
    fun sign(transcript: ByteArray): String
}

fun interface DeviceKeyStore {
    fun loadOrCreate(): DeviceKey
}

internal class SigningDeviceKey(private val privateKey: PrivateKey, publicKey: PublicKey) : DeviceKey {
    override val publicKey: String = Base64.getUrlEncoder().withoutPadding().encodeToString(publicKey.encoded)
    override fun sign(transcript: ByteArray): String {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(privateKey)
        signature.update(transcript)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign())
    }
}

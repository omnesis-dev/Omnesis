// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.security.SecureRandom
import java.util.UUID

class CloudPairingException(val statusCode: Int? = null) : Exception("Cloud pairing could not be verified")

@Serializable
class CloudPairingChallenge private constructor(val requestId: String, val kind: String, val name: String, val secret: String) {
    companion object {
        fun create(name: String, requestId: String = UUID.randomUUID().toString(), secret: String? = null): CloudPairingChallenge {
            val clean = name.trim { it in "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF" }
            if (clean.isEmpty() || clean.length > 80 || runCatching { UUID.fromString(requestId).toString() != requestId }.getOrDefault(true))
                throw CloudPairingException()
            val value = secret ?: ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
            if (!Regex("^[a-f0-9]{64}$").matches(value)) throw CloudPairingException()
            return CloudPairingChallenge(requestId, "android", clean, value)
        }
    }
    private val secretHash get() = cloudSha256(secret.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    val nonce get() = cloudDigestUrl(cloudTranscript(listOf("omnesis-device-pairing-v2", requestId, kind, name, secretHash)))
    fun verificationCode(fingerprint: String): String {
        if (!Regex("^[a-f0-9]{64}$").matches(fingerprint)) throw CloudPairingException()
        return cloudSha256(cloudTranscript(listOf("omnesis-pairing-sas-v2", fingerprint, requestId, secretHash)))
            .joinToString("") { "%02x".format(it) }.take(20).uppercase().chunked(4).joinToString("-")
    }
}

@Serializable
data class CloudPairingProgress(val status: String, val verificationCode: String, val expiresAt: Long, val pairingCode: String? = null)

/** Neither a directory result nor a remote approval can establish trust without the local comparison. */
class CloudPairingConfirmation(val challenge: CloudPairingChallenge, candidate: GoogleGatewayBinding,
                               now: Long = System.currentTimeMillis()) {
    val origin = candidate.candidateOrigin()
    val fingerprint = candidate.candidateFingerprint(now / 1000)
    val spkiFingerprint = candidate.candidateSpkiFingerprint(now / 1000)
    val verificationCode = challenge.verificationCode(fingerprint)
    val approved: Boolean get() = pairingCode != null
    var compared = false; private set
    private var expiresAt = now + 600_000
    private var pairingCode: String? = null

    fun receive(progress: CloudPairingProgress, now: Long = System.currentTimeMillis()) {
        if (now >= expiresAt || progress.expiresAt <= now || progress.verificationCode != verificationCode ||
            progress.status !in listOf("pending", "approved")) throw CloudPairingException()
        expiresAt = minOf(expiresAt, progress.expiresAt)
        if (progress.status == "approved") {
            val code = progress.pairingCode ?: throw CloudPairingException()
            if (code.isEmpty() || code.toByteArray().size > 256) throw CloudPairingException()
            pairingCode = code
        }
    }

    /** Invoke only after a human explicitly compares the code on an independently trusted device. */
    fun confirmComparison() { compared = true }

    fun pairingPayload(now: Long = System.currentTimeMillis()): String {
        if (now >= expiresAt || !compared) throw CloudPairingException()
        val code = pairingCode ?: throw CloudPairingException()
        return buildJsonObject {
            put("v", 4); put("gatewayUrl", origin); put("pairingCode", code)
            putJsonObject("tls") { put("mode", "pinned-key-strict"); put("spkiFingerprint", spkiFingerprint) }
        }.toString()
    }
}

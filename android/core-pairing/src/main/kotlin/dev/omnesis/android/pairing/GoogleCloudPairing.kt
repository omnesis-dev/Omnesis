// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.security.SecureRandom
import java.util.UUID

/** [refusal] is the reason a 403 named in its body, when it named one. */
class CloudPairingException(val statusCode: Int? = null, val refusal: String? = null) : Exception("Cloud pairing could not be verified")

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
    /**
     * The code this device and an approving device compare (docs/device-enrollment.md, "Comparison
     * code"). It names the gateway certificate this device connected to, the request, this
     * device's secret and the gateway's nonce. Six digits are enough only because the gateway
     * committed to [codeNonce] ([PairingCode.commitment]) before this device sent its secret.
     */
    fun comparisonCode(fingerprint: String, codeNonce: String): String {
        if (!Regex("^[a-f0-9]{64}$").matches(fingerprint) || !PairingCode.OPAQUE.matches(codeNonce)) throw CloudPairingException()
        val digest = cloudSha256(cloudTranscript(listOf("omnesis-pairing-code-v3", fingerprint, requestId, secretHash, codeNonce)))
        // The first six bytes as an unsigned big-endian integer. A byte above 0x7f must not sign-extend.
        var n = 0L
        for (index in 0 until 6) n = (n shl 8) or (digest[index].toLong() and 0xff)
        val digits = (n % 1_000_000).toString().padStart(6, '0')
        return "${digits.substring(0, 3)} ${digits.substring(3)}"
    }
}

/** The comparison code's wire format and the gateway's commitment to its part of it. */
object PairingCode {
    internal val OPAQUE = Regex("^[A-Za-z0-9_-]{43}$")

    /** A code as it is sent, shown and compared: six decimal digits in two groups. */
    val FORMAT = Regex("^[0-9]{3} [0-9]{3}$")

    /** The challenge that fixes [codeNonce] without revealing it. */
    fun commitment(codeNonce: String): String {
        if (!OPAQUE.matches(codeNonce)) throw CloudPairingException()
        return cloudDigestUrl(cloudTranscript(listOf("omnesis-pairing-code-commitment-v1", codeNonce)))
    }

    /** The one formatter: typed or stored digits become `123 456`; anything else is not a code. */
    fun format(input: String): String? {
        val digits = input.filterNot { it == '-' || it.isWhitespace() }
        return if (Regex("^[0-9]{6}$").matches(digits)) "${digits.substring(0, 3)} ${digits.substring(3)}" else null
    }
}

@Serializable
data class CloudPairingProgress(
    val status: String,
    val verificationCode: String,
    val expiresAt: Long,
    val pairingCode: String? = null,
    /** The gateway's part of the code, revealed once the request is fixed. A reply without one is refused. */
    val codeNonce: String = "",
)

/** Neither a directory result nor a remote approval can establish trust without the local comparison. */
class CloudPairingConfirmation(val challenge: CloudPairingChallenge, candidate: GoogleGatewayBinding,
                               now: Long = System.currentTimeMillis()) {
    val origin = candidate.candidateOrigin()
    val fingerprint = candidate.candidateFingerprint(now / 1000)
    val spkiFingerprint = candidate.candidateSpkiFingerprint(now / 1000)
    /**
     * The code to show, computed here from the certificate this device connected to. Null until
     * a reply proved the gateway's commitment, and null again for good once any reply failed a
     * check: a code taken from a reply is never shown.
     */
    var verificationCode: String? = null; private set
    private var commitment: String? = null
    private var codeNonce: String? = null
    private var refused = false
    val approved: Boolean get() = pairingCode != null
    var compared = false; private set
    private var expiresAt = now + 600_000
    private var pairingCode: String? = null

    /**
     * The gateway's challenge, received before this device's secret was sent anywhere. It is the
     * gateway's commitment to its nonce. A request refused for a spent challenge asks for another
     * and names that one, as long as no reply has been accepted.
     */
    fun expect(challenge: String) {
        if (refused || codeNonce != null || !PairingCode.OPAQUE.matches(challenge)) refuse()
        commitment = challenge
    }

    private fun refuse(): Nothing {
        refused = true
        verificationCode = null
        pairingCode = null
        throw CloudPairingException()
    }

    fun receive(progress: CloudPairingProgress, now: Long = System.currentTimeMillis()) {
        if (refused) throw CloudPairingException()
        if (now >= expiresAt || progress.expiresAt <= now || progress.status !in listOf("pending", "approved")) throw CloudPairingException()
        val expected = commitment ?: refuse()
        // The nonce must be the one committed to before the secret was sent, and must never change.
        if (!PairingCode.OPAQUE.matches(progress.codeNonce) || PairingCode.commitment(progress.codeNonce) != expected) refuse()
        if (codeNonce != null && codeNonce != progress.codeNonce) refuse()
        val local = challenge.comparisonCode(fingerprint, progress.codeNonce)
        // The gateway computes the same code from its own certificate. A different one means
        // this is not the connection the gateway sees, so nothing is shown.
        if (progress.verificationCode != local) refuse()
        codeNonce = progress.codeNonce
        verificationCode = local
        expiresAt = minOf(expiresAt, progress.expiresAt)
        if (progress.status == "approved") {
            val code = progress.pairingCode ?: throw CloudPairingException()
            if (code.isEmpty() || code.toByteArray().size > 256) throw CloudPairingException()
            pairingCode = code
        }
    }

    /** Invoke only after a human explicitly compares the code on an independently trusted device. */
    fun confirmComparison() { compared = true }

    /** The gateway joined this device on its own checks, so there is no human comparison to wait for. */
    var joined = false; private set
    internal fun acceptJoin() {
        if (!approved) throw CloudPairingException()
        joined = true; compared = true
    }

    fun pairingPayload(now: Long = System.currentTimeMillis()): String {
        if (now >= expiresAt || !compared) throw CloudPairingException()
        val code = pairingCode ?: throw CloudPairingException()
        return buildJsonObject {
            put("v", 4); put("gatewayUrl", origin); put("pairingCode", code)
            putJsonObject("tls") { put("mode", "pinned-key-strict"); put("spkiFingerprint", spkiFingerprint) }
        }.toString()
    }
}

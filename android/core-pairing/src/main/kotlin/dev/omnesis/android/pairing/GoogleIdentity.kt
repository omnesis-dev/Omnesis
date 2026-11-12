// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.tls.GatewayTrustPolicy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.net.URI
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.RSAPublicKeySpec
import java.util.Base64
import java.util.Locale
import java.util.Date

class CloudIdentityException : Exception("Google identity or gateway key verification failed")

data class VerifiedGoogleIdentity(val subject: String, val expiresAt: Long, val issuedAt: Long = 0) {
    val accountId: String get() = cloudSha256(cloudTranscript(listOf("https://accounts.google.com", subject)))
        .joinToString("") { "%02x".format(it) }
}

/** Google signatures are verified locally against independently fetched Google public keys. */
class GoogleIdentityVerifier(jwks: String, private val clientIds: Set<String>,
                             private val presenterClientIds: Set<String> = clientIds) {
    private val keys: JsonArray
    init {
        if (jwks.toByteArray().size > 65_536 || clientIds.isEmpty() || clientIds.size > 16 || clientIds.any { it.isEmpty() } ||
            presenterClientIds.isEmpty() || presenterClientIds.size > 16 || presenterClientIds.any { it.isEmpty() })
            throw CloudIdentityException()
        keys = runCatching { Json.parseToJsonElement(jwks).jsonObject["keys"]!!.jsonArray }
            .getOrElse { throw CloudIdentityException() }
        if (keys.isEmpty() || keys.size > 32) throw CloudIdentityException()
    }

    fun verify(token: String, nonce: String, now: Long = System.currentTimeMillis() / 1000): VerifiedGoogleIdentity {
        try {
            if (token.toByteArray().size > 16_384) throw CloudIdentityException()
            val parts = token.split('.')
            if (parts.size != 3) throw CloudIdentityException()
            val header = Json.parseToJsonElement(cloudDecodeBase64Url(parts[0]).toString(Charsets.UTF_8)).jsonObject
            if (text(header, "alg") != "RS256") throw CloudIdentityException()
            val kid = text(header, "kid") ?: throw CloudIdentityException()
            val key = keys.map { it.jsonObject }.singleOrNull { text(it, "kid") == kid }
                ?: throw CloudIdentityException()
            if (text(key, "kty") != "RSA" || (key.containsKey("alg") && text(key, "alg") != "RS256") ||
                (key.containsKey("use") && text(key, "use") != "sig")) throw CloudIdentityException()
            val n = cloudDecodeBase64Url(text(key, "n") ?: throw CloudIdentityException())
            val e = cloudDecodeBase64Url(text(key, "e") ?: throw CloudIdentityException())
            if (n.size !in 256..512 || e.size > 8 || (e.last().toInt() and 1) != 1) throw CloudIdentityException()
            val publicKey = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(BigInteger(1, n), BigInteger(1, e)))
            val signature = Signature.getInstance("SHA256withRSA")
            signature.initVerify(publicKey)
            signature.update("${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII))
            if (!signature.verify(cloudDecodeBase64Url(parts[2]))) throw CloudIdentityException()
            val claims = Json.parseToJsonElement(cloudDecodeBase64Url(parts[1]).toString(Charsets.UTF_8)).jsonObject
            if (text(claims, "iss") !in setOf("https://accounts.google.com", "accounts.google.com")) throw CloudIdentityException()
            val subject = text(claims, "sub") ?: throw CloudIdentityException()
            if (subject.isEmpty() || subject.toByteArray().size > 255) throw CloudIdentityException()
            val aud = claims["aud"] ?: throw CloudIdentityException()
            val audiences = if (aud is JsonArray) aud.map { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content
                ?: throw CloudIdentityException() } else listOf(text(claims, "aud") ?: throw CloudIdentityException())
            if (audiences.none { it in clientIds } || (claims.containsKey("azp") && text(claims, "azp") !in presenterClientIds))
                throw CloudIdentityException()
            val exp = number(claims, "exp")
            val issued = number(claims, "iat")
            if (exp <= now || issued > now || issued < now - 3600 || text(claims, "nonce") != nonce)
                throw CloudIdentityException()
            return VerifiedGoogleIdentity(subject, exp, issued)
        } catch (_: Exception) { throw CloudIdentityException() }
    }

    private fun text(value: JsonObject, key: String): String? =
        (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun number(value: JsonObject, key: String): Long =
        (value[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: throw CloudIdentityException()
}

@Serializable
data class GoogleGatewayBinding(val gatewayId: String, val publicOrigin: String, val certificate: String, val identityToken: String) {
    fun verifiedFingerprint(owner: VerifiedGoogleIdentity, gatewayVerifier: GoogleIdentityVerifier,
                            now: Long = System.currentTimeMillis() / 1000): String {
        try {
            val fingerprint = candidateFingerprint(now)
            val nonce = cloudDigestUrl(cloudTranscript(listOf("omnesis-gateway-tls-v2", gatewayId, candidateOrigin(), fingerprint)))
            if (gatewayVerifier.verify(identityToken, nonce, now).subject != owner.subject) throw CloudIdentityException()
            return fingerprint
        } catch (_: Exception) { throw CloudIdentityException() }
    }

    /** Directory parsing supplies only an untrusted candidate for independent code comparison. */
    fun candidateOrigin(): String {
        try {
            if (!Regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$").matches(gatewayId) ||
                publicOrigin.length > 2048 || certificate.toByteArray().size > 16_384) throw CloudIdentityException()
            val uri = URI(publicOrigin)
            val host = uri.host?.lowercase(Locale.ROOT) ?: throw CloudIdentityException()
            if (uri.scheme != "https" || uri.userInfo != null || uri.query != null || uri.fragment != null ||
                uri.path !in listOf("", "/") || host.length > 253 || !host.contains('.') || Regex("^[0-9.]+$").matches(host) ||
                !host.split('.').all { Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$").matches(it) } ||
                !(uri.port == -1 || uri.port in 1..65535)) throw CloudIdentityException()
            val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
            return "https://$host$port"
        } catch (_: Exception) { throw CloudIdentityException() }
    }

    fun candidateSpkiFingerprint(now: Long = System.currentTimeMillis() / 1000): String {
        candidateFingerprint(now)
        val parsed = java.security.cert.CertificateFactory.getInstance("X.509")
            .generateCertificate(certificate.byteInputStream(Charsets.US_ASCII)) as java.security.cert.X509Certificate
        return cloudSha256(parsed.publicKey.encoded).joinToString("") { "%02x".format(it) }
    }

    fun candidateFingerprint(now: Long = System.currentTimeMillis() / 1000): String {
        try {
            candidateOrigin()
            val pem = certificate.trim()
            if (!pem.startsWith("-----BEGIN CERTIFICATE-----") || !pem.endsWith("-----END CERTIFICATE-----"))
                throw CloudIdentityException()
            val encoded = pem.removePrefix("-----BEGIN CERTIFICATE-----").removeSuffix("-----END CERTIFICATE-----").filterNot { it.isWhitespace() }
            if (!Regex("^[A-Za-z0-9+/]+={0,2}$").matches(encoded)) throw CloudIdentityException()
            val der = Base64.getDecoder().decode(encoded)
            val stream = ByteArrayInputStream(der)
            val cert = CertificateFactory.getInstance("X.509").generateCertificate(stream) as X509Certificate
            if (stream.available() != 0 || !cert.encoded.contentEquals(der)) throw CloudIdentityException()
            cert.checkValidity(Date(Math.multiplyExact(now, 1000)))
            val hostname = URI(candidateOrigin()).host
            if (!GatewayTrustPolicy.matchesHostname(cert, hostname)) throw CloudIdentityException()
            return cloudSha256(der).joinToString("") { "%02x".format(it) }
        } catch (_: Exception) { throw CloudIdentityException() }
    }
}

internal fun cloudTranscript(values: List<String>): ByteArray = JsonArray(values.map { JsonPrimitive(it) }).toString().toByteArray(Charsets.UTF_8)
internal fun cloudSha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)
internal fun cloudDigestUrl(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(cloudSha256(value))
internal fun cloudDecodeBase64Url(value: String): ByteArray {
    if (value.isEmpty() || value.length > 32768 || value.length % 4 == 1 || !Regex("^[A-Za-z0-9_-]+$").matches(value))
        throw CloudIdentityException()
    return Base64.getUrlDecoder().decode(value)
}

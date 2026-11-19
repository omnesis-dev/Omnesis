// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64

/** Signs Google-shaped ID tokens with a key made for the test run, and serves its JWKS. */
internal object EphemeralGoogleSigner {
    private val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private fun encode(value: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(value)
    private fun unsigned(value: java.math.BigInteger) = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
    val jwks: String get() {
        val key = pair.public as RSAPublicKey
        return buildJsonObject { putJsonArray("keys") { add(buildJsonObject {
            put("kty", "RSA"); put("kid", "ephemeral-fixture"); put("alg", "RS256"); put("use", "sig")
            put("n", encode(unsigned(key.modulus))); put("e", encode(unsigned(key.publicExponent)))
        }) } }.toString()
    }
    fun token(nonce: String, audience: String, clock: Long, presenter: String? = null): String {
        val header = buildJsonObject { put("alg", "RS256"); put("kid", "ephemeral-fixture") }
        val claims = buildJsonObject {
            put("iss", "https://accounts.google.com"); put("sub", "fictional-owner"); put("aud", audience)
            put("iat", clock - 60); put("exp", clock + 3600); put("nonce", nonce)
            if (presenter != null) put("azp", presenter)
        }
        val payload = encode(header.toString().toByteArray()) + "." + encode(claims.toString().toByteArray())
        val signer = Signature.getInstance("SHA256withRSA").apply { initSign(pair.private); update(payload.toByteArray(Charsets.US_ASCII)) }
        return payload + "." + encode(signer.sign())
    }
}

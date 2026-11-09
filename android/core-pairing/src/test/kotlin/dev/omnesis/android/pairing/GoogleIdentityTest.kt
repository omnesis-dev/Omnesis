// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64

class GoogleIdentityTest {
    private val root = Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("cloud-identity-vectors.json")!!.bufferedReader().use { it.readText() }).jsonObject
    private val clock = root["clock"]!!.jsonPrimitive.long
    private val nonce = root["clientNonce"]!!.jsonPrimitive.content
    private val tokens = root["tokens"]!!.jsonObject
    private val clientIds = root["clientIds"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
    private val gatewayIds = root["gatewayClientIds"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
    private val verifier get() = GoogleIdentityVerifier(root["jwks"].toString(), clientIds)
    private val gatewayVerifier get() = GoogleIdentityVerifier(root["jwks"].toString(), gatewayIds)
    private fun token(name: String) = tokens[name]!!.jsonPrimitive.content
    private fun binding(): GoogleGatewayBinding = Json.decodeFromJsonElement(root["gateway"]!!)

    @Test fun `independently verifies Google signatures and keeps gateway attestation separate from web sign-in`() {
        val owner = verifier.verify(token("validClient"), nonce, clock)
        assertEquals(root["subject"]!!.jsonPrimitive.content, owner.subject)
        assertEquals(root["accountId"]!!.jsonPrimitive.content, owner.accountId)
        val request = root["request"]!!.jsonObject
        val challenge = CloudPairingChallenge.create(request["name"]!!.jsonPrimitive.content,
            request["requestId"]!!.jsonPrimitive.content, request["secret"]!!.jsonPrimitive.content)
        // The shared vectors' `verificationCode` is the retired 80-bit code; PairingCodeTest holds the current vectors.
        assertEquals(64, challenge.secret.length)
        for (element in root["nonceVectors"]!!.jsonArray) {
            val vector = element.jsonObject
            if (vector["kind"]!!.jsonPrimitive.content != "android") continue
            assertEquals(vector["name"]!!.jsonPrimitive.content, vector["nonce"]!!.jsonPrimitive.content,
                CloudPairingChallenge.create(vector["name"]!!.jsonPrimitive.content,
                    request["requestId"]!!.jsonPrimitive.content, request["secret"]!!.jsonPrimitive.content).nonce)
        }
        assertEquals(root["fingerprint"]!!.jsonPrimitive.content, binding().verifiedFingerprint(owner, gatewayVerifier, clock))
        assertEquals(owner.subject, gatewayVerifier.verify(binding().identityToken, root["gatewayNonce"]!!.jsonPrimitive.content, clock).subject)
        assertThrows(CloudIdentityException::class.java) { binding().verifiedFingerprint(owner, verifier, clock) }
        assertThrows(CloudIdentityException::class.java) { gatewayVerifier.verify(token("validClient"), nonce, clock) }
        verifier.verify(token("multipleAudiences"), nonce, clock)
    }
    @Test fun `wrong issuer audience subject nonce and expired or future tokens cannot authenticate`() {
        for (name in listOf("wrongIssuer", "wrongAudience", "wrongNonce", "expired", "futureIssued", "oldIssued", "missingSubject", "missingNonce", "unauthorizedParty")) {
            assertThrows(name, CloudIdentityException::class.java) { verifier.verify(token(name), nonce, clock) }
        }
        val owner = verifier.verify(token("validClient"), nonce, clock)
        assertThrows(CloudIdentityException::class.java) {
            binding().copy(identityToken = token("wrongGatewayOwner")).verifiedFingerprint(owner, gatewayVerifier, clock)
        }
    }
    @Test fun `route or certificate substitution cannot reuse a signed gateway binding`() {
        val owner = verifier.verify(token("validClient"), nonce, clock)
        for (origin in listOf(binding().publicOrigin + ":8443", "http://gateway.example.test", "https://user@gateway.example.test",
            "https://gateway.example.test/path", "https://gateway.example.test?query", "https://gateway.example.test#fragment", "https://bad_.example.test",
            "https://localhost", "https://a..example.test", "invalid")) {
            assertThrows(origin, CloudIdentityException::class.java) { binding().copy(publicOrigin = origin).verifiedFingerprint(owner, gatewayVerifier, clock) }
        }
        for (cert in listOf("invalid", "-----BEGIN CERTIFICATE-----invalid-----END CERTIFICATE-----", "x".repeat(17000))) {
            assertThrows(CloudIdentityException::class.java) { binding().copy(certificate = cert).verifiedFingerprint(owner, gatewayVerifier, clock) }
        }
    }
    @Test fun `malformed and unsigned tokens and unbounded key sets are refused`() {
        val valid = token("validClient")
        for (candidate in listOf("", "a.b", "a.b.c.d", "a..c", "***.x.x", "a".repeat(17000), valid.dropLast(4) + "AAAA")) {
            assertThrows(CloudIdentityException::class.java) { verifier.verify(candidate, nonce, clock) }
        }
        for (keys in listOf("{}", "{\"keys\":[]}", " ".repeat(65537))) {
            assertThrows(CloudIdentityException::class.java) { GoogleIdentityVerifier(keys, clientIds) }
        }
        assertThrows(CloudIdentityException::class.java) { GoogleIdentityVerifier(root["jwks"].toString(), emptySet()) }
        assertThrows(CloudIdentityException::class.java) { cloudDecodeBase64Url("a") }
        assertThrows(CloudIdentityException::class.java) { cloudDecodeBase64Url("a=") }
    }
    @Test fun `duplicate signing keys and certificate validity or SAN mismatch are rejected`() {
        val keys = root["jwks"]!!.jsonObject["keys"]!!.jsonArray
        val duplicate = buildJsonObject { put("keys", JsonArray(keys + keys)) }
        assertThrows(CloudIdentityException::class.java) { GoogleIdentityVerifier(duplicate.toString(), clientIds).verify(token("validClient"), nonce, clock) }
        assertThrows(CloudIdentityException::class.java) { binding().candidateFingerprint(clock - 86_400) }
        assertThrows(CloudIdentityException::class.java) { binding().candidateFingerprint(clock + 20L * 365 * 86_400) }
        assertThrows(CloudIdentityException::class.java) { binding().copy(publicOrigin = "https://other.example.test").candidateFingerprint(clock) }
    }

    @Test fun `signed hostile claims never authenticate while trusted Android presenters remain distinct from audiences`() {
        val signer = IdentitySigner()
        val verifier = GoogleIdentityVerifier(signer.jwks(), setOf("fictional-web"), setOf("fictional-web", "fictional-android"))
        val claims = signer.claims(clock, nonce)
        assertEquals("fictional-owner", verifier.verify(signer.sign(claims), nonce, clock).subject)
        assertEquals(clock + 3600, verifier.verify(signer.sign(claims), nonce, clock).expiresAt)
        val actualClock = System.currentTimeMillis() / 1000
        assertEquals(actualClock + 3600, verifier.verify(signer.sign(signer.claims(actualClock, nonce)), nonce).expiresAt)
        verifier.verify(signer.sign(JsonObject(claims + ("azp" to JsonPrimitive("fictional-android")))), nonce, clock)
        for ((field, value) in listOf(
            "iss" to JsonPrimitive("wrong-issuer"), "iss" to JsonPrimitive(1), "sub" to JsonNull,
            "sub" to JsonPrimitive(""), "sub" to JsonPrimitive("x".repeat(256)),
            "aud" to JsonPrimitive(1), "aud" to JsonNull, "aud" to JsonObject(emptyMap()),
            "aud" to JsonArray(listOf(JsonPrimitive("fictional-web"), JsonPrimitive(1))),
            "aud" to JsonArray(listOf(JsonPrimitive("fictional-web"), JsonObject(emptyMap()))),
            "aud" to JsonArray(emptyList()), "aud" to JsonPrimitive("fictional-android"),
            "azp" to JsonPrimitive("foreign-android"), "azp" to JsonPrimitive(1),
            "exp" to JsonPrimitive("tomorrow"), "exp" to JsonPrimitive(true), "exp" to JsonNull,
            "iat" to JsonPrimitive("now"), "iat" to JsonNull, "nonce" to JsonPrimitive(1),
        )) {
            assertThrows(field + ":" + value, CloudIdentityException::class.java) {
                verifier.verify(signer.sign(JsonObject(claims + (field to value))), nonce, clock)
            }
        }
        for (field in listOf("iss", "sub", "aud", "iat", "exp", "nonce")) {
            assertThrows(field, CloudIdentityException::class.java) { verifier.verify(signer.sign(JsonObject(claims - field)), nonce, clock) }
        }
        for (payload in listOf("invalid", "[]", "null", "{\"exp\":true}")) {
            assertThrows(CloudIdentityException::class.java) { verifier.verify(signer.signRaw(payload), nonce, clock) }
        }
        val alternate = JsonObject(claims + ("iss" to JsonPrimitive("accounts.google.com")) +
            ("aud" to JsonArray(listOf(JsonPrimitive("untrusted"), JsonPrimitive("fictional-web")))))
        verifier.verify(signer.sign(alternate), nonce, clock)
    }

    @Test fun `malformed and attacker selected JWK fields cannot replace a signing key`() {
        val signer = IdentitySigner(); val token = signer.sign(signer.claims(clock, nonce))
        for (header in listOf("invalid", "null", "[]", "{}", "{\"alg\":\"HS256\",\"kid\":\"test-key\"}",
            "{\"alg\":\"RS256\",\"kid\":1}", "{\"alg\":\"RS256\",\"kid\":\"missing-key\"}")) {
            assertThrows(CloudIdentityException::class.java) {
                GoogleIdentityVerifier(signer.jwks(), clientIds).verify(signer.signRaw("{}", header), nonce, clock)
            }
        }
        for ((field, value) in listOf(
            "kty" to JsonPrimitive("EC"), "alg" to JsonPrimitive("HS256"), "use" to JsonPrimitive("enc"),
            "n" to JsonNull, "e" to JsonNull, "n" to JsonPrimitive(1), "e" to JsonPrimitive(1),
            "n" to JsonPrimitive("***"), "e" to JsonPrimitive("***"),
            "n" to JsonPrimitive(signer.encode(ByteArray(255))), "n" to JsonPrimitive(signer.encode(ByteArray(513))),
            "e" to JsonPrimitive(""), "e" to JsonPrimitive(signer.encode(ByteArray(9) { 1 })),
            "e" to JsonPrimitive(signer.encode(byteArrayOf(2))),
            "n" to JsonPrimitive(signer.encode(ByteArray(256))),
        )) {
            val key = JsonObject(signer.jwk + (field to value))
            assertThrows(field + ":" + value, CloudIdentityException::class.java) {
                GoogleIdentityVerifier(signer.jwks(listOf(key)), setOf("fictional-web")).verify(token, nonce, clock)
            }
        }
        for (field in listOf("n", "e")) {
            assertThrows(CloudIdentityException::class.java) {
                GoogleIdentityVerifier(signer.jwks(listOf(JsonObject(signer.jwk - field))), setOf("fictional-web")).verify(token, nonce, clock)
            }
        }
        GoogleIdentityVerifier(signer.jwks(listOf(JsonObject(signer.jwk - "alg" - "use"))), setOf("fictional-web")).verify(token, nonce, clock)
        for (badKeys in listOf("[]", "null", "{\"keys\":null}", "{\"keys\":[1]}",
            signer.jwks(List(33) { signer.jwk }))) {
            assertThrows(CloudIdentityException::class.java) {
                GoogleIdentityVerifier(badKeys, setOf("fictional-web")).verify(token, nonce, clock)
            }
        }
        for (ids in listOf(setOf(""), (1..17).map { "fictional-$it" }.toSet())) {
            assertThrows(CloudIdentityException::class.java) { GoogleIdentityVerifier(signer.jwks(), ids) }
        }
        for (presenters in listOf(emptySet(), setOf(""), (1..17).map { "fictional-$it" }.toSet())) {
            assertThrows(CloudIdentityException::class.java) { GoogleIdentityVerifier(signer.jwks(), setOf("fictional-web"), presenters) }
        }
        assertThrows(CloudIdentityException::class.java) { cloudDecodeBase64Url("") }
        assertThrows(CloudIdentityException::class.java) { cloudDecodeBase64Url("a".repeat(32769)) }
    }

    @Test fun `candidate parsing rejects credential URLs numeric hosts oversized fields and noncanonical certificate bundles`() {
        val binding = binding()
        for (origin in listOf("https://127.0.0.1", "https://gateway.example.test:0", "https://gateway.example.test:65536",
            "https://" + List(5) { "a".repeat(60) }.joinToString("."), "https://" + "a".repeat(64) + ".test", "https://x.test/" + "a".repeat(2048))) {
            assertThrows(origin, CloudIdentityException::class.java) { binding.copy(publicOrigin = origin).candidateFingerprint(clock) }
        }
        assertThrows(CloudIdentityException::class.java) { binding.copy(gatewayId = "invalid").candidateOrigin() }
        for (certificate in listOf("-----BEGIN CERTIFICATE-----AA==", "AA==-----END CERTIFICATE-----",
            "-----BEGIN CERTIFICATE----------END CERTIFICATE-----", binding.certificate + binding.certificate,
            "-----BEGIN CERTIFICATE-----AA==-----END CERTIFICATE-----")) {
            assertThrows(CloudIdentityException::class.java) { binding.copy(certificate = certificate).candidateFingerprint(clock) }
        }
        val encoded = binding.certificate.replace("-----BEGIN CERTIFICATE-----", "").replace("-----END CERTIFICATE-----", "").filterNot { it.isWhitespace() }
        val der = Base64.getDecoder().decode(encoded)
        val extra = "-----BEGIN CERTIFICATE-----\n" + Base64.getEncoder().encodeToString(der + byteArrayOf(0)) + "\n-----END CERTIFICATE-----"
        assertThrows(CloudIdentityException::class.java) { binding.copy(certificate = extra).candidateFingerprint(clock) }
        // BER permits an indefinite outer sequence; the public leaf protocol requires exact canonical DER.
        val lengthOctets = if ((der[1].toInt() and 128) == 0) 0 else der[1].toInt() and 127
        val ber = byteArrayOf(0x30, 0x80.toByte()) + der.copyOfRange(2 + lengthOctets, der.size) + byteArrayOf(0, 0)
        val indefinite = "-----BEGIN CERTIFICATE-----\n" + Base64.getEncoder().encodeToString(ber) + "\n-----END CERTIFICATE-----"
        assertThrows(CloudIdentityException::class.java) { binding.copy(certificate = indefinite).candidateFingerprint(clock) }
        assertThrows(CloudIdentityException::class.java) { binding.candidateFingerprint(Long.MAX_VALUE) }
        val host = java.net.URI(binding.publicOrigin).host
        assertEquals(binding.publicOrigin, binding.copy(publicOrigin = "https://${host.uppercase(java.util.Locale.ROOT)}:443/").candidateOrigin())
        assertEquals("https://$host:8443", binding.copy(publicOrigin = "https://$host:8443").candidateOrigin())
        val insecure = binding.copy(publicOrigin = "http://gateway.example.test")
        assertThrows(CloudIdentityException::class.java) { insecure.candidateFingerprint() }
        val owner = verifier.verify(token("validClient"), nonce, clock)
        assertThrows(CloudIdentityException::class.java) { insecure.verifiedFingerprint(owner, gatewayVerifier) }
    }
}

/** Fresh test-only RSA material signs negative claims without retaining a private fixture key. */
private class IdentitySigner {
    private val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    fun encode(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value)
    private fun unsigned(value: java.math.BigInteger) = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
    val jwk: JsonObject = (pair.public as RSAPublicKey).let { key -> buildJsonObject {
        put("kty", "RSA"); put("kid", "test-key"); put("alg", "RS256"); put("use", "sig")
        put("n", encode(unsigned(key.modulus))); put("e", encode(unsigned(key.publicExponent)))
    } }
    fun jwks(keys: List<JsonElement> = listOf(jwk)) = buildJsonObject { put("keys", JsonArray(keys)) }.toString()
    fun claims(clock: Long, nonce: String) = buildJsonObject {
        put("iss", "https://accounts.google.com"); put("sub", "fictional-owner"); put("aud", "fictional-web")
        put("iat", clock); put("exp", clock + 3600); put("nonce", nonce)
    }
    fun sign(claims: JsonObject) = signRaw(claims.toString())
    fun signRaw(payload: String, header: String = "{\"alg\":\"RS256\",\"kid\":\"test-key\"}"): String {
        val signingInput = encode(header.toByteArray()) + "." + encode(payload.toByteArray())
        val signer = Signature.getInstance("SHA256withRSA").apply { initSign(pair.private); update(signingInput.toByteArray(Charsets.US_ASCII)) }
        return signingInput + "." + encode(signer.sign())
    }
}

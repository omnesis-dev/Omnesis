// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.pairing.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64

/** Exercises our app adapter with the real signed-token client and real comparison/payload gates. */
class GooglePairingSessionTest {
    @Test fun `app session forwards verified discovery comparison polling and strict payload without losing trust`() = runTest {
        val clock = System.currentTimeMillis() / 1000
        val clientId = "synthetic.apps.googleusercontent.com"
        val challenge = CloudPairingChallenge.create("Synthetic phone")
        val cert = HeldCertificate.Builder().commonName("gateway.example.com").addSubjectAlternativeName("gateway.example.com").build()
        val candidate = GoogleGatewayBinding("00000000-0000-4000-8000-000000000001", "https://gateway.example.com", cert.certificatePem(), "untrusted-directory-marker")
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        fun encode(value: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(value)
        fun unsigned(value: java.math.BigInteger) = encode(value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray())
        val key = pair.public as RSAPublicKey
        val jwks = buildJsonObject { putJsonArray("keys") { add(buildJsonObject {
            put("kid", "temporary"); put("kty", "RSA"); put("n", unsigned(key.modulus)); put("e", unsigned(key.publicExponent))
        }) } }.toString()
        val header = """{"alg":"RS256","kid":"temporary"}"""
        val claims = buildJsonObject {
            put("iss", "https://accounts.google.com"); put("sub", "synthetic-owner"); put("aud", clientId)
            put("iat", clock); put("exp", clock + 300); put("nonce", challenge.nonce)
        }.toString()
        val input = encode(header.toByteArray()) + "." + encode(claims.toByteArray())
        val token = input + "." + encode(Signature.getInstance("SHA256withRSA").run {
            initSign(pair.private); update(input.toByteArray()); sign()
        })
        val fingerprint = candidate.candidateFingerprint(clock)
        var closed = 0
        fun transport(handler: (String) -> String) = object : CloudPairingTransport {
            override suspend fun request(url: String, body: String?, bearer: String?) = handler(url)
            override fun close() { closed++ }
        }
        val direct = transport { url -> when {
            url.endsWith("/certs") -> jwks
            url.endsWith("/login") -> buildJsonObject {
                put("accountId", VerifiedGoogleIdentity("synthetic-owner", clock + 300).accountId); put("token", "routing-only")
            }.toString()
            else -> Json.encodeToString(candidate)
        } }
        val gateway = transport { url -> Json.encodeToString(CloudPairingProgress(
            if (url.endsWith("/poll")) "approved" else "pending", challenge.verificationCode(fingerprint),
            (clock + 300) * 1000, if (url.endsWith("/poll")) "synthetic-code" else null)) }
        val session = GooglePairingSession(GoogleCloudPairingClient("https://relay.example.com", clientId, direct, {
            assertEquals(fingerprint, it); gateway
        }))
        session.start(challenge, token)
        assertEquals(challenge.verificationCode(fingerprint), session.code)
        assertEquals("gateway.example.com", session.host)
        assertFalse(session.approved)
        assertThrows(CloudPairingException::class.java) { session.payload() }
        session.compare(); assertThrows(CloudPairingException::class.java) { session.payload() }
        session.poll(); assertTrue(session.approved)
        val payload = PairingPayload.decode(session.payload()) as PairingPayload.V4
        assertEquals("synthetic-code", payload.pairingCode)
        assertEquals(candidate.candidateSpkiFingerprint(clock), (payload.tls as PairingPayload.V4Tls.PinnedKeyStrict).spkiFingerprint)
        session.close(); assertEquals(2, closed)
        // Production construction retains the dedicated audience/presenter configuration and closes offline.
        GooglePairingSession("https://relay.example.com", clientId, setOf(clientId)).close()
    }
}

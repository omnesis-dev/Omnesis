// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.tls.LeafCertPinner
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Date

class KeyPinningVectorsTest {
    private val root = Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("cloud-identity-vectors.json")!!.bufferedReader().use { it.readText() }).jsonObject
    private val vectors get() = root["spkiVectors"]!!.jsonArray.map { it.jsonObject }
    private val clock get() = root["clock"]!!.jsonPrimitive.long
    private fun certificate(value: JsonObject, field: String = "certificate"): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(value[field]!!.jsonPrimitive.content.byteInputStream(Charsets.US_ASCII)) as X509Certificate

    @Test fun `complete DER SPKI matches Node across every public key algorithm`() {
        assertEquals(setOf("RSA-2048", "EC-P256", "EC-P384", "EC-P521", "Ed25519"), vectors.map { it["algorithm"]!!.jsonPrimitive.content }.toSet())
        for (value in vectors) {
            assertEquals(value["spkiFingerprint"]!!.jsonPrimitive.content, LeafCertPinner.sha256Hex(certificate(value).publicKey.encoded))
        }
        val binding = Json.decodeFromJsonElement<GoogleGatewayBinding>(root["gateway"]!!)
        assertEquals(root["gateway"]!!.jsonObject["gatewayId"]!!.jsonPrimitive.content, binding.gatewayId)
        assertEquals(vectors.first()["spkiFingerprint"]!!.jsonPrimitive.content, binding.candidateSpkiFingerprint(clock))
        assertThrows(CloudIdentityException::class.java) {
            binding.copy(publicOrigin = "http://gateway.example.test").candidateSpkiFingerprint()
        }
    }

    @Test fun `same-key certificate renewal preserves strict trust but replacement and expired keys fail closed`() {
        val vector = vectors.first { it["algorithm"]!!.jsonPrimitive.content == "EC-P256" }
        val expected = vector["spkiFingerprint"]!!.jsonPrimitive.content
        val original = certificate(vector)
        val renewed = certificate(vector, "renewedCertificate")
        assertNotEquals(LeafCertPinner.sha256Hex(original.encoded), LeafCertPinner.sha256Hex(renewed.encoded))
        val pinned = LeafCertPinner(spkiFingerprint = expected, verificationDate = { Date(clock * 1000) })
        for (leaf in listOf(original, renewed)) pinned.trustManager.checkServerTrusted(arrayOf(leaf), "EC")
        for (field in listOf("expiredCertificate", "replacementCertificate")) {
            assertThrows(CertificateException::class.java) { pinned.trustManager.checkServerTrusted(arrayOf(certificate(vector, field)), "EC") }
        }
        val exact = LeafCertPinner(LeafCertPinner.sha256Hex(original.encoded), requireCertificateValidity = true, verificationDate = { Date(clock * 1000) })
        assertThrows(CertificateException::class.java) { exact.trustManager.checkServerTrusted(arrayOf(renewed), "EC") }
        val cannotReinterpret = LeafCertPinner(LeafCertPinner.sha256Hex(original.encoded), spkiFingerprint = "0".repeat(64), verificationDate = { Date(clock * 1000) })
        assertThrows(CertificateException::class.java) { cannotReinterpret.trustManager.checkServerTrusted(arrayOf(original), "EC") }
    }
}

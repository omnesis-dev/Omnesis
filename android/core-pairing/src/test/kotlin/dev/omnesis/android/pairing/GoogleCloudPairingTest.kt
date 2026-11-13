// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class GoogleCloudPairingTest {
    private val testNow = 1_793_880_000_000L
    private fun candidate(): GoogleGatewayBinding {
        val data = javaClass.classLoader!!.getResourceAsStream("cloud-identity-vectors.json")!!.bufferedReader().use { it.readText() }
        return Json.decodeFromJsonElement(Json.parseToJsonElement(data).jsonObject["gateway"]!!)
    }

    private val codeNonce = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk"
    private val commitment = "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs"

    /** A confirmation whose gateway committed to [codeNonce], with the reply an honest gateway sends. */
    private fun committed(name: String = "Fictional phone"): Pair<CloudPairingConfirmation, String> {
        val flow = CloudPairingConfirmation(CloudPairingChallenge.create(name), candidate(), now = testNow)
        flow.expect(commitment)
        return flow to flow.challenge.comparisonCode(flow.fingerprint, codeNonce)
    }
    private fun reply(status: String, code: String, expiresAt: Long = testNow + 100_000, pairingCode: String? = null, nonce: String = codeNonce) =
        CloudPairingProgress(status, code, expiresAt, pairingCode, nonce)

    @Test fun `remote approval cannot bypass independent local code comparison`() {
        val (flow, code) = committed()
        assertNull("no code before the gateway revealed its nonce", flow.verificationCode)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow) }
        flow.receive(reply("approved", code, pairingCode = "SYNTHETIC-CODE"), testNow)
        assertEquals(code, flow.verificationCode)
        assertTrue(PairingCode.FORMAT.matches(code))
        assertTrue(flow.approved)
        assertFalse(flow.compared)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow) }
        flow.confirmComparison()
        val payload = PairingPayload.decode(flow.pairingPayload(testNow), cloudRelay = true) as PairingPayload.V4
        assertEquals(flow.spkiFingerprint, (payload.tls as PairingPayload.V4Tls.PinnedKeyStrict).spkiFingerprint)
        assertEquals("SYNTHETIC-CODE", payload.pairingCode)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow + 100_000) }
    }

    @Test fun `local comparison cannot bypass gateway approval and wrong status codes and expiry fail closed`() {
        for (bad in listOf<(String) -> CloudPairingProgress>(
            { reply("denied", it) }, { reply("approved", it) }, { reply("approved", it, pairingCode = "") },
            { reply("approved", it, pairingCode = "x".repeat(257)) }, { reply("pending", it, expiresAt = testNow) },
        )) {
            val (flow, code) = committed()
            flow.confirmComparison()
            flow.receive(reply("pending", code), testNow)
            assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow) }
            assertThrows(CloudPairingException::class.java) { flow.receive(bad(code), testNow) }
            assertFalse(flow.approved)
        }
    }

    @Test fun `a reply whose nonce is not the one committed to aborts with no code shown`() {
        val other = "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY"
        val (flow, _) = committed()
        // A substitute gateway picks its nonce after seeing the secret, and offers the code that goes with it.
        val forged = flow.challenge.comparisonCode(flow.fingerprint, other)
        assertThrows(CloudPairingException::class.java) { flow.receive(reply("pending", forged, nonce = other), testNow) }
        assertNull(flow.verificationCode)
        // Nothing later is accepted either, an honest reply included.
        val honest = flow.challenge.comparisonCode(flow.fingerprint, codeNonce)
        assertThrows(CloudPairingException::class.java) { flow.receive(reply("approved", honest, pairingCode = "STOLEN"), testNow) }
        assertNull(flow.verificationCode); assertFalse(flow.approved)
        for (missing in listOf("", "short", codeNonce + "x")) {
            val (fresh, code) = committed()
            assertThrows(CloudPairingException::class.java) { fresh.receive(reply("pending", code, nonce = missing), testNow) }
            assertNull(fresh.verificationCode)
        }
    }

    @Test fun `a reply before any challenge was received is refused`() {
        val flow = CloudPairingConfirmation(CloudPairingChallenge.create("Phone"), candidate(), now = testNow)
        val code = flow.challenge.comparisonCode(flow.fingerprint, codeNonce)
        assertThrows(CloudPairingException::class.java) { flow.receive(reply("pending", code), testNow) }
        assertNull(flow.verificationCode)
        assertThrows(CloudPairingException::class.java) { CloudPairingConfirmation(CloudPairingChallenge.create("Phone"), candidate(), now = testNow).expect("not a challenge") }
    }

    @Test fun `a nonce that changes between polls aborts and takes the shown code away`() {
        val other = "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY"
        val (flow, code) = committed()
        flow.receive(reply("pending", code), testNow)
        assertEquals(code, flow.verificationCode)
        // The same nonce again is fine.
        flow.receive(reply("pending", code), testNow)
        val moved = flow.challenge.comparisonCode(flow.fingerprint, other)
        assertThrows(CloudPairingException::class.java) { flow.receive(reply("approved", moved, pairingCode = "STOLEN", nonce = other), testNow) }
        assertNull(flow.verificationCode); assertFalse(flow.approved)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow) }
        // A challenge cannot be swapped in after a reply was accepted.
        val (late, lateCode) = committed()
        late.receive(reply("pending", lateCode), testNow)
        assertThrows(CloudPairingException::class.java) { late.expect(PairingCode.commitment(other)) }
    }

    @Test fun `a reply whose code differs from the one computed here aborts and is never shown`() {
        for (wrong in listOf("000 000", "FAKE-CODE", "", "465774")) {
            val (flow, code) = committed()
            if (wrong == code) continue
            assertThrows(CloudPairingException::class.java) { flow.receive(reply("approved", wrong, pairingCode = "STOLEN"), testNow) }
            assertNull(flow.verificationCode); assertFalse(flow.approved)
        }
    }

    @Test fun `the code binds candidate certificate, private challenge and the gateway's nonce`() {
        val a = CloudPairingChallenge.create("Phone", "00000000-0000-4000-8000-000000000001", "17".repeat(32))
        val b = CloudPairingChallenge.create("Phone", a.requestId, "18".repeat(32))
        val code = a.comparisonCode("a".repeat(64), codeNonce)
        assertTrue(PairingCode.FORMAT.matches(code))
        assertNotEquals(code, a.comparisonCode("b".repeat(64), codeNonce))
        assertNotEquals(code, b.comparisonCode("a".repeat(64), codeNonce))
        assertNotEquals(code, a.comparisonCode("a".repeat(64), "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY"))
        assertNotEquals(a.nonce, b.nonce)
        assertThrows(CloudPairingException::class.java) { a.comparisonCode("invalid", codeNonce) }
        assertThrows(CloudPairingException::class.java) { a.comparisonCode("a".repeat(64), "short") }
        assertThrows(CloudPairingException::class.java) { CloudPairingChallenge.create(" ") }
        assertThrows(CloudPairingException::class.java) { CloudPairingChallenge.create("Phone", "invalid") }
        assertThrows(CloudPairingException::class.java) { CloudPairingChallenge.create("Phone", secret = "short") }
    }

    @Test fun `provisional directory parsing never establishes authentication and rejects malformed origin or PEM bundles`() {
        val original = candidate()
        val stale = original.copy(identityToken = "expired-or-forged")
        assertEquals(original.candidateFingerprint(testNow / 1000), stale.candidateFingerprint(testNow / 1000))
        val flow = CloudPairingConfirmation(CloudPairingChallenge.create("Phone"), stale, now = testNow)
        assertFalse(flow.compared)
        assertFalse(flow.approved)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload() }
        for (origin in listOf("https://127.0.0.1", "http://gateway.example.test", "https://user@gateway.example.test", "https://gateway.example.test/path")) {
            assertThrows(CloudIdentityException::class.java) { original.copy(publicOrigin = origin).candidateFingerprint() }
        }
        assertThrows(CloudIdentityException::class.java) { original.copy(certificate = original.certificate + original.certificate).candidateFingerprint() }
    }
    @Test fun `challenge rejects long UTF16 names and noncanonical UUIDs`() {
        for (name in listOf("x".repeat(81), "😀".repeat(41))) {
            assertThrows(CloudPairingException::class.java) { CloudPairingChallenge.create(name) }
        }
        assertThrows(CloudPairingException::class.java) {
            CloudPairingChallenge.create("Phone", "ABCDEFAB-0000-4000-8000-000000000001")
        }
        assertEquals(80, CloudPairingChallenge.create("😀".repeat(40)).name.length)
    }

    @Test fun `expired local challenge rejects even remotely extended approval`() {
        val flow = CloudPairingConfirmation(CloudPairingChallenge.create("Phone"), candidate(), now = testNow)
        assertThrows(CloudPairingException::class.java) {
            flow.expect(commitment)
            flow.receive(reply("approved", flow.challenge.comparisonCode(flow.fingerprint, codeNonce), testNow + 900_000, "SYNTHETIC"), testNow + 600_000)
        }
        assertFalse(flow.approved)
    }

    @Test fun `default clock entry points preserve validation and challenge exposes Android wire kind`() {
        val challenge = CloudPairingChallenge.create("Phone")
        assertEquals("android", challenge.kind)
        assertThrows(CloudIdentityException::class.java) {
            CloudPairingConfirmation(challenge, candidate().copy(publicOrigin = "http://gateway.example.test"))
        }
        val flow = CloudPairingConfirmation(challenge, candidate(), now = testNow)
        assertThrows(CloudPairingException::class.java) {
            flow.receive(reply("pending", flow.challenge.comparisonCode(flow.fingerprint, codeNonce), 0))
        }
        flow.confirmComparison()
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload() }
    }

}

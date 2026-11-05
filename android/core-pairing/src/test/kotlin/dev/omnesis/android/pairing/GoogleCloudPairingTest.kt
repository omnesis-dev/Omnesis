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

    @Test fun `remote approval cannot bypass independent local code comparison`() {
        val flow = CloudPairingConfirmation(CloudPairingChallenge.create("Fictional phone"), candidate(), now = testNow)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow) }
        flow.receive(CloudPairingProgress("approved", flow.verificationCode, testNow + 100_000, "SYNTHETIC-CODE"), testNow)
        assertTrue(flow.approved)
        assertFalse(flow.compared)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow) }
        flow.confirmComparison()
        val payload = PairingPayload.decode(flow.pairingPayload(testNow)) as PairingPayload.V4
        assertEquals(flow.spkiFingerprint, (payload.tls as PairingPayload.V4Tls.PinnedKeyStrict).spkiFingerprint)
        assertEquals("SYNTHETIC-CODE", payload.pairingCode)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow + 100_000) }
    }

    @Test fun `local comparison cannot bypass gateway approval and wrong status codes and expiry fail closed`() {
        val flow = CloudPairingConfirmation(CloudPairingChallenge.create("Fictional phone"), candidate(), now = testNow)
        flow.confirmComparison()
        flow.receive(CloudPairingProgress("pending", flow.verificationCode, testNow + 100_000), testNow)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(testNow) }
        for (status in listOf(CloudPairingProgress("denied", flow.verificationCode, testNow + 100_000),
            CloudPairingProgress("approved", flow.verificationCode, testNow + 100_000),
            CloudPairingProgress("approved", flow.verificationCode, testNow + 100_000, ""),
            CloudPairingProgress("approved", flow.verificationCode, testNow + 100_000, "x".repeat(257)),
            CloudPairingProgress("approved", "FAKE-CODE", testNow + 100_000, "STOLEN"),
            CloudPairingProgress("pending", flow.verificationCode, testNow))) {
            assertThrows(CloudPairingException::class.java) { flow.receive(status, testNow) }
        }
        assertFalse(flow.approved)
    }

    @Test fun `SAS binds candidate certificate and private challenge`() {
        val a = CloudPairingChallenge.create("Phone", "00000000-0000-4000-8000-000000000001", "17".repeat(32))
        val b = CloudPairingChallenge.create("Phone", a.requestId, "18".repeat(32))
        val code = a.verificationCode("a".repeat(64))
        assertEquals(24, code.length)
        assertNotEquals(code, a.verificationCode("b".repeat(64)))
        assertNotEquals(code, b.verificationCode("a".repeat(64)))
        assertNotEquals(a.nonce, b.nonce)
        assertThrows(CloudPairingException::class.java) { a.verificationCode("invalid") }
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
            flow.receive(CloudPairingProgress("approved", flow.verificationCode, testNow + 900_000, "SYNTHETIC"), testNow + 600_000)
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
            flow.receive(CloudPairingProgress("pending", flow.verificationCode, 0))
        }
        flow.confirmComparison()
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload() }
    }

}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.GatewayPasskeyCeremony
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

/** A passkey provider's assertion JSON, as Credential Manager returns it, with the client data the platform signed. */
internal fun fakeAssertion(challenge: String, origin: String, clientData: JsonObjectBuilder.() -> Unit = {}): String {
    val data = buildJsonObject { put("type", "webauthn.get"); put("challenge", challenge); put("origin", origin); put("crossOrigin", false); clientData() }
    val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(data.toString().toByteArray())
    return """{"id":"cred","rawId":"cred","type":"public-key","authenticatorAttachment":"platform","clientExtensionResults":{},"vendorExtra":1,""" +
        """"response":{"clientDataJSON":"$encoded","authenticatorData":"e30","signature":"e30","userHandle":"dXNlcg","transports":["internal"]}}"""
}

/** The challenge a WebAuthn request option names. */
internal fun requestedChallenge(options: String): String = Json.parseToJsonElement(options).jsonObject["challenge"]!!.jsonPrimitive.content

class GatewayPasskeySignerTest {
    private val now = 1_793_880_000_000L
    private val rpId = "relay.example.test"
    private val app = "android:apk-key-hash:TPfeOsd2u2Uq8rCtF9DeGgc1m50jt6fPpDJYcUvAaCo"
    private val gatewayChallenge = "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw"
    private val approvalBinding = "l0NtUMoLWQPEqbViKuTTcNl21YlGfRT9uywbHtmcvzg"
    /** The gateway's own `webauthnChallenge`, for its web page's origin: never what the app signs. */
    private val pageChallenge = "s4TEruSndQL9XUX4vOZB8gLvPAjWmLWDn4hs6rqiev8"
    private fun ceremony(
        purpose: String = "approve-request", rpId: String = this.rpId, challenge: String = gatewayChallenge,
        binding: String = approvalBinding, expiresAt: Long = now + 180_000,
    ) = GatewayPasskeyCeremony(purpose, rpId, "https://g-abcdefgh.relay.example.test", challenge, binding, pageChallenge, expiresAt)

    private class Prompt(val answer: (String) -> String) {
        val options = mutableListOf<String>()
        suspend fun acquire(value: String): String { options += value; return answer(value) }
    }
    private fun signer(prompt: Prompt) = GatewayPasskeySigner(rpId, app, { now }, prompt::acquire)
    private val honest get() = Prompt { fakeAssertion(requestedChallenge(it), app) }

    @Test fun `an approval signs the gateway's value with the app's own origin, never the page's`(): Unit = runBlocking {
        val prompt = honest
        val proof = signer(prompt).approval(ceremony())
        val options = Json.parseToJsonElement(prompt.options.single()).jsonObject
        // The vector from DeviceEnrollmentContractTest: approve-request, the app's origin.
        assertEquals("Ya-uH3WpYI-yOGaMvUJTWj7vlpoa1QppRbGipQO4dyU", options["challenge"]!!.jsonPrimitive.content)
        assertNotEquals(pageChallenge, options["challenge"]!!.jsonPrimitive.content)
        assertEquals(rpId, options["rpId"]!!.jsonPrimitive.content)
        assertEquals("required", options["userVerification"]!!.jsonPrimitive.content)
        assertEquals(setOf("type", "challenge", "credential"), proof.keys)
        assertEquals("gateway-passkey", proof["type"]!!.jsonPrimitive.content)
        assertEquals(gatewayChallenge, proof["challenge"]!!.jsonPrimitive.content)
        val credential = proof["credential"]!!.jsonObject
        assertEquals(setOf("id", "rawId", "type", "authenticatorAttachment", "clientExtensionResults", "response"), credential.keys)
        assertEquals(setOf("clientDataJSON", "authenticatorData", "signature", "userHandle"), credential["response"]!!.jsonObject.keys)
    }

    @Test fun `an enrollment binds the device's own nonce to the gateway's challenge`(): Unit = runBlocking {
        val prompt = honest
        val nonce = "omSCKSEVp23kSohLBrNIqacoYRMiGzYGcjIUhbS6Utw"
        val proof = signer(prompt).enrollment(gatewayChallenge, now + 120_000, nonce)
        assertEquals("9of2vsQM7O9WUvlPVEJcoR6hDB_em4mPWcd_w7HLotY", requestedChallenge(prompt.options.single()))
        assertEquals(gatewayChallenge, proof["challenge"]!!.jsonPrimitive.content)
    }

    @Test fun `a ceremony for another purpose, relay, time or shape opens no prompt`(): Unit = runBlocking {
        for (bad in listOf(
            ceremony(purpose = "step-up"), ceremony(purpose = "device-enrollment"), ceremony(rpId = "g-abcdefgh.relay.example.test"),
            ceremony(rpId = "other.example.test"), ceremony(challenge = "short"), ceremony(binding = "x"),
            ceremony(expiresAt = now), ceremony(expiresAt = now + 300_001),
        )) {
            val prompt = Prompt { fail("A refused ceremony opened the prompt"); "" }
            try { signer(prompt).approval(bad); fail("Accepted $bad") } catch (_: GatewayPasskeyRefused) {}
            assertTrue(prompt.options.isEmpty())
        }
    }

    @Test fun `an assertion made elsewhere or for another challenge is not sent`(): Unit = runBlocking {
        val otherApp = "android:apk-key-hash:" + "B".repeat(43)
        for (answer in listOf<(String) -> String>(
            { fakeAssertion(requestedChallenge(it), "https://relay.example.test") },
            { fakeAssertion(requestedChallenge(it), "https://g-abcdefgh.relay.example.test") },
            { fakeAssertion(requestedChallenge(it), otherApp) },
            { fakeAssertion(pageChallenge, app) },
            { fakeAssertion(requestedChallenge(it), app) { put("type", "webauthn.create") } },
            { fakeAssertion(requestedChallenge(it), app) { put("crossOrigin", true) } },
            { fakeAssertion(requestedChallenge(it), app) { put("topOrigin", "https://evil.example.test") } },
            { "not json" }, { "{}" }, { """{"response":{"clientDataJSON":"!"}}""" }, { "x".repeat(65_537) },
        )) {
            try { signer(Prompt(answer)).approval(ceremony()); fail("Foreign assertion accepted") } catch (_: GatewayPasskeyRefused) {}
        }
    }

    @Test fun `only an app origin can sign`() {
        for (origin in listOf("https://relay.example.test", "android:apk-key-hash:short", ""))
            assertThrows(IllegalArgumentException::class.java) { GatewayPasskeySigner(rpId, origin) { "" } }
        assertThrows(IllegalArgumentException::class.java) { GatewayPasskeySigner("", app) { "" } }
    }
}

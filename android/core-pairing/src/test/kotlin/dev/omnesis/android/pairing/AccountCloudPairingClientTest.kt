// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class AccountCloudPairingClientTest {
    private val root = Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("cloud-identity-vectors.json")!!.bufferedReader().use { it.readText() }).jsonObject
    private val clock = root["clock"]!!.jsonPrimitive.long
    private val candidate = Json.decodeFromJsonElement<GoogleGatewayBinding>(root["gateway"]!!)
    private val clientId = "synthetic.apps.googleusercontent.com"
    private val origin = "https://relay.example.test"
    private val account = "a".repeat(64)
    private val operationId = "00000000-0000-4000-8000-000000000001"
    private val salt = "s".repeat(43)
    private val passkeySalt = "z".repeat(43)
    private val issued get() = (clock - 10).toString()
    private val key = softwareDeviceKey()
    private val codeNonce = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk"
    /** The gateway's challenge: its commitment to [codeNonce]. */
    private val gatewayChallenge = "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs"
    private fun json(value: JsonObjectBuilder.() -> Unit) = buildJsonObject(value).toString()
    private class Transport(val handler: suspend (String, String?, String?) -> String) : CloudPairingTransport {
        var closed = false
        override suspend fun request(url: String, body: String?, bearer: String?) = handler(url, body, bearer)
        override fun close() { closed = true }
    }
    private class Sent(val url: String, val body: JsonObject)
    private inner class Fixture(
        attack: String? = null,
        mutateControl: (suspend (String, String) -> String)? = null,
        beforeGateway: (suspend (String) -> Unit)? = null,
        time: () -> Long = { clock },
        onGatewayCreated: (() -> Unit)? = null,
        publicCheck: ((List<java.security.cert.X509Certificate>, String) -> Boolean)? = { _, _ -> true },
        gatewayStatus: String = "pending",
        /** What a dishonest gateway answers instead: the nonce and the code for a reply to [url]. */
        forge: ((url: String, honestCode: String) -> Pair<String, String>)? = null,
        /** The gateway's `/devices/account/config`; null for a gateway without the route. */
        val gatewayConfig: String? = json { putJsonObject("gatewayPasskey") { put("rpId", "relay.example.test"); put("origin", candidate.publicOrigin) } },
    ) {
        val challenge = CloudPairingChallenge.create("Fictional phone")
        val nonce = DeviceEnrollmentContract.enrollmentNonce(challenge.requestId, "android", "Fictional phone", challenge.secret, key.publicKey)
        val calls = mutableListOf<String>()
        val sent = mutableListOf<Sent>()
        private var challengeHash: String? = null
        private val originalControl = Transport { url, raw, bearer ->
            calls.add(url)
            val body = raw?.let { Json.parseToJsonElement(it).jsonObject }
            when {
                url == "https://www.googleapis.com/oauth2/v3/certs" -> EphemeralGoogleSigner.jwks
                url == "$origin/_relay/v3/native/start" -> {
                    assertNull(bearer); assertEquals(nonce, body!!["nonce"]!!.jsonPrimitive.content)
                    challengeHash = body["challenge"]!!.jsonPrimitive.content
                    json { put("operationId", operationId); put("ticket", "t".repeat(43)); put("salt", salt); put("googleNonce", DeviceEnrollmentContract.googleProofNonce(salt, nonce)); put("expiresAt", (clock + 300) * 1000) }
                }
                url.endsWith("/passkeys/options") -> json {
                    put("ceremonyId", "c".repeat(43)); put("salt", passkeySalt); put("issuedAt", issued)
                    putJsonObject("options") { put("rpId", "relay.example.test"); put("challenge", DeviceEnrollmentContract.passkeyProofChallenge(passkeySalt, issued, nonce)); put("userVerification", "required") }
                }
                url.endsWith("/google") || url.endsWith("/passkeys/complete") -> {
                    assertNull(bearer); assertEquals(operationId, body!!["operationId"]!!.jsonPrimitive.content)
                    assertEquals(challengeHash, cloudDigestUrl(body["verifier"]!!.jsonPrimitive.content.toByteArray()))
                    if (url.endsWith("/passkeys/complete")) assertNotNull(body["credential"])
                    json { put("discoveryToken", "opaque-discovery"); put("accountId", account); put("expiresAt", clock + 300); if (url.endsWith("/passkeys/complete")) put("credentialPublicKey", "cHVibGlj") }
                }
                url.startsWith("$origin/_relay/v3/gateways") -> {
                    assertEquals("opaque-discovery", bearer)
                    json { putJsonArray("gateways") {
                        if (attack != "empty") add(buildJsonObject { put("gatewayId", candidate.gatewayId); put("publicOrigin", candidate.publicOrigin); put("displayName", "Fictional home") })
                        if (attack == "duplicate") add(buildJsonObject { put("gatewayId", candidate.gatewayId); put("publicOrigin", candidate.publicOrigin) })
                    } }
                }
                url == "$origin/_relay/v3/gateway?gatewayId=${candidate.gatewayId}" -> {
                    assertEquals("opaque-discovery", bearer)
                    json { put("binding", Json.encodeToJsonElement(if (attack == "substitute") candidate.copy(gatewayId = UUID.randomUUID().toString()) else candidate)); put("accountId", account); put("identityToken", "opaque-gateway-scoped-proof"); put("expiresAt", clock + 300) }
                }
                else -> error("Unexpected destination")
            }
        }
        private val control = Transport { url, raw, bearer ->
            val response = originalControl.request(url, raw, bearer)
            mutateControl?.invoke(url, response) ?: response
        }
        private val originalPinned = Transport { url, raw, bearer ->
            calls.add(url)
            assertNull(bearer)
            val body = raw?.let { Json.parseToJsonElement(it).jsonObject } ?: JsonObject(emptyMap())
            sent.add(Sent(url, body))
            if (url.endsWith("/config")) { assertNull("the configuration is read, not posted", raw); gatewayConfig ?: throw CloudPairingException(404) }
            else if (url.endsWith("/challenge")) json { put("challenge", gatewayChallenge); put("expiresAt", (clock + 120) * 1000) }
            else {
                assertEquals(challenge.secret, body["secret"]!!.jsonPrimitive.content)
                if (url.endsWith("/request")) assertEquals("opaque-gateway-scoped-proof", body["identityToken"]!!.jsonPrimitive.content)
                else { assertEquals("${candidate.publicOrigin}/devices/account/poll", url); assertNull(body["identityToken"]) }
                val approved = url.endsWith("/poll") || gatewayStatus == "approved"
                json { put("status", if (approved) "approved" else "pending"); val honest = challenge.comparisonCode(root["fingerprint"]!!.jsonPrimitive.content, codeNonce)
                    val (sentNonce, sentCode) = forge?.invoke(url, honest) ?: (codeNonce to honest)
                    put("verificationCode", sentCode); put("codeNonce", sentNonce); put("expiresAt", (clock + 300) * 1000); if (approved) put("pairingCode", "FICTIONAL-CODE") }
            }
        }
        /** Every request handed to the gateway's transport, also one that then failed. */
        val attempts = mutableListOf<Pair<String, String?>>()
        private val pinned = Transport { url, raw, bearer ->
            attempts.add(url to raw)
            beforeGateway?.invoke(url)
            originalPinned.request(url, raw, bearer)
        }
        val client = AccountCloudPairingClient(origin, clientId, direct = control, createGateway = { assertEquals(root["fingerprint"]!!.jsonPrimitive.content, it); onGatewayCreated?.invoke(); pinned }, now = time, deviceKeys = { key }, publicCertificateCheck = publicCheck)
        operator fun component1() = client
        operator fun component2() = challenge
        operator fun component3() = calls
    }
    private fun fixture(
        attack: String? = null,
        mutateControl: (suspend (String, String) -> String)? = null,
        time: () -> Long = { clock },
        onGatewayCreated: (() -> Unit)? = null,
    ) = Fixture(attack, mutateControl, time = time, onGatewayCreated = onGatewayCreated)

    @Test fun `native Google uses server nonce and PKCE then waits for explicit gateway selection and approval`(): Unit = runBlocking {
        val (client, challenge, calls) = fixture()
        val nonce = client.begin(challenge)
        val choices = client.google(EphemeralGoogleSigner.token(nonce, clientId, clock))
        assertEquals(listOf(candidate.gatewayId), choices.map { it.gatewayId })
        assertFalse(calls.any { it.contains("/gateway?") })
        val pending = client.select(choices.single().gatewayId)
        assertFalse(pending.approved)
        assertThrows(CloudPairingException::class.java) { pending.pairingPayload(clock * 1000) }
        client.poll(pending); assertTrue(pending.approved)
        assertThrows(CloudPairingException::class.java) { pending.pairingPayload(clock * 1000) }
        pending.confirmComparison(); assertTrue(pending.pairingPayload(clock * 1000).contains("pinned-key-strict"))
        client.close(); client.close()
    }

    @Test fun `passkey assertions use the same account directory and enrollment approval contract`(): Unit = runBlocking {
        val (client, challenge, _) = fixture()
        client.begin(challenge)
        val options = client.passkeyOptions(); assertEquals("c".repeat(43), options.ceremonyId)
        val choices = client.passkey(options, "{\"id\":\"synthetic-assertion\"}")
        assertFalse(client.select(choices.single().gatewayId).approved)
        client.close()
    }

    @Test fun `wrong Google nonce is rejected before sending an identity token to the relay`(): Unit = runBlocking {
        val (client, challenge, calls) = fixture(); client.begin(challenge)
        try { client.google(EphemeralGoogleSigner.token("n".repeat(43), clientId, clock)); fail("Wrong nonce accepted") } catch (_: CloudIdentityException) { }
        assertFalse(calls.any { it.endsWith("/google") }); client.close()
    }

    @Test fun `empty directories duplicate identities and substituted selected gateways fail closed`(): Unit = runBlocking {
        for (attack in listOf("empty", "duplicate", "substitute")) {
            val (client, challenge, _) = fixture(attack); val nonce = client.begin(challenge)
            try {
                val choices = client.google(EphemeralGoogleSigner.token(nonce, clientId, clock))
                client.select(choices.single().gatewayId)
                fail("Invalid directory accepted")
            } catch (error: AccountPairingException) {
                assertEquals(if (attack == "empty") AccountPairingException.Reason.NO_GATEWAYS else AccountPairingException.Reason.INVALID_RESPONSE, error.reason)
            } finally { client.close() }
        }
    }

    private fun relayRefuses(path: String, refusal: String?): suspend (String, String) -> String = { url, response ->
        if (url.endsWith(path)) throw CloudPairingException(403, refusal) else response
    }

    @Test fun `a verified sign-in the relay has no account for says so on both sign-in routes`(): Unit = runBlocking {
        fixture(mutateControl = relayRefuses("/native/google", "no-account")).let { (client, challenge, calls) ->
            val nonce = client.begin(challenge)
            try { client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)); fail("Missing account accepted") }
            catch (error: AccountPairingException) { assertEquals(AccountPairingException.Reason.NO_ACCOUNT, error.reason) }
            assertFalse(calls.any { it.contains("/_relay/v3/gateways") }); client.close()
        }
        fixture(mutateControl = relayRefuses("/native/passkeys/complete", "no-account")).let { (client, challenge, _) ->
            client.begin(challenge)
            try { client.passkey(client.passkeyOptions(), "{\"id\":\"synthetic-assertion\"}"); fail("Missing account accepted") }
            catch (error: AccountPairingException) { assertEquals(AccountPairingException.Reason.NO_ACCOUNT, error.reason) }
            client.close()
        }
    }

    @Test fun `any other 403 from the sign-in routes stays the generic failure`(): Unit = runBlocking {
        for (refusal in listOf(null, "", "forbidden", "NO-ACCOUNT")) {
            val (client, challenge, _) = fixture(mutateControl = relayRefuses("/native/google", refusal)); val nonce = client.begin(challenge)
            try { client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)); fail("Refusal accepted") }
            catch (error: CloudPairingException) { assertEquals(403, error.statusCode) }
            client.close()
        }
        // Only the two sign-in routes name the missing account.
        val (client, challenge, _) = fixture(mutateControl = relayRefuses("/_relay/v3/gateways", "no-account")); val nonce = client.begin(challenge)
        try { client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)); fail("Refusal accepted") }
        catch (error: CloudPairingException) { assertEquals(403, error.statusCode) }
        client.close()
    }

    @Test fun `a refusal reason is read only from a short JSON body that names one`() {
        fun reason(body: String) = cloudRefusalReason(okio.Buffer().writeUtf8(body))
        assertEquals("no-account", reason("{\"error\":\"no-account\"}"))
        assertEquals("no-account", reason("{\"error\":\"no-account\",\"detail\":\"ignored\"}"))
        for (body in listOf("", "no-account", "\"no-account\"", "[\"no-account\"]", "{}", "{\"error\":null}", "{\"error\":403}", "{\"error\":{\"code\":\"no-account\"}}", "{\"error\":"))
            assertNull(body, reason(body))
        assertNull(reason("{\"error\":\"no-account\",\"pad\":\"${"x".repeat(300)}\"}"))
        assertEquals("x".repeat(240), reason("{\"error\":\"${"x".repeat(240)}\"}"))
    }

    @Test fun `closed clients repeated operations foreign origins and unlisted choices cannot start pairing`(): Unit = runBlocking {
        assertThrows(AccountPairingException::class.java) { AccountCloudPairingClient("https://relay.example.test/path", clientId) }
        val (client, challenge, _) = fixture(); val nonce = client.begin(challenge)
        try { client.begin(challenge); fail("Repeated begin") } catch (_: AccountPairingException) { }
        client.google(EphemeralGoogleSigner.token(nonce, clientId, clock))
        try { client.select(UUID.randomUUID().toString()); fail("Unlisted gateway") } catch (_: AccountPairingException) { }
        client.close()
        try { client.passkeyOptions(); fail("Closed client") } catch (_: AccountPairingException) { }
    }
    private fun mutation(path: String, fields: JsonObject): suspend (String, String) -> String = { url, response ->
        if (java.net.URI(url).path == path) JsonObject(Json.parseToJsonElement(response).jsonObject.toMutableMap().apply { putAll(fields) }).toString()
        else response
    }

    @Test fun `invalid native operation metadata and oversized control responses fail before sign in`(): Unit = runBlocking {
        val cases = listOf(
            buildJsonObject { put("operationId", "invalid") }, buildJsonObject { put("ticket", "short") },
            buildJsonObject { put("googleNonce", "short") }, buildJsonObject { put("expiresAt", clock * 1000) },
            buildJsonObject { put("googleNonce", "n".repeat(43)) }, buildJsonObject { put("salt", "x".repeat(43)) },
            buildJsonObject { put("salt", "short") },
            buildJsonObject { put("expiresAt", (clock + 311) * 1000) },
        )
        for (fields in cases) {
            val (client, challenge, _) = fixture(mutateControl = mutation("/_relay/v3/native/start", fields))
            try { client.begin(challenge); fail("Invalid operation accepted") } catch (error: AccountPairingException) { assertEquals(AccountPairingException.Reason.INVALID_RESPONSE, error.reason) }
            client.close()
        }
        val (oversized, challenge, _) = fixture(mutateControl = { _, _ -> "a".repeat(65537) })
        try { oversized.begin(challenge); fail("Oversized operation accepted") } catch (_: AccountPairingException) {}
        oversized.close()
    }

    @Test fun `passkey options require exact RP mandatory verification and bounded assertions`(): Unit = runBlocking {
        for (options in listOf(
            buildJsonObject { put("rpId", "other.example.test"); put("challenge", "a".repeat(43)); put("userVerification", "required") },
            buildJsonObject { put("rpId", "relay.example.test"); put("challenge", "short"); put("userVerification", "required") },
            buildJsonObject { put("rpId", "relay.example.test"); put("challenge", "a".repeat(43)); put("userVerification", "preferred") },
        )) {
            val (client, challenge, _) = fixture(mutateControl = mutation("/_relay/v3/native/passkeys/options", buildJsonObject { put("options", options) }))
            client.begin(challenge)
            try { client.passkeyOptions(); fail("Invalid ceremony accepted") } catch (_: AccountPairingException) {}
            client.close()
        }
        for ((ceremony, assertion) in listOf("short" to "{}", "c".repeat(43) to "a".repeat(65537))) {
            val (client, challenge, _) = fixture(); client.begin(challenge)
            try { client.passkey(AccountCloudPairingClient.PasskeyOptions(ceremony, "{}"), assertion); fail("Invalid assertion accepted") } catch (_: AccountPairingException) {}
            client.close()
        }
    }

    @Test fun `discovery and enrollment proofs cannot change accounts or outlive the original operation`(): Unit = runBlocking {
        val discovery = listOf(
            buildJsonObject { put("accountId", "invalid") }, buildJsonObject { put("discoveryToken", "") },
            buildJsonObject { put("discoveryToken", "a".repeat(4097)) }, buildJsonObject { put("expiresAt", clock) },
            buildJsonObject { put("expiresAt", clock + 301) },
        )
        val selected = listOf(
            buildJsonObject { put("accountId", "b".repeat(64)) }, buildJsonObject { put("identityToken", "") },
            buildJsonObject { put("identityToken", "a".repeat(16385)) }, buildJsonObject { put("expiresAt", clock) },
            buildJsonObject { put("expiresAt", clock + 301) },
        )
        for ((path, fields) in discovery.map { "/_relay/v3/native/passkeys/complete" to it } + selected.map { "/_relay/v3/gateway" to it }) {
            val (client, challenge, _) = fixture(mutateControl = mutation(path, fields)); client.begin(challenge)
            try {
                val options = client.passkeyOptions(); val choices = client.passkey(options, "{}")
                client.select(choices.single().gatewayId); fail("Substituted account authority accepted")
            } catch (error: AccountPairingException) { assertEquals(AccountPairingException.Reason.INVALID_RESPONSE, error.reason) }
            client.close()
        }
    }

    @Test fun `directory pagination retains every explicit choice but rejects invalid names cursors and too many results`(): Unit = runBlocking {
        val (client, challenge, calls) = fixture(mutateControl = { url, response ->
            if (java.net.URI(url).path != "/_relay/v3/gateways") response else {
                val second = java.net.URI(url).rawQuery != null
                val id = if (second) "00000000-0000-4000-8000-000000000002" else "00000000-0000-4000-8000-000000000001"
                json { putJsonArray("gateways") { add(buildJsonObject { put("gatewayId", id); put("publicOrigin", "https://gateway.example.test") }) }; if (!second) put("nextCursor", id) }
            }
        })
        client.begin(challenge); assertEquals(2, client.passkey(client.passkeyOptions(), "{}").size)
        assertFalse(calls.any { it.contains("/gateway?") }); client.close()
        for (fields in listOf(
            buildJsonObject { put("gatewayId", "invalid"); put("publicOrigin", candidate.publicOrigin) },
            buildJsonObject { put("gatewayId", candidate.gatewayId); put("publicOrigin", "http://gateway.example.test") },
            buildJsonObject { put("gatewayId", candidate.gatewayId); put("publicOrigin", candidate.publicOrigin); put("displayName", " ") },
            buildJsonObject { put("gatewayId", candidate.gatewayId); put("publicOrigin", candidate.publicOrigin); put("displayName", "a".repeat(81)) },
        )) {
            val (invalid, request, _) = fixture(mutateControl = mutation("/_relay/v3/gateways", buildJsonObject { put("gateways", JsonArray(listOf(fields))) }))
            invalid.begin(request)
            try { invalid.passkey(invalid.passkeyOptions(), "{}"); fail("Invalid choice accepted") } catch (_: AccountPairingException) {}
            invalid.close()
        }
    }

    @Test fun `expired operations and closing during pin creation cannot send provisional credentials`(): Unit = runBlocking {
        var current = clock
        val (expired, challenge, _) = fixture(time = { current }); expired.begin(challenge); current += 301
        try { expired.passkeyOptions(); fail("Expired operation accepted") } catch (error: AccountPairingException) { assertEquals(AccountPairingException.Reason.EXPIRED, error.reason) }
        expired.close()
        var closeDuringCreation: () -> Unit = {}
        val (client, request, calls) = fixture(onGatewayCreated = { closeDuringCreation() })
        closeDuringCreation = { client.close() }; client.begin(request)
        val choices = client.passkey(client.passkeyOptions(), "{}")
        try { client.select(choices.single().gatewayId); fail("Closed pin factory accepted") } catch (_: AccountPairingException) {}
        assertFalse(calls.any { it.endsWith("/devices/account/request") }); client.close()
    }

    @Test fun `default clock validates a current operation without contacting Google or a gateway`(): Unit = runBlocking {
        val direct = Transport { url, raw, _ ->
            assertTrue(url.endsWith("/_relay/v3/native/start"))
            val start = Json.parseToJsonElement(raw!!).jsonObject["nonce"]!!.jsonPrimitive.content
            json { put("operationId", UUID.randomUUID().toString()); put("ticket", "t".repeat(43)); put("salt", salt); put("googleNonce", DeviceEnrollmentContract.googleProofNonce(salt, start)); put("expiresAt", System.currentTimeMillis() + 300_000) }
        }
        val client = AccountCloudPairingClient(origin, clientId, direct = direct, deviceKeys = { key })
        assertTrue(client.begin(CloudPairingChallenge.create("Fictional phone")).length == 43); client.close(); assertTrue(direct.closed)
        for (url in listOf("http://relay.example.test", "https://user@relay.example.test", "https://relay.example.test/path", "https://relay.example.test?query", "https://relay.example.test#fragment", "https://relay.example.test:0")) {
            assertThrows(AccountPairingException::class.java) { AccountCloudPairingClient(url, clientId) }
        }
    }

    private val assertion = """{"id":"cred","rawId":"cred","type":"public-key","clientExtensionResults":{},"vendorExtra":1,"response":{"clientDataJSON":"e30","authenticatorData":"e30","signature":"e30","userHandle":"e30","transports":["internal"]}}"""
    private fun gatewayFails(status: Int, onPath: String): suspend (String) -> Unit = { url -> if (url.endsWith(onPath)) throw CloudPairingException(status) }

    @Test fun `Google enrollment signs the proposed key and sends the retained proof only to the gateway`(): Unit = runBlocking {
        val fixture = Fixture()
        val nonce = fixture.client.begin(fixture.challenge)
        assertEquals(DeviceEnrollmentContract.googleProofNonce(salt, fixture.nonce), nonce)
        val token = EphemeralGoogleSigner.token(nonce, clientId, clock)
        val pending = fixture.client.select(fixture.client.google(token).single().gatewayId)
        assertEquals(listOf("${candidate.publicOrigin}/devices/account/challenge", "${candidate.publicOrigin}/devices/account/request"), fixture.sent.map { it.url })
        val body = fixture.sent.last().body
        assertEquals(setOf("requestId", "kind", "name", "secret", "identityToken", "deviceKey", "proof", "requireApproval"), body.keys)
        assertEquals(false, body["requireApproval"]!!.jsonPrimitive.boolean)
        assertEquals(buildJsonObject { put("type", "google"); put("idToken", token); put("salt", salt) }, body["proof"])
        val deviceKey = body["deviceKey"]!!.jsonObject
        assertEquals(key.publicKey, deviceKey["publicKey"]!!.jsonPrimitive.content)
        assertEquals(gatewayChallenge, deviceKey["challenge"]!!.jsonPrimitive.content)
        val verifier = java.security.Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(java.security.KeyFactory.getInstance("EC").generatePublic(java.security.spec.X509EncodedKeySpec(java.util.Base64.getUrlDecoder().decode(key.publicKey))))
        verifier.update(DeviceEnrollmentContract.enrollmentSignatureTranscript(fixture.challenge.requestId, "android", "Fictional phone", pending.spkiFingerprint, gatewayChallenge, key.publicKey))
        assertTrue(verifier.verify(java.util.Base64.getUrlDecoder().decode(deviceKey["signature"]!!.jsonPrimitive.content)))
        assertFalse("A held request keeps the comparison", pending.joined)
        assertFalse(fixture.calls.filter { it.startsWith(origin) }.any { it.endsWith("/devices/account/request") })
        fixture.client.close()
    }

    @Test fun `passkey enrollment recomputes the challenge and carries only the fields the gateway's schema allows`(): Unit = runBlocking {
        val fixture = Fixture()
        fixture.client.begin(fixture.challenge)
        val options = fixture.client.passkeyOptions()
        assertTrue(options.options.contains(DeviceEnrollmentContract.passkeyProofChallenge(passkeySalt, issued, fixture.nonce)))
        fixture.client.select(fixture.client.passkey(options, assertion).single().gatewayId)
        val proof = fixture.sent.last().body["proof"]!!.jsonObject
        assertEquals(setOf("type", "salt", "issuedAt", "credentialPublicKey", "credential"), proof.keys)
        assertEquals(passkeySalt, proof["salt"]!!.jsonPrimitive.content)
        assertEquals(issued, proof["issuedAt"]!!.jsonPrimitive.content)
        assertEquals("cHVibGlj", proof["credentialPublicKey"]!!.jsonPrimitive.content)
        val credential = proof["credential"]!!.jsonObject
        assertEquals(setOf("id", "rawId", "type", "clientExtensionResults", "response"), credential.keys)
        assertEquals(setOf("clientDataJSON", "authenticatorData", "signature", "userHandle"), credential["response"]!!.jsonObject.keys)
        fixture.client.close()
    }

    @Test fun `a relay challenge that does not commit to this device is refused before the prompt`(): Unit = runBlocking {
        for (fields in listOf(
            buildJsonObject { putJsonObject("options") { put("rpId", "relay.example.test"); put("challenge", "p".repeat(43)); put("userVerification", "required") } },
            buildJsonObject { put("salt", "x".repeat(43)) },
            buildJsonObject { put("issuedAt", "1794240001") },
            buildJsonObject { put("issuedAt", "soon") },
        )) {
            val fixture = Fixture(mutateControl = mutation("/_relay/v3/native/passkeys/options", fields))
            fixture.client.begin(fixture.challenge)
            try { fixture.client.passkeyOptions(); fail("Unbound challenge accepted") } catch (_: AccountPairingException) {}
            fixture.client.close()
        }
    }

    @Test fun `a gateway that joins the device skips the comparison and produces a pinned payload`(): Unit = runBlocking {
        val fixture = Fixture(gatewayStatus = "approved")
        val nonce = fixture.client.begin(fixture.challenge)
        val pending = fixture.client.select(fixture.client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)).single().gatewayId)
        assertTrue(pending.joined); assertTrue(pending.approved)
        assertTrue(pending.pairingPayload(clock * 1000).contains("pinned-key-strict"))
        fixture.client.close()
    }

    @Test fun `a failed public check asks for approval and still never trusts an instant approval`(): Unit = runBlocking {
        var checked: Pair<List<java.security.cert.X509Certificate>, String>? = null
        val fixture = Fixture(gatewayStatus = "approved", publicCheck = { chain, host -> checked = chain to host; false })
        val nonce = fixture.client.begin(fixture.challenge)
        val pending = fixture.client.select(fixture.client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)).single().gatewayId)
        assertEquals(java.net.URI(candidate.publicOrigin).host, checked?.second)
        assertEquals(true, fixture.sent.last().body["requireApproval"]!!.jsonPrimitive.boolean)
        assertTrue(pending.approved); assertFalse(pending.joined)
        assertThrows(CloudPairingException::class.java) { pending.pairingPayload(clock * 1000) }
        fixture.client.close()
    }

    @Test fun `the build switch skips the public check for a test gateway`(): Unit = runBlocking {
        val fixture = Fixture(publicCheck = null)
        val nonce = fixture.client.begin(fixture.challenge)
        fixture.client.select(fixture.client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)).single().gatewayId)
        assertEquals(false, fixture.sent.last().body["requireApproval"]!!.jsonPrimitive.boolean)
        fixture.client.close()
    }

    private suspend fun selecting(fixture: Fixture): CloudPairingConfirmation {
        val nonce = fixture.client.begin(fixture.challenge)
        return fixture.client.select(fixture.client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)).single().gatewayId)
    }

    @Test fun `a gateway without the challenge route must be updated`(): Unit = runBlocking {
        val fixture = Fixture(beforeGateway = gatewayFails(404, "/challenge"))
        try { selecting(fixture); fail("Older gateway accepted") } catch (e: AccountPairingException) { assertEquals(AccountPairingException.Reason.GATEWAY_UPDATE_REQUIRED, e.reason) }
        assertFalse(fixture.calls.any { it.endsWith("/devices/account/request") })
        fixture.client.close()
    }

    @Test fun `a 403 from the gateway says it is not yours`(): Unit = runBlocking {
        for (path in listOf("/challenge", "/request")) {
            val fixture = Fixture(beforeGateway = gatewayFails(403, path))
            try { selecting(fixture); fail("Refused gateway accepted") } catch (e: AccountPairingException) { assertEquals(AccountPairingException.Reason.NOT_YOUR_GATEWAY, e.reason) }
            fixture.client.close()
        }
    }

    @Test fun `a spent challenge ends the sign-in and no second challenge is ever answered`(): Unit = runBlocking {
        val fixture = Fixture(beforeGateway = gatewayFails(409, "/request"))
        try { selecting(fixture); fail("Spent challenge accepted") } catch (e: CloudPairingException) { assertEquals(409, e.statusCode) }
        // The secret left with the first request, so a fresh challenge could be chosen knowing it.
        assertEquals(1, fixture.attempts.count { it.first.endsWith("/challenge") })
        assertEquals(1, fixture.attempts.count { it.first.endsWith("/request") })
        fixture.client.close()
    }

    @Test fun `a retry after an outage resends the identical request and asks for no new challenge`(): Unit = runBlocking {
        var outages = 2
        val fixture = Fixture(beforeGateway = { url -> if (url.endsWith("/request") && outages-- > 0) throw CloudPairingException(503) })
        val nonce = fixture.client.begin(fixture.challenge)
        val gatewayId = fixture.client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)).single().gatewayId
        repeat(2) {
            try { fixture.client.select(gatewayId); fail("Offline gateway accepted") }
            catch (e: AccountPairingException) { assertEquals(AccountPairingException.Reason.GATEWAY_OFFLINE, e.reason) }
        }
        val pending = fixture.client.select(gatewayId)
        assertEquals(fixture.challenge.comparisonCode(root["fingerprint"]!!.jsonPrimitive.content, codeNonce), pending.verificationCode)
        assertEquals("one challenge for the whole sign-in", 1, fixture.attempts.count { it.first.endsWith("/challenge") })
        val requests = fixture.attempts.filter { it.first.endsWith("/request") }.map { it.second }
        assertEquals(3, requests.size)
        assertEquals("the same bytes every time", 1, requests.distinct().size)
        fixture.client.close()
    }

    @Test fun `an offline gateway can be retried until the sign-in expires`(): Unit = runBlocking {
        var online = false
        var current = clock
        val fixture = Fixture(time = { current }, beforeGateway = { url -> if (!online && url.endsWith("/challenge")) throw CloudPairingException(503) })
        val nonce = fixture.client.begin(fixture.challenge)
        val gatewayId = fixture.client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)).single().gatewayId
        assertEquals(minOf(clock - 60 + 600, clock + 300) * 1000, fixture.client.retryUntilMillis)
        repeat(2) {
            try { fixture.client.select(gatewayId); fail("Offline gateway accepted") } catch (e: AccountPairingException) { assertEquals(AccountPairingException.Reason.GATEWAY_OFFLINE, e.reason) }
        }
        online = true
        assertFalse(fixture.client.select(gatewayId).joined)
        fixture.client.close()

        val late = Fixture(time = { current }, beforeGateway = { url -> if (url.endsWith("/challenge")) throw java.io.IOException("unreachable") })
        current = clock
        val lateNonce = late.client.begin(late.challenge)
        val id = late.client.google(EphemeralGoogleSigner.token(lateNonce, clientId, clock)).single().gatewayId
        try { late.client.select(id); fail() } catch (e: AccountPairingException) { assertEquals(AccountPairingException.Reason.GATEWAY_OFFLINE, e.reason) }
        current = clock + 301
        try { late.client.select(id); fail() } catch (e: AccountPairingException) { assertEquals(AccountPairingException.Reason.EXPIRED, e.reason) }
        late.client.close()
    }

    @Test fun `a certificate that fails its pin is not treated as an outage`(): Unit = runBlocking {
        val fixture = Fixture(beforeGateway = { url -> if (url.endsWith("/challenge")) throw javax.net.ssl.SSLHandshakeException("pin") })
        try { selecting(fixture); fail("Mismatched pin accepted") } catch (_: javax.net.ssl.SSLHandshakeException) {}
        fixture.client.close()
    }

    private val otherNonce = "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY"
    private fun Fixture.codeFor(nonce: String) = challenge.comparisonCode(root["fingerprint"]!!.jsonPrimitive.content, nonce)

    @Test fun `the challenge is the gateway's commitment, and an honest reply yields the code computed here`(): Unit = runBlocking {
        val fixture = Fixture()
        val pending = selecting(fixture)
        assertEquals(fixture.codeFor(codeNonce), pending.verificationCode)
        assertTrue(PairingCode.FORMAT.matches(pending.verificationCode!!))
        // The challenge came first; the secret went only to request, after it.
        assertEquals(listOf("challenge", "request"), fixture.sent.map { it.url.substringAfterLast('/') })
        assertNull(fixture.sent.first().body["secret"])
        fixture.client.close()
    }

    @Test fun `a nonce that does not open the commitment aborts with no code shown`(): Unit = runBlocking {
        lateinit var fixture: Fixture
        // The code is right for the nonce sent; the nonce is not the committed one.
        fixture = Fixture(forge = { _, _ -> otherNonce to fixture.codeFor(otherNonce) })
        try { selecting(fixture); fail("Uncommitted nonce accepted") } catch (_: CloudPairingException) {}
        fixture.client.close()
    }

    @Test fun `a reply whose code differs from the one computed here aborts`(): Unit = runBlocking {
        val fixture = Fixture(forge = { _, honest -> codeNonce to if (honest == "000 000") "000 001" else "000 000" })
        try { selecting(fixture); fail("Foreign code accepted") } catch (_: CloudPairingException) {}
        fixture.client.close()
    }

    @Test fun `a nonce that changes between polls aborts and takes the code away`(): Unit = runBlocking {
        lateinit var fixture: Fixture
        fixture = Fixture(forge = { url, honest -> if (url.endsWith("/poll")) otherNonce to fixture.codeFor(otherNonce) else codeNonce to honest })
        val pending = selecting(fixture)
        assertEquals(fixture.codeFor(codeNonce), pending.verificationCode)
        try { fixture.client.poll(pending); fail("Changed nonce accepted") } catch (_: CloudPairingException) {}
        assertNull(pending.verificationCode); assertFalse(pending.approved)
        assertThrows(CloudPairingException::class.java) { pending.pairingPayload(clock * 1000) }
        fixture.client.close()
    }
    private val app = "android:apk-key-hash:TPfeOsd2u2Uq8rCtF9DeGgc1m50jt6fPpDJYcUvAaCo"
    /** This app's passkey provider: every prompt it opens, answered from the app's origin. */
    private class AppPasskeys(val app: String, val answer: (String) -> String = { fakeAssertion(requestedChallenge(it), app) }) {
        val prompts = mutableListOf<String>()
        var onPrompt: () -> Unit = {}
        fun signer(now: Long) = GatewayPasskeySigner("relay.example.test", app, { now }) { options -> prompts += options; onPrompt(); answer(options) }
    }
    private suspend fun passkeyJoin(fixture: Fixture, passkeys: AppPasskeys): CloudPairingConfirmation {
        fixture.client.begin(fixture.challenge)
        val choices = fixture.client.passkey(fixture.client.passkeyOptions(), assertion)
        return fixture.client.select(choices.single().gatewayId, passkeys.signer(clock * 1000))
    }

    @Test fun `TM-01 an Android passkey join signs only a gateway-issued challenge`(): Unit = runBlocking {
        val fixture = Fixture()
        val passkeys = AppPasskeys(app)
        passkeyJoin(fixture, passkeys)
        // The join's one prompt asks to sign the gateway's own challenge for this device's own
        // nonce, from this app's origin: no value the relay picked is in it.
        assertEquals(DeviceEnrollmentContract.gatewayPasskeyChallenge("device-enrollment", app, gatewayChallenge, fixture.nonce), requestedChallenge(passkeys.prompts.single()))
        val body = fixture.sent.last().body
        assertEquals("${candidate.publicOrigin}/devices/account/request", fixture.sent.last().url)
        val proof = body["proof"]!!.jsonObject
        assertEquals(setOf("type", "challenge", "credential"), proof.keys)
        assertEquals("gateway-passkey", proof["type"]!!.jsonPrimitive.content)
        assertEquals(gatewayChallenge, proof["challenge"]!!.jsonPrimitive.content)
        assertEquals(gatewayChallenge, body["deviceKey"]!!.jsonObject["challenge"]!!.jsonPrimitive.content)
        // The relay's ceremony stays with the relay: its salt, time, challenge and key never reach the gateway.
        val sent = body.toString()
        for (relayValue in listOf(passkeySalt, DeviceEnrollmentContract.passkeyProofChallenge(passkeySalt, issued, fixture.nonce), "cHVibGlj"))
            assertFalse(relayValue, sent.contains(relayValue))
        // The gateway committed to its challenge before it learned anything about this request.
        assertEquals(listOf("config", "challenge", "request"), fixture.sent.map { it.url.substringAfterLast('/') })
        assertTrue(fixture.sent.take(2).all { it.body.isEmpty() })
        fixture.client.close()
    }

    @Test fun `the gateway's origin never enters the challenge, even when it names the relay`(): Unit = runBlocking {
        for (named in listOf("https://relay.example.test", candidate.publicOrigin)) {
            val fixture = Fixture(gatewayConfig = json { putJsonObject("gatewayPasskey") { put("rpId", "relay.example.test"); put("origin", named) } })
            val passkeys = AppPasskeys(app)
            passkeyJoin(fixture, passkeys)
            assertEquals(DeviceEnrollmentContract.gatewayPasskeyChallenge("device-enrollment", app, gatewayChallenge, fixture.nonce), requestedChallenge(passkeys.prompts.single()))
            fixture.client.close()
        }
    }

    @Test fun `a gateway without a passkey ceremony for this relay gets the relay's evidence and no second prompt`(): Unit = runBlocking {
        for (config in listOf(null, "{}", json { putJsonObject("gatewayPasskey") { put("rpId", "other.example.test"); put("origin", candidate.publicOrigin) } })) {
            val fixture = Fixture(gatewayConfig = config)
            val passkeys = AppPasskeys(app)
            passkeyJoin(fixture, passkeys)
            assertTrue(passkeys.prompts.isEmpty())
            assertEquals("passkey", fixture.sent.last().body["proof"]!!.jsonObject["type"]!!.jsonPrimitive.content)
            fixture.client.close()
        }
        // Nor without a signer, as in a build that can't name its own origin.
        val fixture = Fixture()
        fixture.client.begin(fixture.challenge)
        fixture.client.select(fixture.client.passkey(fixture.client.passkeyOptions(), assertion).single().gatewayId)
        assertEquals(listOf("challenge", "request"), fixture.sent.map { it.url.substringAfterLast('/') })
        fixture.client.close()
    }

    @Test fun `a Google sign-in never asks the gateway for a passkey ceremony`(): Unit = runBlocking {
        val fixture = Fixture()
        val passkeys = AppPasskeys(app)
        val nonce = fixture.client.begin(fixture.challenge)
        fixture.client.select(fixture.client.google(EphemeralGoogleSigner.token(nonce, clientId, clock)).single().gatewayId, passkeys.signer(clock * 1000))
        assertTrue(passkeys.prompts.isEmpty())
        assertEquals(listOf("challenge", "request"), fixture.sent.map { it.url.substringAfterLast('/') })
        assertEquals("google", fixture.sent.last().body["proof"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        fixture.client.close()
    }

    @Test fun `an assertion made elsewhere is refused before the request reveals the secret`(): Unit = runBlocking {
        for (answer in listOf<(String) -> String>(
            { fakeAssertion(requestedChallenge(it), "https://relay.example.test") },
            { fakeAssertion(DeviceEnrollmentContract.passkeyProofChallenge(passkeySalt, issued, "n".repeat(43)), app) },
        )) {
            val fixture = Fixture()
            try { passkeyJoin(fixture, AppPasskeys(app, answer)); fail("Foreign assertion sent") } catch (_: GatewayPasskeyRefused) {}
            assertFalse(fixture.attempts.any { it.first.endsWith("/request") })
            fixture.client.close()
        }
    }

    @Test fun `closing during the join's prompt sends nothing`(): Unit = runBlocking {
        val fixture = Fixture()
        val passkeys = AppPasskeys(app).apply { onPrompt = { fixture.client.close() } }
        try { passkeyJoin(fixture, passkeys); fail("Closed client sent a request") } catch (_: AccountPairingException) {}
        assertFalse(fixture.attempts.any { it.first.endsWith("/request") })
    }

    @Test fun `a retry after an outage resends the signed join without a second prompt`(): Unit = runBlocking {
        var outages = 1
        val fixture = Fixture(beforeGateway = { url -> if (url.endsWith("/request") && outages-- > 0) throw CloudPairingException(503) })
        val passkeys = AppPasskeys(app)
        fixture.client.begin(fixture.challenge)
        val gatewayId = fixture.client.passkey(fixture.client.passkeyOptions(), assertion).single().gatewayId
        try { fixture.client.select(gatewayId, passkeys.signer(clock * 1000)); fail("Offline gateway accepted") }
        catch (e: AccountPairingException) { assertEquals(AccountPairingException.Reason.GATEWAY_OFFLINE, e.reason) }
        fixture.client.select(gatewayId, passkeys.signer(clock * 1000))
        assertEquals(1, passkeys.prompts.size)
        assertEquals(1, fixture.attempts.count { it.first.endsWith("/challenge") })
        assertEquals(1, fixture.attempts.filter { it.first.endsWith("/request") }.map { it.second }.distinct().size)
        fixture.client.close()
    }

    @Test fun `the relay's ceremony time must be within a minute of the phone's clock`(): Unit = runBlocking {
        for ((offset, accepted) in listOf(-61L to false, -60L to true, 0L to true, 60L to true, 61L to false)) {
            val at = (clock + offset).toString()
            lateinit var fixture: Fixture
            fixture = Fixture(mutateControl = { url, response ->
                if (!url.endsWith("/passkeys/options")) response else json {
                    put("ceremonyId", "c".repeat(43)); put("salt", passkeySalt); put("issuedAt", at)
                    putJsonObject("options") { put("rpId", "relay.example.test"); put("challenge", DeviceEnrollmentContract.passkeyProofChallenge(passkeySalt, at, fixture.nonce)); put("userVerification", "required") }
                }
            })
            fixture.client.begin(fixture.challenge)
            val result = runCatching { fixture.client.passkeyOptions() }
            assertEquals("issuedAt offset $offset", accepted, result.isSuccess)
            if (!accepted) assertEquals(AccountPairingException.Reason.INVALID_RESPONSE, (result.exceptionOrNull() as AccountPairingException).reason)
            fixture.client.close()
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64

class GoogleCloudPairingClientTest {
    private val root = Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("cloud-identity-vectors.json")!!.bufferedReader().use { it.readText() }).jsonObject
    private val clock = root["clock"]!!.jsonPrimitive.long
    private val account = root["accountId"]!!.jsonPrimitive.content
    private val clientId = "fixture-web.apps.googleusercontent.com"
    private val candidate = Json.decodeFromJsonElement<GoogleGatewayBinding>(root["gateway"]!!)
    private fun challenge() = CloudPairingChallenge.create("Fictional phone", "00000000-0000-4000-8000-000000000002", "17".repeat(32))
    private val CODE_NONCE = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk"
    private val ISSUED = """{"challenge":"iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs","expiresAt":${(clock + 120) * 1000}}"""
    private fun progress(value: CloudPairingChallenge, status: String = "pending", code: String? = null): String =
        Json.encodeToString(CloudPairingProgress(status, value.comparisonCode(candidate.candidateFingerprint(clock), CODE_NONCE), (clock + 600) * 1000, code, CODE_NONCE))
    private fun control(challenge: CloudPairingChallenge, accountId: String = account, routingToken: String = "routing-test-token", keyOwner: Boolean = false) = FakeCloudTransport { url, body, bearer ->
        when (url) {
            "https://www.googleapis.com/oauth2/v3/certs" -> {
                assertNull(body); assertNull(bearer); EphemeralGoogleSigner.jwks
            }
            "https://relay.example.test/_relay/v1/login" -> {
                assertNull(bearer)
                assertFalse(requireNotNull(body).contains(challenge.secret))
                val request = Json.parseToJsonElement(body).jsonObject
                assertNotNull(request["idToken"])
                buildJsonObject { put("accountId", accountId); put("token", routingToken) }.toString()
            }
            else -> {
                assertEquals("https://relay.example.test/_relay/v2/gateway", url)
                assertEquals("routing-test-token", bearer); assertNull(body)
                Json.encodeToString(if (keyOwner) candidate.copy(identityToken = "omnesis-owner-key-v2:opaque-signed-registration") else candidate)
            }
        }
    }

    @Test fun `default clock still rejects forged Google identity before routing and default provisional transport owns resources`(): Unit = runBlocking {
        val direct = FakeCloudTransport { url, _, bearer ->
            assertEquals("https://www.googleapis.com/oauth2/v3/certs", url)
            assertNull(bearer)
            EphemeralGoogleSigner.jwks
        }
        val client = GoogleCloudPairingClient("https://relay.example.test", clientId, direct)
        try { client.start(challenge(), "forged"); fail("Forged identity accepted") }
        catch (_: CloudIdentityException) { }
        finally { client.close() }
        assertEquals(1, direct.closes)
        provisionalGatewayTransport("ab".repeat(32)).close()
    }

    @Test fun `signed discovery routes no gateway credential and remote approval still requires local comparison`(): Unit = runBlocking {
        val challenge = challenge()
        val control = control(challenge, keyOwner = true)
        val asked = mutableListOf<String>()
        val pinned = FakeCloudTransport { url, body, bearer ->
            assertNull(bearer)
            asked += url.substringAfterLast('/')
            if (url.endsWith("/devices/google/challenge")) {
                // The gateway commits before anything of the device's secret is sent.
                assertEquals("{}", body)
                return@FakeCloudTransport ISSUED
            }
            val request = Json.parseToJsonElement(requireNotNull(body)).jsonObject
            assertEquals(challenge.requestId, request["requestId"]!!.jsonPrimitive.content)
            assertEquals(challenge.secret, request["secret"]!!.jsonPrimitive.content)
            if (url.endsWith("/devices/google/request")) {
                assertEquals(listOf("challenge", "request"), asked)
                assertEquals("android", request["kind"]!!.jsonPrimitive.content)
                assertNotNull(request["identityToken"])
                // Without a device key the challenge is named at the top level, and only there.
                assertEquals("iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs", request["challenge"]!!.jsonPrimitive.content)
                assertNull(request["deviceKey"])
                progress(challenge)
            } else {
                assertEquals("${candidate.publicOrigin}/devices/google/poll", url)
                assertNull(request["identityToken"])
                progress(challenge, "approved", "SYNTHETIC-CODE")
            }
        }
        val client = GoogleCloudPairingClient("https://relay.example.test", clientId, control, {
            assertEquals(root["fingerprint"]!!.jsonPrimitive.content, it); pinned
        }, { clock })
        val flow = client.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock))
        try { client.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock)); fail("Sign-in reused") }
        catch (_: CloudPairingException) { }
        assertFalse(flow.approved); assertFalse(flow.compared)
        client.poll(flow)
        assertTrue(flow.approved)
        assertThrows(CloudPairingException::class.java) { flow.pairingPayload(clock * 1000) }
        flow.confirmComparison()
        val payload = PairingPayload.decode(flow.pairingPayload(clock * 1000), cloudRelay = true) as PairingPayload.V4
        assertTrue(payload.tls is PairingPayload.V4Tls.PinnedKeyStrict)
        client.close()
        client.close()
        assertEquals(1, control.closes); assertEquals(1, pinned.closes)
    }

    @Test fun `wrong account empty or oversized routing tokens and invalid Google tokens fail before gateway access`(): Unit = runBlocking {
        val challenge = challenge()
        for ((accountId, token) in listOf("wrong-account" to "token", account to "", account to "x".repeat(4097))) {
            val control = control(challenge, accountId, token)
            val client = GoogleCloudPairingClient("https://relay.example.test", clientId, control,
                { fail("Invalid session reached gateway"); control }, { clock })
            try { client.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock)); fail("Invalid routing session accepted") }
            catch (_: CloudPairingException) { }
            finally { client.close() }
        }
        val direct = FakeCloudTransport { url, _, _ ->
            assertEquals("https://www.googleapis.com/oauth2/v3/certs", url); EphemeralGoogleSigner.jwks
        }
        for (token in listOf("forged", EphemeralGoogleSigner.token("wrong-nonce", clientId, clock),
            EphemeralGoogleSigner.token(challenge.nonce, "untrusted-client", clock))) {
            val client = GoogleCloudPairingClient("https://relay.example.test", clientId, direct, now = { clock })
            try { client.start(challenge, token); fail("Invalid Google identity accepted") } catch (_: CloudIdentityException) { }
            client.close()
        }
    }

    @Test fun `unstarted polling invalid directory certificate and mismatching gateway codes are refused`(): Unit = runBlocking {
        val challenge = challenge()
        val control = control(challenge)
        val pending = CloudPairingConfirmation(challenge, candidate, clock * 1000)
        val client = GoogleCloudPairingClient("https://relay.example.test", clientId, control, now = { clock })
        try { client.poll(pending); fail("Unstarted request polled") } catch (_: CloudPairingException) { }
        client.close()
        val badGateway = FakeCloudTransport { url, _, _ ->
            if (url.endsWith("/challenge")) ISSUED
            else Json.encodeToString(CloudPairingProgress("approved", "000 000", (clock + 100) * 1000, "STOLEN-CODE", CODE_NONCE))
        }
        val refused = GoogleCloudPairingClient("https://relay.example.test", clientId, control(challenge), { badGateway }, { clock })
        try { refused.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock)); fail("Mismatching code accepted") }
        catch (_: CloudPairingException) { }
        refused.close()
        for (origin in listOf("https:/missing-host", "http://relay.example.test", "https://user@relay.example.test", "https://relay.example.test/path",
            "https://relay.example.test?x", "https://relay.example.test#x")) {
            assertThrows(IllegalArgumentException::class.java) { GoogleCloudPairingClient(origin, clientId, control) }
        }
        assertThrows(IllegalArgumentException::class.java) { GoogleCloudPairingClient("https://relay.example.test", "invalid", control) }
    }

    @Test fun `missing relay session account or token cannot reach discovery`(): Unit = runBlocking {
        val challenge = challenge()
        for (session in listOf("{}", "{\"token\":\"synthetic\"}", "{\"accountId\":\"$account\"}", "{\"accountId\":\"$account\",\"token\":null}", "{\"accountId\":\"$account\",\"token\":123}", "{\"accountId\":[],\"token\":\"synthetic\"}", "{\"accountId\":123,\"token\":\"synthetic\"}", "{\"accountId\":\"$account\",\"token\":{}}")) {
            val direct = FakeCloudTransport { url, _, _ ->
                when (url) {
                    "https://www.googleapis.com/oauth2/v3/certs" -> EphemeralGoogleSigner.jwks
                    "https://relay.example.test/_relay/v1/login" -> session
                    else -> error("Incomplete session reached discovery")
                }
            }
            val client = GoogleCloudPairingClient("https://relay.example.test", clientId, direct, now = { clock })
            try { client.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock)); fail("Incomplete session accepted") }
            catch (_: CloudPairingException) { }
            finally { client.close() }
        }
    }

    @Test fun `hybrid Google Android presenter is separately trusted without widening the web audience`() {
        val challenge = challenge()
        val androidId = "fixture-android.apps.googleusercontent.com"
        val verifier = GoogleIdentityVerifier(EphemeralGoogleSigner.jwks, setOf(clientId), setOf(clientId, androidId))
        val token = EphemeralGoogleSigner.token(challenge.nonce, clientId, clock, androidId)
        assertEquals("fictional-owner", verifier.verify(token, challenge.nonce, clock).subject)
        assertThrows(CloudIdentityException::class.java) {
            GoogleIdentityVerifier(EphemeralGoogleSigner.jwks, setOf(clientId)).verify(token, challenge.nonce, clock)
        }
        assertThrows(CloudIdentityException::class.java) {
            verifier.verify(EphemeralGoogleSigner.token(challenge.nonce, androidId, clock, androidId), challenge.nonce, clock)
        }
        assertThrows(CloudIdentityException::class.java) {
            verifier.verify(EphemeralGoogleSigner.token(challenge.nonce, clientId, clock, "untrusted-presenter"), challenge.nonce, clock)
        }
        assertThrows(CloudIdentityException::class.java) { GoogleIdentityVerifier(EphemeralGoogleSigner.jwks, setOf(clientId), emptySet()) }
    }

    @Test fun `close during discovery or polling cannot resurrect approval after a delayed transport response`(): Unit = runBlocking {
        val challenge = challenge()
        for (phase in listOf("keys", "login", "directory", "gateway", "poll")) {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            suspend fun waitIf(stage: String, value: String): String {
                if (stage == phase) { entered.complete(Unit); release.await() }
                return value
            }
            val base = control(challenge)
            val direct = FakeCloudTransport { url, body, bearer ->
                val stage = if (url.endsWith("certs")) "keys" else if (url.endsWith("login")) "login" else "directory"
                waitIf(stage, base.request(url, body, bearer))
            }
            val pinned = FakeCloudTransport { url, _, _ ->
                if (url.endsWith("/challenge")) return@FakeCloudTransport ISSUED
                val stage = if (url.endsWith("poll")) "poll" else "gateway"
                waitIf(stage, progress(challenge, if (stage == "poll") "approved" else "pending", if (stage == "poll") "EXPIRED-CODE" else null))
            }
            val client = GoogleCloudPairingClient("https://relay.example.test", clientId, direct, { pinned }, { clock })
            val work = async { runCatching {
                val value = client.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock))
                if (phase == "poll") client.poll(value)
            } }
            entered.await()
            client.close()
            release.complete(Unit)
            val result = work.await()
            assertTrue(phase, result.exceptionOrNull() is CloudPairingException)
            try { client.start(challenge, "ignored"); fail("Closed client restarted") } catch (_: CloudPairingException) { }
        }
    }

    @Test fun `gateway resource created after close is closed without sending the private challenge`(): Unit = runBlocking {
        val challenge = challenge()
        val direct = control(challenge)
        val pinned = FakeCloudTransport { _, _, _ -> fail("Closed gateway received a pairing secret"); "" }
        lateinit var client: GoogleCloudPairingClient
        client = GoogleCloudPairingClient("https://relay.example.test", clientId, direct, {
            client.close()
            pinned
        }, { clock })
        try { client.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock)); fail("Closed resource registered") }
        catch (_: CloudPairingException) { }
        assertEquals(1, pinned.closes)
        assertEquals(1, direct.closes)
    }

    private suspend fun startAgainst(pinned: FakeCloudTransport): Result<CloudPairingConfirmation> {
        val challenge = challenge()
        val client = GoogleCloudPairingClient("https://relay.example.test", clientId, control(challenge), { pinned }, { clock })
        return runCatching { client.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock)) }.also { client.close() }
    }

    @Test fun `a nonce the gateway did not commit to, or a missing challenge, aborts before any code exists`(): Unit = runBlocking {
        val other = "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY"
        val fingerprint = candidate.candidateFingerprint(clock)
        // The reply's code is right for its nonce; the nonce is simply not the committed one.
        val swapped = FakeCloudTransport { url, _, _ ->
            if (url.endsWith("/challenge")) ISSUED
            else Json.encodeToString(CloudPairingProgress("pending", challenge().comparisonCode(fingerprint, other), (clock + 600) * 1000, null, other))
        }
        assertTrue(startAgainst(swapped).exceptionOrNull() is CloudPairingException)
        // A gateway that predates the commitment sends no nonce at all.
        val old = FakeCloudTransport { url, _, _ ->
            if (url.endsWith("/challenge")) ISSUED
            else """{"status":"pending","verificationCode":"465 774","expiresAt":${(clock + 600) * 1000}}"""
        }
        assertTrue(startAgainst(old).exceptionOrNull() is CloudPairingException)
        // No challenge, no request: the secret is never sent.
        var requests = 0
        val silent = FakeCloudTransport { url, _, _ -> if (url.endsWith("/challenge")) "{}" else { requests++; progress(challenge()) } }
        assertTrue(startAgainst(silent).exceptionOrNull() is CloudPairingException)
        assertEquals(0, requests)
    }

    @Test fun `a nonce that changes on a later poll aborts and leaves no code to show`(): Unit = runBlocking {
        val other = "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY"
        val challenge = challenge()
        val fingerprint = candidate.candidateFingerprint(clock)
        val pinned = FakeCloudTransport { url, _, _ ->
            when {
                url.endsWith("/challenge") -> ISSUED
                url.endsWith("/request") -> progress(challenge)
                else -> Json.encodeToString(CloudPairingProgress("approved", challenge.comparisonCode(fingerprint, other), (clock + 600) * 1000, "STOLEN", other))
            }
        }
        val client = GoogleCloudPairingClient("https://relay.example.test", clientId, control(challenge), { pinned }, { clock })
        val pending = client.start(challenge, EphemeralGoogleSigner.token(challenge.nonce, clientId, clock))
        assertEquals(challenge.comparisonCode(fingerprint, CODE_NONCE), pending.verificationCode)
        try { client.poll(pending); fail("Changed nonce accepted") } catch (_: CloudPairingException) { }
        assertNull(pending.verificationCode); assertFalse(pending.approved)
        client.close()
    }
}

private class FakeCloudTransport(private val handler: suspend (String, String?, String?) -> String) : CloudPairingTransport {
    var closes = 0; private set
    override suspend fun request(url: String, body: String?, bearer: String?): String = handler(url, body, bearer)
    override fun close() { closes += 1 }
}

/** A fresh in-memory test signer exercises the production verifier; no private key enters a fixture. */
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

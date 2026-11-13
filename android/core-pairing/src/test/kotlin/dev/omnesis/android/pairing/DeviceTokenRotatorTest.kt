// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

class DeviceTokenRotatorTest {
    private val spki = "a".repeat(64)
    private val deviceId = "device-a"
    private val challenge = "c".repeat(43)
    private val day = 24L * 60 * 60 * 1000
    private val start = 1_800_000_000_000L
    private val client = OkHttpClient()

    private fun service(store: InMemoryStore = InMemoryStore(), recorded: Boolean = true): PairingService {
        store.set("gateway.credential.v1", OmnesisJson.encodeToString(PairingCredentialBundle(
            url = "https://gateway.example.test", token = "old-token", pairingGeneration = "old-generation", accountId = "local",
            deviceId = deviceId, name = "Test phone", scopes = listOf("read"), tlsMode = "pinned-key-strict", spkiFingerprint = spki,
            deviceKeyRecorded = recorded, tokenRotatedAt = start,
        )))
        return PairingService(store, cloudRelay = true)
    }

    private fun http(server: MockWebServer, pairing: Pairing) = GatewayHttp(client, server.url("/"), pairing.token, pairing.pairingGeneration)

    @Test fun `not due before 30 days or for a pairing with no recorded key`() {
        val key = softwareDeviceKey()
        val paired = service().current()!!
        assertFalse(DeviceTokenRotator({ key }, { start + 29 * day }).due(paired))
        assertTrue(DeviceTokenRotator({ key }, { start + 30 * day }).due(paired))
        assertFalse(DeviceTokenRotator({ key }, { start + 31 * day }).due(service(recorded = false).current()!!))
    }

    @Test fun `a due token signs the challenge and the new token replaces the old one atomically`(): Unit = runBlocking {
        val key = softwareDeviceKey()
        val store = InMemoryStore(); val pairingService = service(store)
        val pairing = pairingService.current()!!
        val later = start + 31 * day
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"challenge":"$challenge","expiresAt":1}"""))
            server.enqueue(MockResponse().setBody("""{"token":"new-token","tokenId":"new-generation"}"""))
            assertTrue(DeviceTokenRotator({ key }, { later }).rotate(pairing, http(server, pairing), pairingService))
            val first = server.takeRequest(); val second = server.takeRequest()
            assertEquals("/devices/token/challenge", first.path)
            assertEquals("Bearer old-token", first.getHeader("Authorization"))
            assertEquals("/devices/token/rotate", second.path)
            val body = Json.parseToJsonElement(second.body.readUtf8()).jsonObject
            assertEquals(setOf("challenge", "signature"), body.keys)
            assertEquals(challenge, body["challenge"]!!.jsonPrimitive.content)
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getUrlDecoder().decode(key.publicKey))))
            verifier.update(DeviceEnrollmentContract.tokenRotationTranscript(deviceId, spki, challenge, key.publicKey))
            assertTrue(verifier.verify(Base64.getUrlDecoder().decode(body["signature"]!!.jsonPrimitive.content)))
        }
        val updated = pairingService.current()!!
        assertEquals("new-token", updated.token)
        assertEquals("new-generation", updated.pairingGeneration)
        assertEquals(later, updated.tokenRotatedAt)
        assertEquals(1, store.get("gateway.credential.v1")!!.split("new-token").size - 1)
        assertFalse(DeviceTokenRotator({ key }, { later + 1 }).due(updated))
    }

    @Test fun `a gateway without the routes or any failure keeps the working token`(): Unit = runBlocking {
        val key = softwareDeviceKey()
        for (responses in listOf(
            listOf(MockResponse().setResponseCode(404)),
            listOf(MockResponse().setBody("""{"challenge":"$challenge"}"""), MockResponse().setResponseCode(403)),
            listOf(MockResponse().setBody("""{"challenge":"$challenge"}"""), MockResponse().setBody("not json")),
        )) {
            val pairingService = service()
            val pairing = pairingService.current()!!
            MockWebServer().use { server ->
                responses.forEach(server::enqueue)
                assertFalse(DeviceTokenRotator({ key }, { start + 31 * day }).rotate(pairing, http(server, pairing), pairingService))
            }
            assertEquals("old-token", pairingService.current()!!.token)
            assertEquals(start, pairingService.current()!!.tokenRotatedAt)
        }
    }

    @Test fun `a re-pair during rotation is not overwritten`() {
        val pairingService = service()
        val stale = pairingService.current()!!.copy(token = "earlier-token")
        assertFalse(pairingService.replaceToken(stale, "new-token", "new-generation", start))
        assertEquals("old-token", pairingService.current()!!.token)
    }

    @Test fun `a QR pairing's stored credential gains no enrollment fields until a sign-in records a key`() {
        val store = InMemoryStore()
        store.set("gateway.credential.v1", OmnesisJson.encodeToString(PairingCredentialBundle(
            url = "https://gateway.example.test", token = "token", accountId = "local", deviceId = deviceId, name = "Test phone",
            scopes = emptyList(), tlsMode = "system",
        )))
        assertFalse(store.get("gateway.credential.v1")!!.contains("deviceKeyRecorded"))
        val service = PairingService(store, cloudRelay = true)
        assertFalse(service.current()!!.deviceKeyRecorded)
        val marked = service.markDeviceKeyRecorded(start)
        assertTrue(marked.deviceKeyRecorded)
        assertEquals(start, marked.tokenRotatedAt)
    }
}

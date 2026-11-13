// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing.e2e

import dev.omnesis.android.pairing.CloudPairingHTTP
import dev.omnesis.android.pairing.DeviceTokenRotator
import dev.omnesis.android.pairing.InMemoryStore
import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingCredentialBundle
import dev.omnesis.android.pairing.PairingService
import dev.omnesis.android.pairing.PublicCertificateCheck
import dev.omnesis.android.pairing.softwareDeviceKey
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.GatewayClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.tls.PinnedOkHttp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.security.cert.X509Certificate

/**
 * Sign-in enrollment's device-key half against a real gateway started with the cloud flag on,
 * through the real pinned TLS clients. Run by `scripts/run-android-e2e.sh`; anywhere else every
 * case skips.
 *
 * Recording a device key on a gateway takes a sign-in, so a gateway linked to a relay account and
 * a real Google or passkey sign-in: the core-pairing unit tests cover that request and the token
 * rotation it enables against the wire contract, and they remain physical-device QA. Here the
 * production [DeviceTokenRotator] meets the real rotation routes with a device that holds no key.
 */
class DeviceEnrollmentLiveE2ETest {
    @Serializable private data class Config(val gatewayURL: String, val apiToken: String, val tlsFingerprint: String)

    private lateinit var config: Config
    private lateinit var client: OkHttpClient
    private lateinit var admin: GatewayHttp
    private lateinit var gatewaySpki: String
    private lateinit var presented: List<X509Certificate>

    @Before fun setUp() {
        assumeTrue("live-gateway E2E not enabled — run via scripts/run-android-e2e.sh", System.getProperty("omnesis.android.e2e") == "1")
        val file = File(CONFIG_PATH)
        assumeTrue("no live-gateway config at $CONFIG_PATH", file.exists())
        config = OmnesisJson.decodeFromString(file.readText())
        client = PinnedOkHttp.build(config.tlsFingerprint, requirePin = true)
        admin = GatewayHttp(client, config.gatewayURL, config.apiToken)
        // The production transport a sign-in uses to reach a gateway; its chain feeds the public check.
        gatewaySpki = runBlocking {
            CloudPairingHTTP(config.tlsFingerprint).use { pinned ->
                pinned.request("${config.gatewayURL.trimEnd('/')}/health")
                presented = pinned.peerCertificates
                sha256Hex(presented.first().publicKey.encoded)
            }
        }
    }

    @After fun tearDown() {
        if (::client.isInitialized) { client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
    }

    private fun deviceHttp(pairing: Pairing) = GatewayHttp(client, pairing.url, pairing.token, pairing.pairingGeneration)
    private suspend fun whoami(token: String) = GatewayClient(GatewayHttp(client, config.gatewayURL, token)).whoami()

    @Test fun `a device that never recorded a key keeps its token`() = runBlocking {
        val me = GatewayClient(admin).whoami()
        val store = InMemoryStore()
        store.set("gateway.credential.v1", OmnesisJson.encodeToString(PairingCredentialBundle(
            url = config.gatewayURL, token = config.apiToken, accountId = "local", deviceId = me.deviceId!!, name = "Owner",
            scopes = emptyList(), tlsMode = "pinned-key-strict", spkiFingerprint = gatewaySpki,
            // Claimed here to prove the gateway, not the flag, is what refuses.
            deviceKeyRecorded = true, tokenRotatedAt = 0,
        )))
        val service = PairingService(store, cloudRelay = true)
        val pairing = service.current()!!
        assertFalse(DeviceTokenRotator({ softwareDeviceKey() }).rotate(pairing, deviceHttp(pairing), service))
        assertEquals(config.apiToken, service.current()!!.token)
        assertEquals(me.deviceId, whoami(config.apiToken).deviceId)
    }

    @Test fun `the pinned connection hands the real chain to the public check, and a self-signed gateway asks for approval`() {
        assertEquals(sha256Hex(presented.first().encoded), config.tlsFingerprint.lowercase())
        assertFalse(PublicCertificateCheck().accepts(presented, java.net.URI(config.gatewayURL).host))
    }

    @Test fun `a gateway with no linked account has no enrollment setting to show`() = runBlocking {
        // The Omnesis account screen shows "New devices" only beside a linked account.
        assertTrue(AdminClient(admin).cloudRelayStatus().account?.linked != true)
    }

    private companion object {
        const val CONFIG_PATH = "/tmp/omnesis-android-e2e-config.json"

        fun sha256Hex(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}

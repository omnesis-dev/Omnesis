// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.HostedSourceContract
import dev.omnesis.android.transport.SourceMultiDeviceMode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class PairingServiceTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun service(store: SecureStore) =
        PairingService(
            store,
            deviceName = "Pixel 7",
            deviceCapabilities = DeviceCapabilities.android(
                listOf(
                    HostedSourceContract("health-connect", SourceMultiDeviceMode.PARTITIONED),
                    HostedSourceContract("android-call-log", SourceMultiDeviceMode.PARTITIONED),
                    HostedSourceContract("android-app-usage", SourceMultiDeviceMode.PARTITIONED),
                    HostedSourceContract("android-activity-segments", SourceMultiDeviceMode.PARTITIONED),
                    HostedSourceContract("photos"),
                ),
                pushAppId = "dev.omnesis.android",
            ),
            clientFactory = {
                OkHttpClient.Builder().addInterceptor { chain ->
                    val original = chain.request()
                    chain.proceed(
                        original.newBuilder()
                            .url(server.url(original.url.encodedPath))
                            .build(),
                    )
                }.build()
            },
        )

    private fun baseUrl() = "https://gateway.example.com"

    @Test
    fun pairManually_persists_and_exposes_current() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-1","name":"Studio Northstar","kind":"android"},"tokenId":"tid","token":"secret-token","scopes":["read","write","admin"]}""",
            ),
        )
        val store = InMemoryStore()
        val pairing = service(store).pairManually(baseUrl(), "AB-CD-EF")

        assertEquals("secret-token", pairing.token)
        assertEquals("tid", pairing.pairingGeneration)
        assertEquals("dev-1", pairing.deviceId)
        assertEquals("Studio Northstar", pairing.gatewayName)
        assertEquals(listOf("read", "write", "admin"), pairing.scopes)
        assertEquals("local", pairing.accountId)

        // The complete credential/trust tuple is one atomic encrypted value.
        val credential = OmnesisJson.decodeFromString<PairingCredentialBundle>(
            requireNotNull(store.get("gateway.credential.v1")),
        )
        assertEquals("secret-token", credential.token)
        assertEquals("local", credential.accountId)
        assertNull(store.get("gateway.fingerprint"))
        assertEquals(pairing, service(store).current())

        // Request shape sent to the gateway.
        val req = server.takeRequest()
        assertEquals("/devices/pair", req.path)
        val body = OmnesisJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("AB-CD-EF", body["pairingCode"]?.jsonPrimitive?.content)
        val caps = body["capabilities"]?.jsonObject
        assertEquals("android", caps?.get("platform")?.jsonPrimitive?.content)
        // Self-naming: the model plus a slice of the per-install identity, so
        // two identical phones never resolve to one device row.
        val installId = requireNotNull(caps?.get("installId")?.jsonPrimitive?.content)
        assertTrue(installId.matches(Regex("[0-9a-f-]{36}")))
        assertEquals("Pixel 7-${installId.take(6)}", caps?.get("suggestedName")?.jsonPrimitive?.content)
        assertNull(caps?.get("previousDeviceId"))
        assertEquals(
            "partitioned",
            caps?.get("multiDeviceModes")?.jsonObject?.get("health-connect")?.jsonPrimitive?.content,
        )
        assertEquals(
            "partitioned",
            caps?.get("multiDeviceModes")?.jsonObject
                ?.get("android-activity-segments")?.jsonPrimitive?.content,
        )
        assertEquals(
            "partitioned",
            caps?.get("multiDeviceModes")?.jsonObject
                ?.get("android-call-log")?.jsonPrimitive?.content,
        )
        assertEquals(
            "partitioned",
            caps?.get("multiDeviceModes")?.jsonObject
                ?.get("android-app-usage")?.jsonPrimitive?.content,
        )
        assertTrue(caps?.get("hostableSourceTypes")?.jsonArray?.any {
            it.jsonPrimitive.content == "health-connect"
        } == true)
        assertEquals("dev.omnesis.android", caps?.get("pushAppId")?.jsonPrimitive?.content)
        assertNull(caps?.get("syncLease"))
    }

    @Test
    fun old_gateway_response_without_token_id_keeps_legacy_generation_null() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-legacy","name":"Legacy","kind":"android"},"token":"legacy-token","scopes":[]}""",
            ),
        )
        val pairing = service(InMemoryStore()).pairManually(baseUrl(), "LEGACY")
        assertNull(pairing.pairingGeneration)
    }

    @Test
    fun repair_sends_the_same_install_id_and_the_previous_device_id() = runTest {
        val body = """{"device":{"id":"dev-1","name":"Studio Northstar","kind":"android"},"tokenId":"tid","token":"secret-token","scopes":["read"]}"""
        server.enqueue(MockResponse().setBody(body))
        server.enqueue(MockResponse().setBody(body))
        val store = InMemoryStore()
        service(store).pairManually(baseUrl(), "AB-CD-EF")
        val first = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject["capabilities"]?.jsonObject
        service(store).pairManually(baseUrl(), "GH-IJ-KL")
        val second = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject["capabilities"]?.jsonObject

        // The identity is minted once and persisted in the store.
        assertEquals(first?.get("installId"), second?.get("installId"))
        // A re-pair names the row this install was paired as before.
        assertEquals("dev-1", second?.get("previousDeviceId")?.jsonPrimitive?.content)
    }

    @Test
    fun unpair_keeps_the_install_identity_so_a_repair_adopts_the_same_row() = runTest {
        val body = """{"device":{"id":"dev-1","name":"Studio Northstar","kind":"android"},"tokenId":"tid","token":"secret-token","scopes":["read"]}"""
        server.enqueue(MockResponse().setBody(body))
        server.enqueue(MockResponse().setBody(body))
        val store = InMemoryStore()
        val svc = service(store)
        svc.pairManually(baseUrl(), "AB-CD-EF")
        val first = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject["capabilities"]?.jsonObject
        val installId = requireNotNull(first?.get("installId")?.jsonPrimitive?.content)

        svc.unpair()
        assertNull(svc.current())
        assertEquals(installId, store.get("install.id"))

        // Unpaired, the phone no longer remembers a device id, but its identity
        // still lets the gateway adopt the row it had.
        svc.pairManually(baseUrl(), "GH-IJ-KL")
        val second = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject["capabilities"]?.jsonObject
        assertEquals(installId, second?.get("installId")?.jsonPrimitive?.content)
        assertNull(second?.get("previousDeviceId"))
    }

    @Test
    fun v4_system_trust_uses_platform_client_and_persists_explicit_mode() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-public","name":"Public gateway","kind":"android"},"tokenId":"tid","token":"secret-token","scopes":["read"]}""",
            ),
        )
        val fingerprints = mutableListOf<String?>()
        val store = InMemoryStore()
        val svc = PairingService(
            store,
            deviceName = "Pixel",
            clientFactory = { fingerprint ->
                fingerprints += fingerprint
                OkHttpClient.Builder().addInterceptor { chain ->
                    val original = chain.request()
                    val target = server.url(original.url.encodedPath)
                    chain.proceed(original.newBuilder().url(target).build())
                }.build()
            },
        )

        val payload = """{"v":4,"gatewayUrl":"https://public-gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"system"}}"""
        val pairing = svc.pair(payload)

        assertEquals(PairingTlsMode.SYSTEM, pairing.tlsMode)
        val credential = OmnesisJson.decodeFromString<PairingCredentialBundle>(
            requireNotNull(store.get("gateway.credential.v1")),
        )
        assertEquals(PairingTlsMode.SYSTEM.persistedValue, credential.tlsMode)
        assertNull(pairing.fingerprint)
        assertEquals(listOf<String?>(null), fingerprints)
    }

    @Test
    fun current_is_null_when_unpaired() {
        assertNull(service(InMemoryStore()).current())
    }

    @Test
    fun interrupted_legacy_cleanup_never_exposes_mixed_or_downgraded_pairing() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-public","name":"Public gateway","kind":"android"},"tokenId":"tid","token":"new-token","scopes":["read"]}""",
            ),
        )
        val store = InterruptingCleanupStore().apply {
            set("gateway.url", "http://old-gateway.example.com")
            set("gateway.token", "old-token")
            set("gateway.accountId", "local")
            set("gateway.deviceId", "old-device")
            set("gateway.name", "Old gateway")
        }
        val svc = PairingService(
            store,
            clientFactory = {
                OkHttpClient.Builder().addInterceptor { chain ->
                    chain.proceed(chain.request().newBuilder().url(server.url("/devices/pair")).build())
                }.build()
            },
        )

        val pairing = svc.pair(
            """{"v":4,"gatewayUrl":"https://public-gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"system"}}""",
        )

        assertEquals("new-token", pairing.token)
        assertEquals(PairingTlsMode.SYSTEM, pairing.tlsMode)
        assertEquals("https://public-gateway.example.com", pairing.url)
        assertEquals(pairing, PairingService(store).current())
    }

    @Test
    fun current_infers_pinned_leaf_for_existing_v3_state_without_mode_key() {
        val store = InMemoryStore().apply {
            set("gateway.url", "https://gateway.example.com")
            set("gateway.token", "secret-token")
            set("gateway.accountId", "local")
            set("gateway.deviceId", "dev-legacy-v3")
            set("gateway.name", "Existing gateway")
            set("gateway.fingerprint", "a".repeat(64))
        }

        val pairing = service(store).current()

        assertEquals(PairingTlsMode.PINNED_LEAF, pairing?.tlsMode)
        assertEquals("a".repeat(64), pairing?.fingerprint)
    }

    @Test
    fun current_rejects_explicit_pinned_state_without_a_valid_fingerprint() {
        val store = InMemoryStore().apply {
            set("gateway.url", "https://gateway.example.com")
            set("gateway.token", "secret-token")
            set("gateway.accountId", "local")
            set("gateway.deviceId", "dev-corrupt")
            set("gateway.name", "Corrupt gateway")
            set("gateway.tlsMode", "pinned-leaf")
            set("gateway.fingerprint", "invalid")
        }

        assertNull(service(store).current())
    }

    @Test
    fun current_rejects_unknown_explicit_tls_mode_instead_of_inferring_legacy() {
        val store = InMemoryStore().apply {
            set("gateway.url", "https://gateway.example.com")
            set("gateway.token", "secret-token")
            set("gateway.accountId", "local")
            set("gateway.deviceId", "dev-newer")
            set("gateway.name", "Newer gateway")
            set("gateway.tlsMode", "system-v2")
        }

        assertNull(service(store).current())
    }

    @Test
    fun current_rejects_persisted_plaintext_pairings() {
        val splitStore = InMemoryStore().apply {
            set("gateway.url", "http://gateway.example.com")
            set("gateway.token", "secret-token")
            set("gateway.accountId", "local")
            set("gateway.deviceId", "dev-old")
            set("gateway.name", "Old gateway")
        }
        assertNull(service(splitStore).current())

        val bundleStore = InMemoryStore().apply {
            set(
                "gateway.credential.v1",
                OmnesisJson.encodeToString(
                    PairingCredentialBundle(
                        url = "http://gateway.example.com",
                        token = "secret-token",
                        accountId = "local",
                        deviceId = "dev-old",
                        name = "Old gateway",
                        scopes = listOf("read"),
                        tlsMode = PairingTlsMode.LEGACY.persistedValue,
                    ),
                ),
            )
        }
        assertNull(service(bundleStore).current())
    }

    @Test
    fun manual_pairing_rejects_plaintext_before_network_access() = runTest {
        val failure = runCatching {
            service(InMemoryStore()).pairManually("http://gateway.example.com", "CODE")
        }.exceptionOrNull()
        assertTrue(failure is PairingPayloadException)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun invalid_v4_system_origin_is_rejected_before_exchange_or_persistence() = runTest {
        val store = InMemoryStore()
        val svc = service(store)

        try {
            svc.pair(
                """{"v":4,"gatewayUrl":"https://public-gateway.example.com/hidden","pairingCode":"AB-CD","tls":{"mode":"system"}}""",
            )
            fail("expected invalid system-trust origin")
        } catch (_: PairingPayloadException) {
            // Expected before any network exchange.
        }

        assertEquals(0, server.requestCount)
        assertNull(svc.current())
    }

    @Test
    fun system_trust_url_update_rejects_plaintext_and_authority_changes() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-public","name":"Public gateway","kind":"android"},"tokenId":"tid","token":"secret-token","scopes":["read"]}""",
            ),
        )
        val store = InMemoryStore()
        val svc = PairingService(
            store,
            clientFactory = {
                OkHttpClient.Builder().addInterceptor { chain ->
                    chain.proceed(chain.request().newBuilder().url(server.url("/devices/pair")).build())
                }.build()
            },
        )
        svc.pair(
            """{"v":4,"gatewayUrl":"https://public-gateway.example.com","pairingCode":"AB-CD","tls":{"mode":"system"}}""",
        )

        assertThrows(PairingPayloadException::class.java) {
            svc.updateGatewayURL("http://public-gateway.example.com")
        }
        assertThrows(PairingPayloadException::class.java) {
            svc.updateGatewayURL("https://other.example.com")
        }
        svc.updateGatewayURL("https://public-gateway.example.com/")
        assertEquals("https://public-gateway.example.com/", svc.current()?.url)
    }

    @Test
    fun unpair_clears_state() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-1","name":"GW","kind":"android"},"tokenId":"t","token":"tok","scopes":[]}""",
            ),
        )
        val store = InMemoryStore()
        val svc = service(store)
        svc.pairManually(baseUrl(), "CODE")
        svc.unpair()
        assertNull(svc.current())
    }

    @Test
    fun staged_unpair_survives_restart_until_remote_revocation_settles() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-1","name":"GW","kind":"android"},"tokenId":"generation-1","token":"tok","scopes":[]}""",
            ),
        )
        val store = InMemoryStore()
        val svc = service(store)
        svc.pairManually(baseUrl(), "CODE")

        val staged = svc.stageUnpair()
        assertNull(svc.current())
        assertEquals("generation-1", staged?.pairingGeneration)
        assertEquals(staged, service(store).pendingRevocation())

        service(store).settlePendingRevocation(requireNotNull(staged))
        assertNull(service(store).pendingRevocation())
    }

    @Test
    fun revocation_outbox_keeps_two_offline_unpairs_and_settles_exact_generation() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-a","name":"Fictional Phone","kind":"android"},"tokenId":"generation-a","token":"tok-a","scopes":[]}""",
            ),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-b","name":"Fictional Tablet","kind":"android"},"tokenId":"generation-b","token":"tok-b","scopes":[]}""",
            ),
        )
        val store = InMemoryStore()
        val svc = service(store)
        val first = svc.pairManually(baseUrl(), "CODE-A")
        svc.stageUnpair()
        val second = svc.pairManually(baseUrl(), "CODE-B")
        svc.stageUnpair()

        val relaunched = service(store)
        assertEquals(first, relaunched.pendingRevocation())
        relaunched.settlePendingRevocation(first)
        assertEquals(second, relaunched.pendingRevocation())
        relaunched.settlePendingRevocation(second)
        assertNull(relaunched.pendingRevocation())
    }

    @Test
    fun updateGatewayURL_changes_only_url() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"device":{"id":"dev-1","name":"GW","kind":"android"},"tokenId":"t","token":"tok","scopes":[]}""",
            ),
        )
        val store = InMemoryStore()
        val svc = service(store)
        svc.pairManually(baseUrl(), "CODE")
        svc.updateGatewayURL("https://gateway.tailnet.ts.net:7600")
        val updated = svc.current()
        assertEquals("https://gateway.tailnet.ts.net:7600", updated?.url)
        assertEquals("tok", updated?.token)
    }

    @Test
    fun push_claim_credential_is_device_bound_and_cleared_on_unpair() {
        val svc = service(InMemoryStore())
        svc.setPushClaimCredential("device-a", "narrow-token")
        assertEquals("narrow-token", svc.pushClaimCredential("device-a"))
        assertNull(svc.pushClaimCredential("device-b"))
        svc.unpair()
        assertNull(svc.pushClaimCredential("device-a"))
    }

    private class InterruptingCleanupStore : SecureStore {
        private val delegate = InMemoryStore()
        private var interrupted = false

        override fun get(key: String): String? = delegate.get(key)

        override fun set(key: String, value: String) = delegate.set(key, value)

        override fun delete(key: String) {
            if (key == "gateway.url" && !interrupted) {
                interrupted = true
                throw IllegalStateException("simulated process interruption")
            }
            delegate.delete(key)
        }

        override fun deleteAll() = delegate.deleteAll()

        override fun replaceAll(values: Map<String, String>) = delegate.replaceAll(values)
    }
}

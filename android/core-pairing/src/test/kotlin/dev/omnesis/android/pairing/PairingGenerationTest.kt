// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class PairingGenerationTest {
    private val key = "a1".repeat(32)
    private val qr get() = """{"v":4,"gatewayUrl":"https://gateway.example.test","pairingCode":"SYNTHETIC","tls":{"mode":"pinned-key-strict","spkiFingerprint":"$key"}}"""
    private val direct = """{"v":1,"url":"https://direct.example.test","token":"replacement","accountId":"other-device","name":"Direct"}"""

    @Test fun delayedDiscoveryCannotResurrectOrReplaceExplicitChanges() = runTest {
        for (replace in listOf(false, true)) {
            MockWebServer().use { server ->
                server.start()
                server.enqueue(reply())
                val started = CompletableDeferred<Unit>()
                val release = CompletableDeferred<List<DirectGatewayCandidate>>()
                val store = InMemoryStore()
                val service = service(server, store) { started.complete(Unit); release.await() }
                val pending = async { service.pair(qr) }
                started.await()
                val replacement = if (replace) service.pair(direct) else { service.unpair(); null }
                release.complete(listOf(DirectGatewayCandidate("192.168.1.2", 7600)))
                try { pending.await(); fail("Stale pairing committed") } catch (_: CancellationException) { }
                assertEquals(replacement, service.current())
            }
        }
    }

    @Test fun factsPersistWithoutChangingDeviceIdentityAndSurviveRevocationJournal() = runTest {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(reply())
            val facts = listOf(DirectGatewayCandidate("10.3.2.1", 7600))
            val service = service(server, InMemoryStore()) { facts }
            val pairing = service.pair(qr)
            assertEquals(key, pairing.spkiFingerprint)
            assertNull(pairing.fingerprint)
            assertEquals("synthetic-token", pairing.token)
            assertEquals(facts, pairing.directCandidates)
            assertEquals(pairing, service.current())
            assertEquals(pairing, service.stageUnpair())
            assertNull(service.current())
            assertEquals(pairing, service.pendingRevocation())
            service.settlePendingRevocation(pairing)
            assertNull(service.pendingRevocation())
        }
    }

    @Test fun optionalUnavailableFactsKeepStrictAuthorityButMalformedFactsDoNotCommit() = runTest {
        MockWebServer().use { server ->
            server.start(); server.enqueue(reply())
            var malformed = false
            val service = service(server, InMemoryStore()) {
                if (!malformed) throw java.net.SocketTimeoutException("synthetic offline")
                listOf(DirectGatewayCandidate("8.8.8.8", 443))
            }
            val pairing = service.pair(qr)
            assertEquals(key, pairing.spkiFingerprint)
            assertTrue(pairing.directCandidates.isEmpty())
            assertEquals("synthetic-token", pairing.token)
            malformed = true
            server.enqueue(reply())
            try { service.pair(qr); fail("Malformed facts committed") } catch (_: IllegalArgumentException) { }
            assertEquals(pairing, service.current())
        }
    }

    @Test fun discoveryCancellationDoesNotPersist() = runTest {
        MockWebServer().use { server ->
            server.start(); server.enqueue(reply())
            val service = service(server, InMemoryStore()) { throw CancellationException("synthetic cancel") }
            try { service.pair(qr); fail("Cancelled pairing persisted") } catch (_: CancellationException) { }
            assertNull(service.current())
        }
    }

    @Test fun cancelledLegacyOrManualEntryCannotPublishCredentials() = runTest {
        for (manual in listOf(false, true)) {
            MockWebServer().use { server ->
                server.start()
                val store = InMemoryStore()
                val service = service(server, store) { emptyList() }
                var rejected = false
                val job = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                    coroutineContext[kotlinx.coroutines.Job]!!.cancel()
                    try {
                        if (manual) service.pairManually("https://gateway.example.test", "SYNTHETIC") else service.pair(direct)
                    } catch (_: CancellationException) { rejected = true }
                }
                job.join()
                assertTrue(rejected)
                assertNull(service.current())
                assertEquals(0, server.requestCount)
            }
        }
    }

    private fun reply() = MockResponse().setBody("""{"device":{"id":"synthetic-device","name":"Test gateway","kind":"android"},"tokenId":"generation","token":"synthetic-token","scopes":["read","admin"]}""")

    private fun service(server: MockWebServer, store: SecureStore, facts: suspend () -> List<DirectGatewayCandidate>): PairingService {
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            chain.proceed(chain.request().newBuilder().url(server.url(chain.request().url.encodedPath)).build())
        }.build()
        return PairingService(store, keyClientFactory = { _, _ -> client }, fetchDirectCandidates = { _, _, _ -> facts() })
    }
}

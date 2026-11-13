// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import android.os.Looper
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.test.core.app.ApplicationProvider
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import dagger.hilt.EntryPoints
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.pairing.CloudPairingChallenge
import dev.omnesis.android.pairing.CloudPairingException
import dev.omnesis.android.ui.home.HomeScaffoldHarnessEntryPoint
import dev.omnesis.android.ui.home.MockGateway
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.lang.reflect.Proxy

/** The Hilt constructor and its production callbacks, using an isolated real TLS gateway. */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34])
class GoogleDefaultCompositionTest {
    @get:Rule val hilt = HiltAndroidRule(this)
    private val application get() = ApplicationProvider.getApplicationContext<HiltTestApplication>()
    private val graph get() = EntryPoints.get(application, HomeScaffoldHarnessEntryPoint::class.java)
    private val gateway = MockGateway()
    private val clientId = "synthetic.apps.googleusercontent.com"

    // These cases run the graph as a build with cloud connectivity.
    init { dev.omnesis.android.ui.home.HomeScaffoldTestModule.cloudRelay = true }

    @After fun close() {
        try {
            graph.sessionManager().beginRepair()
            gateway.close()
        } finally { dev.omnesis.android.ui.home.HomeScaffoldTestModule.cloudRelay = false }
    }

    @Test fun `public injected constructor stages and confirms QR through its real session getter`() {
        val vm = PairingViewModel(graph.sessionManager())
        vm.pairFromQr(payload())
        assertEquals(PairingViewModel.TrustKind.PinnedLeaf, vm.state.value.pending!!.trustKind)
        assertNull(graph.pairingService().current())
        vm.confirmPending()
        await { graph.pairingService().current() != null }
        val paired = graph.pairingService().current()!!
        assertEquals("device-test", paired.deviceId)
        assertEquals(gateway.url.trimEnd('/'), paired.url.trimEnd('/'))
        assertTrue("POST /devices/pair" in gateway.requests)
    }

    @Test fun `configured production callbacks carry OAuth nonce preserve provider errors and apply strict TLS QR`() = runBlocking {
        val challenge = CloudPairingChallenge.create("Synthetic phone")
        assertNotNull(GooglePairingDefaults.credentialManager(application))
        var providerCalls = 0
        val providerError = IllegalStateException("owned provider cancellation")
        val manager = Proxy.newProxyInstance(CredentialManager::class.java.classLoader,
            arrayOf(CredentialManager::class.java)) { _, method, args ->
            check(method.name == "getCredential")
            val request = args!![1] as GetCredentialRequest
            val option = request.credentialOptions.single() as GetSignInWithGoogleOption
            assertEquals(clientId, option.serverClientId)
            assertEquals(challenge.nonce, option.nonce)
            if (++providerCalls == 2) throw providerError
            val credential = GoogleIdTokenCredential.Builder().setId("synthetic-account")
                .setIdToken("provider-test-token").build()
            GetCredentialResponse(CustomCredential(GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL, credential.data))
        } as CredentialManager
        val ports = GooglePairingDefaults.configuredPorts(graph.sessionManager(), "https://relay.example.test",
            clientId, "synthetic-android.apps.googleusercontent.com") { context ->
            assertSame(application, context)
            manager
        }
        val token = ports.acquireToken(application, challenge.nonce)
        assertEquals("provider-test-token", token)
        try { ports.acquireToken(application, challenge.nonce); fail("Provider error was swallowed") }
        catch (actual: IllegalStateException) { assertSame(providerError, actual) }
        val client = ports.createClient()
        client.close()
        // A retired production client fails before Google's JWKS or relay network request.
        try { client.start(challenge, token); fail("Retired client started") }
        catch (_: CloudPairingException) { }
        val invalid = GooglePairingDefaults.configuredPorts(graph.sessionManager(), "http://relay.example.test",
            clientId, clientId) { manager }
        assertThrows(IllegalArgumentException::class.java) { invalid.createClient() }
        ports.applyPairing(payload())
        assertEquals("device-test", graph.pairingService().current()!!.deviceId)
        val saved = graph.pairingService().current()
        try { ports.applyPairing("malformed QR"); fail("Malformed replacement was persisted") }
        catch (_: Exception) { }
        assertEquals(saved, graph.pairingService().current())
        assertEquals(1, gateway.requests.count { it == "POST /devices/pair" })
    }

    @Test fun `live key-paired session refreshes hints without replacing clients and late metadata cannot restore retired authority`() = runBlocking {
        val manager = graph.sessionManager()
        manager.beginForegroundVisit() // unpaired visits cannot create a socket
        val keyPayload = """{"v":4,"gatewayUrl":"${gateway.url.trimEnd('/')}","pairingCode":"ABCD-EFGH","tls":{"mode":"pinned-key-strict","spkiFingerprint":"${gateway.spkiFingerprint}"}}"""
        manager.pairFromQr(keyPayload)
        val active = manager.session!!
        val old = active.pairing
        val clients = active.gateway
        gateway.directCandidatesJson = """{"version":1,"candidates":[{"address":"10.0.0.2","port":9443}]}"""
        active.socket.refreshDirectPath()
        val updated = graph.pairingService().current()!!
        assertEquals(listOf(dev.omnesis.android.transport.routing.DirectGatewayCandidate("10.0.0.2", 9443)), updated.directCandidates)
        assertEquals(old.copy(directCandidates = updated.directCandidates), updated)
        assertSame(active, manager.session)
        assertSame(clients, manager.session!!.gateway)
        assertEquals(updated, (manager.state.value as dev.omnesis.android.session.SessionManager.AppState.Paired).pairing)
        val discovery = gateway.recordedRequests.last { it.path == "/devices/direct-candidates" }
        assertEquals("Bearer token-test", discovery.getHeader("Authorization"))
        manager.beginForegroundVisit()
        manager.beginRepair()
        manager.acceptDirectCandidates(updated)
        assertNull(manager.session)
        assertNull(graph.pairingService().current())
        manager.pairFromQr(payload())
        val replacement = manager.session!!
        manager.acceptDirectCandidates(updated)
        assertSame(replacement, manager.session)
        assertEquals(dev.omnesis.android.pairing.PairingTlsMode.PINNED_LEAF_STRICT, replacement.pairing.tlsMode)
    }

    @Test fun `trusted approval client is available only to an established admin session`() = runBlocking {
        val manager = graph.sessionManager()
        val vm = dev.omnesis.android.ui.devices.DevicesViewModel(manager, dev.omnesis.android.access.PairingPendingRequests())
        assertNull(vm.pairingApprovalClient(cloudEnabled = true))
        gateway.pairingScopesJson = "[\"read\"]"
        manager.pairFromQr(payload())
        assertNull(vm.pairingApprovalClient(cloudEnabled = true))
        gateway.pairingScopesJson = "[\"read\",\"admin\"]"
        manager.pairFromQr(payload())
        assertSame(manager.session!!.admin, vm.pairingApprovalClient(cloudEnabled = true))
        // A build without cloud connectivity never offers pairing requests.
        assertNull(vm.pairingApprovalClient(cloudEnabled = false))
    }

    @Test fun `legacy direct preissued credential remains optional and foreground recovery does not re-enroll`() = runBlocking {
        val manager = graph.sessionManager()
        manager.pairFromQr("""{"v":1,"url":"${gateway.url.trimEnd('/')}","token":"legacy-device-token","accountId":"legacy-device","name":"Test gateway"}""")
        val before = graph.pairingService().current()!!
        assertNull(before.pairingGeneration)
        assertEquals(dev.omnesis.android.pairing.PairingTlsMode.LEGACY, before.tlsMode)
        assertNull(manager.session!!.routes.http)
        manager.beginForegroundVisit()
        assertEquals(before, graph.pairingService().current())
        assertFalse(gateway.requests.contains("POST /devices/pair"))
    }

    private fun payload() = """{"v":4,"gatewayUrl":"${gateway.url.trimEnd('/')}","pairingCode":"ABCD-EFGH","tls":{"mode":"pinned-leaf-strict","fingerprint":"${gateway.fingerprint}"}}"""

    private fun await(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000
        while (!condition() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        assertTrue("Real owned gateway exchange did not finish", condition())
    }
}

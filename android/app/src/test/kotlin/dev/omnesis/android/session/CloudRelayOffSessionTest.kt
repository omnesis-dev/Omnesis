// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import androidx.test.core.app.ApplicationProvider
import dagger.hilt.EntryPoints
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.pairing.PairingPayloadException
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.ui.home.HomeScaffoldHarnessEntryPoint
import dev.omnesis.android.ui.home.MockGateway
import dev.omnesis.android.ui.pairing.PairingViewModel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The real graph as a build without cloud connectivity: strict QR codes are unknown and no new transport runs. */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34])
class CloudRelayOffSessionTest {
    @get:Rule val hilt = HiltAndroidRule(this)
    private val application get() = ApplicationProvider.getApplicationContext<HiltTestApplication>()
    private val graph get() = EntryPoints.get(application, HomeScaffoldHarnessEntryPoint::class.java)
    private val gateway = MockGateway()

    @After fun close() {
        graph.sessionManager().beginRepair()
        gateway.close()
    }

    private fun payload(tls: String) = """{"v":4,"gatewayUrl":"${gateway.url.trimEnd('/')}","pairingCode":"ABCD-EFGH","tls":$tls}"""
    private val strictPayloads get() = listOf(
        payload("""{"mode":"pinned-key-strict","spkiFingerprint":"${gateway.spkiFingerprint}"}"""),
        payload("""{"mode":"pinned-leaf-strict","fingerprint":"${gateway.fingerprint}"}"""),
    )

    @Test fun `a strict trust mode QR is refused like any unknown mode and nothing is sent`() {
        val manager = graph.sessionManager()
        assertFalse(manager.cloudRelay)
        for (raw in strictPayloads) {
            val error = assertThrows(PairingPayloadException::class.java) { runBlocking { manager.pairFromQr(raw) } }
            assertEquals("invalid TLS trust mode", error.message)
            val vm = PairingViewModel(manager)
            vm.pairFromQr(raw)
            assertNull(vm.state.value.pending)
            assertEquals(PairingViewModel.Mode.Manual, vm.state.value.mode)
            assertNotNull(vm.state.value.error)
            assertFalse(vm.state.value.googleAvailable)
            assertNull(vm.state.value.account)
        }
        assertNull(graph.pairingService().current())
        assertNull(manager.session)
        assertTrue(gateway.requests.none { it == "POST /devices/pair" })
    }

    @Test fun `a pinned pairing gets no route, no hint discovery and no path maintenance`() = runBlocking {
        val manager = graph.sessionManager()
        manager.pairFromQr(payload("""{"mode":"pinned-leaf","fingerprint":"${gateway.fingerprint}"}"""))
        val active = manager.session!!
        assertEquals(PairingTlsMode.PINNED_LEAF, active.pairing.tlsMode)
        assertNull(active.routes.http); assertNull(active.routes.streaming); assertNull(active.routes.socket)
        active.socket.refreshDirectPath()
        active.socket.promoteDirectPath()
        active.socket.recoverAfterInterruption()
        assertTrue(gateway.requests.none { it.endsWith("/devices/direct-candidates") })
        assertSame(active, manager.session)
    }
}

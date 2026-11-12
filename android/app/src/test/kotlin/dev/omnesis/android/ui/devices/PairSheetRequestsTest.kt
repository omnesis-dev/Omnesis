// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import dagger.hilt.EntryPoints
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.access.PairingPendingRequests
import dev.omnesis.android.ui.home.HomeScaffoldHarnessEntryPoint
import dev.omnesis.android.ui.home.MockGateway
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * What the pair sheet asks the gateway, through the real session. A build without cloud
 * connectivity asks exactly what main asks: the network identities on open, then `pair-qr`
 * with the chosen identity swapped into the gateway's origin. A build with it asks the
 * gateway's address plan instead.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34])
class PairSheetRequestsTest {
    @get:Rule val hilt = HiltAndroidRule(this)
    private val graph get() = EntryPoints.get(ApplicationProvider.getApplicationContext<HiltTestApplication>(), HomeScaffoldHarnessEntryPoint::class.java)
    private val gateway = MockGateway()

    /** Every pair-qr body, in order. */
    private val qrBodies = CopyOnWriteArrayList<String>()

    @After fun close() {
        graph.sessionManager().beginRepair()
        gateway.close()
    }

    private fun pair() {
        gateway.extraRoutes = { request ->
            when (request.method to request.path.orEmpty().substringBefore('?')) {
                "GET" to "/admin/network-identities" -> json(
                    """{"items":[{"address":"192.0.2.42","label":"LAN (en0)","kind":"lan","offLan":false},""" +
                        """{"address":"gateway.tail1234.ts.net","label":"Tailscale","kind":"tailscale","offLan":true}]}""",
                )
                "POST" to "/admin/devices/pair" -> json("""{"pairingCode":"7K3M-9QX2","expiresAt":2000000000000}""")
                "POST" to "/admin/devices/pair-qr" -> {
                    qrBodies += request.body.readUtf8()
                    json("""{"qrPayload":"{\"v\":4}"}""")
                }
                "POST" to "/admin/devices/pair-addresses" -> json(
                    """{"platform":"ios","addresses":[{"gatewayUrl":"https://gateway.tail1234.ts.net:7600","host":"gateway.tail1234.ts.net",""" +
                        """"label":"Tailscale name","usable":true,"systemTrust":true}],"recommendedUrl":"https://gateway.tail1234.ts.net:7600"}""",
                )
                else -> null
            }
        }
        runBlocking {
            graph.sessionManager().pairFromQr(
                """{"v":4,"gatewayUrl":"${gateway.url.trimEnd('/')}","pairingCode":"ABCD-EFGH","tls":{"mode":"pinned-leaf","fingerprint":"${gateway.fingerprint}"}}""",
            )
        }
    }

    private fun json(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)

    private fun asked(request: String) = gateway.requests.contains(request)

    private fun swapped(host: String) = swapHost(gateway.url.toHttpUrl(), host)

    @Test fun `without cloud connectivity the sheet lists the network identities and swaps the chosen host into the QR`() {
        assertFalse(BuildConfig.CLOUD_RELAY_ENABLED)
        pair()
        // The build's own view model, as Hilt makes it.
        val vm = DevicesViewModel(graph.sessionManager(), PairingPendingRequests())
        vm.openPair()
        await { vm.pair.value?.identities?.size == 2 }
        assertTrue(asked("GET /admin/network-identities"))
        assertEquals(gateway.url.trimEnd('/'), vm.pair.value?.gatewayUrl)

        vm.pairDevice("ios")
        await { vm.pair.value?.qrPayload != null }
        assertEquals(
            """{"pairingCode":"7K3M-9QX2","gatewayUrl":"${swapped("192.0.2.42")}","trustMode":"auto"}""",
            qrBodies.single(),
        )

        vm.selectPairHost(1)
        await { qrBodies.size == 2 && vm.pair.value?.qrPayload != null }
        assertEquals(
            """{"pairingCode":"7K3M-9QX2","gatewayUrl":"${swapped("gateway.tail1234.ts.net")}","trustMode":"auto"}""",
            qrBodies.last(),
        )
        assertFalse(asked("POST /admin/devices/pair-addresses"))
        assertEquals(null, vm.pair.value?.addressPlan)
    }

    @Test fun `without cloud connectivity a repair sheet lists the network identities too`() {
        pair()
        val vm = DevicesViewModel(graph.sessionManager(), PairingPendingRequests())
        vm.openRepair(dev.omnesis.android.transport.dto.DeviceRecord(id = "device-b", name = "Old phone", kind = "android", pairedAt = 1L))
        await { vm.pair.value?.identities?.size == 2 }
        assertEquals("device-b", vm.pair.value?.repairTarget?.id)
        assertFalse(asked("POST /admin/devices/pair-addresses"))
    }

    @Test fun `with cloud connectivity the sheet asks the gateway's address plan and never the network identities`() {
        pair()
        val vm = DevicesViewModel(graph.sessionManager(), PairingPendingRequests(), cloudRelayEnabled = true)
        vm.openPair()
        vm.pairDevice("ios")
        await { vm.pair.value?.qrPayload != null }
        assertTrue(asked("POST /admin/devices/pair-addresses"))
        assertFalse(asked("GET /admin/network-identities"))
        assertEquals(
            """{"pairingCode":"7K3M-9QX2","gatewayUrl":"https://gateway.tail1234.ts.net:7600","trustMode":"auto"}""",
            qrBodies.single(),
        )
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000
        while (!condition() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        assertTrue("The pair sheet's gateway exchange did not finish", condition())
    }
}

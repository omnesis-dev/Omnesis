// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import dagger.hilt.EntryPoints
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.access.PairingPendingRequests
import dev.omnesis.android.ui.home.HomeScaffoldHarnessEntryPoint
import dev.omnesis.android.ui.home.MockGateway
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/** What the pair sheet asks the gateway, through the real session: the address plan, then `pair-qr` for its pick. */
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

    @Test fun `the sheet asks the gateway's address plan and encodes its recommendation`() {
        pair()
        val vm = DevicesViewModel(graph.sessionManager(), PairingPendingRequests())
        vm.openPair()
        vm.pairDevice("ios")
        await { vm.pair.value?.qrPayload != null }
        assertTrue(asked("POST /admin/devices/pair-addresses"))
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

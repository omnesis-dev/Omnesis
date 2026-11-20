// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import java.time.Instant
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Devices on the owner's Tailscale network that asked to join: counted by the main screen's
 * pairing banner and reviewed in the Devices approvals sheet that the banner and a
 * `tailscale-join` notification both open, only on a gateway that advertises `tailscaleEmbed`
 * on `GET /status`. A gateway that does not is never asked for join requests.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class HomeScaffoldDeviceApprovalsTest {
    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val hostActivity = HomeScaffoldHostActivityRule()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<HomeScaffoldHostActivity>()

    private lateinit var harness: HomeScaffoldHarness

    /** The join requests the gateway serves. */
    @Volatile private var waiting: List<String> = emptyList()

    @Before
    fun setUp() {
        harness = HomeScaffoldHarness(compose)
        harness.gateway.extraRoutes = { request ->
            val route = request.path.orEmpty().substringBefore('?')
            when {
                request.method == "GET" && route == JOIN_REQUESTS -> json("""{"requests":[${waiting.joinToString(",") { joinJson(it) }}]}""")
                request.method == "POST" && route.startsWith("$JOIN_REQUESTS/") && route.endsWith("/decision") -> {
                    waiting = waiting - route.removePrefix("$JOIN_REQUESTS/").substringBefore('/')
                    json("""{"status":"approved"}""")
                }
                else -> null
            }
        }
    }

    @After
    fun tearDown() {
        harness.close()
    }

    /** Pairs against a gateway whose status advertises Tailscale joins or not. */
    private fun pair(tailscaleEmbed: Boolean) {
        if (tailscaleEmbed) {
            harness.gateway.statusJson = """{"documents":{"total":0,"bySource":{}},"experimental":false,"tailscaleEmbed":true}"""
        }
        harness.pair()
    }

    @Test
    fun aGatewayThatDoesNotAdvertiseTailscaleJoinsIsNeverAskedForThem() {
        waiting = listOf("join-1")
        pair(tailscaleEmbed = false)
        harness.composeShell()
        harness.waitUntil { "/status" in harness.gateway.requestPaths }
        // Back to the front, and Devices opened: still nothing asks.
        harness.background()
        harness.foreground()
        harness.launchBus.postDevices(null)
        harness.waitUntil { harness.currentRoute == DEVICES_ROUTE && "/admin/devices" in harness.gateway.requestPaths }
        compose.waitForIdle()
        assertEquals(0, joinReads())
        compose.onAllNodesWithTag(BANNER).assertCountEquals(0)
    }

    @Test
    fun aWaitingJoinEarnsTheBannerWhichOpensTheApprovalsSheetOverDevices() {
        waiting = listOf("join-1")
        pair(tailscaleEmbed = true)
        harness.composeShell()
        harness.waitUntil { compose.onAllNodesWithTag(BANNER).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("A new device is waiting for your OK.").performClick()
        harness.waitUntil { compose.onAllNodesWithTag("tailscaleJoin.request").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(DEVICES_ROUTE, harness.currentRoute)
        compose.onNodeWithText("Waiting for your OK").assertExists()
        compose.onNodeWithText("Maya's studio Mac wants to connect").assertExists()
        compose.onNodeWithText("Collector · via Tailscale · maya@example.com").assertExists()

        compose.onNodeWithTag("tailscaleJoin.approve").performScrollTo()
        // A bottom sheet's popup takes no synthetic pointer input under Robolectric; its semantics action is the tap.
        compose.onNodeWithTag("tailscaleJoin.approve").performSemanticsAction(SemanticsActions.OnClick) { it() }
        harness.waitUntil { "POST $JOIN_REQUESTS/join-1/decision" in harness.gateway.requests }
        harness.waitUntil { compose.onAllNodesWithTag("tailscaleJoin.request").fetchSemanticsNodes().isEmpty() }
    }

    /** The notification is the gateway saying it has the feature, before its status says so. */
    @Test
    fun aTailscaleJoinNotificationOpensTheSameSheetEvenBeforeTheStatusSaysSo() {
        waiting = listOf("join-1")
        pair(tailscaleEmbed = false)
        harness.composeShell()
        harness.waitUntil { "/status" in harness.gateway.requestPaths }
        assertEquals(0, joinReads())
        harness.launchBus.postTailscaleJoinRequests()
        harness.waitUntil { compose.onAllNodesWithTag("tailscaleJoin.request").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(DEVICES_ROUTE, harness.currentRoute)
        compose.onNodeWithText("Waiting for your OK").assertExists()
        compose.onAllNodesWithText("Collector · via Tailscale · maya@example.com").assertCountEquals(1)
    }

    private fun joinReads(): Int = harness.gateway.requests.count { it == "GET $JOIN_REQUESTS" }

    private fun json(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)

    private fun joinJson(id: String): String {
        val now = Instant.now()
        return """{"id":"$id","name":"Maya's studio Mac","kind":"collector","machine":"studio-mac","os":"macOS",""" +
            """"login":"maya@example.com","requestedAt":"${now.minusSeconds(60)}","expiresAt":"${now.plusSeconds(600)}"}"""
    }

    private companion object {
        const val JOIN_REQUESTS = "/admin/tailscale/join-requests"
        const val BANNER = "home.pairingRequestBanner"
    }
}

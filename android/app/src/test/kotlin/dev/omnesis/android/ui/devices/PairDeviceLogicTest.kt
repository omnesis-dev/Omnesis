// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.dto.PairingAddressOption
import dev.omnesis.android.transport.dto.PairingAddressPlan
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic tests for the pair-a-device flow: the gateway's address plan for a
 * phone's QR and an agent's setup commands, the offered device kinds, and the
 * agent connect commands.
 */
class PairDeviceLogicTest {
    private val tailscale = PairingAddressOption(
        "https://gateway.tail1234.ts.net:7600", "gateway.tail1234.ts.net", "Tailscale name", usable = true,
        summary = "Works at home and away, as long as Tailscale is connected on the phone.", reach = "tailnet", systemTrust = true,
    )
    private val lan = PairingAddressOption(
        "https://192.168.1.20:7600", "192.168.1.20", "Local network", usable = true,
        summary = "Works only while the phone is on the same network as the gateway, such as your home Wi-Fi.", reach = "local-network",
    )
    private val relay = PairingAddressOption(
        "https://g-7f3a91.relay.example.com", "g-7f3a91.relay.example.com", "Omnesis address", usable = true,
        summary = "Works from anywhere. Needs remote access to stay on.", reach = "anywhere", kind = "relay",
    )
    private val refused = PairingAddressOption("https://100.64.0.7:7600", "100.64.0.7", "Tailscale IP", usable = false, reason = "Not for this phone.")
    private val plan = PairingAddressPlan("android", listOf(relay, tailscale, lan, refused), recommendedUrl = relay.gatewayUrl)

    // A build without cloud connectivity keeps main's sheet: the chosen network identity's
    // host is swapped into the gateway's origin.
    @Test
    fun swap_host_preserves_scheme_and_port() {
        // The portal swaps only the host, keeping the gateway's real scheme/port.
        assertEquals(
            "https://198.51.100.7:7600",
            swapHost("https://mac.local:7600/".toHttpUrl(), "198.51.100.7"),
        )
        // Non-default port is preserved (guards against a hardcoded :7600).
        assertEquals(
            "https://192.0.2.42:17600",
            swapHost("https://mac.local:17600/".toHttpUrl(), "192.0.2.42"),
        )
        // No origin → https fallback, no port assumed.
        assertEquals("https://192.0.2.42", swapHost(null, "192.0.2.42"))
    }

    @Test
    fun agent_gateway_url_uses_selected_advertised_identity() {
        assertEquals(
            "https://gateway.tail.example:17600",
            agentGatewayUrl(
                "https://gateway.example:17600",
                listOf("192.0.2.42", "gateway.tail.example"),
                1,
            ),
        )
        assertEquals(
            "https://gateway.example:17600",
            agentGatewayUrl("https://gateway.example:17600", emptyList(), 0),
        )
    }

    @Test
    fun `the plan opens on the gateway's recommendation and titles each option from the gateway's words`() {
        assertEquals(relay, plan.selected(plan.recommendedUrl))
        assertEquals("Omnesis address · g-7f3a91.relay.example.com (recommended)", pairAddressTitle(relay, plan))
        assertEquals("Tailscale name · gateway.tail1234.ts.net", pairAddressTitle(tailscale, plan))
        assertEquals("Local network · 192.168.1.20", pairAddressTitle(lan, plan))
        assertEquals(listOf(relay, tailscale, lan), plan.usable)
        assertEquals(listOf(refused), plan.refused)
        assertEquals("Android phone", pairingNoun("android"))
        assertEquals("iPhone", pairingNoun("ios"))
    }

    @Test
    fun `typing the address by hand is offered only for an address served with system trust`() {
        assertTrue(manualEntryOffered(tailscale))
        // Pinned addresses need what the QR carries: the gateway's own certificate, or the relay's key.
        assertFalse(manualEntryOffered(lan))
        assertFalse(manualEntryOffered(relay))
        assertFalse(manualEntryOffered(refused.copy(systemTrust = true)))
        assertFalse(manualEntryOffered(null))
    }

    /**
     * The app itself reaches this gateway on another host and port (as it does through a
     * relay address on 443). Neither leaks into the QR: each option's URL is sent as given.
     */
    @Test
    fun `the chosen address goes to pair-qr exactly as the gateway gave it`(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val transport = OkHttpClient()
            try {
                val admin = AdminClient(GatewayHttp(transport, server.url("/").toString(), "synthetic-token"))
                for (option in listOf(relay, lan, tailscale)) {
                    server.enqueue(MockResponse().setBody("""{"qrPayload":"{}"}"""))
                    assertEquals("{}", admin.pairQrFor("7K3M-9QX2", option))
                    val request = server.takeRequest()
                    assertEquals("/admin/devices/pair-qr", request.path)
                    assertEquals(
                        """{"pairingCode":"7K3M-9QX2","gatewayUrl":"${option.gatewayUrl}","trustMode":"auto"}""",
                        request.body.readUtf8(),
                    )
                }
            } finally { transport.dispatcher.cancelAll(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
        }
    }

    /**
     * An agent's setup commands name the address the gateway gave, unchanged. The app's own
     * route to the gateway (which may be the relay's address on 443) never appears in them.
     */
    @Test
    fun `agent setup commands use the plan's address exactly as the gateway gave it`() {
        val agentPlan = PairingAddressPlan(null, listOf(tailscale, lan, refused), recommendedUrl = tailscale.gatewayUrl)
        val chosen = agentPlan.selected(agentPlan.recommendedUrl)!!
        assertEquals(
            listOf(
                "omnesis connect openclaw --gateway-url https://gateway.tail1234.ts.net:7600 --code FICTION-2486",
                "omnesis connect hermes --gateway-url https://gateway.tail1234.ts.net:7600 --code FICTION-2486",
            ),
            agentConnectCommands(chosen.gatewayUrl, "FICTION-2486"),
        )
        assertEquals(
            "omnesis connect openclaw --gateway-url https://192.168.1.20:7600 --code FICTION-2486",
            agentConnectCommands(agentPlan.selected(lan.gatewayUrl)!!.gatewayUrl, "FICTION-2486").first(),
        )
        // A refused address is never selected, so no command is built for it.
        assertEquals(null, agentPlan.selected(refused.gatewayUrl))
    }

    @Test
    fun `a phone or an agent is told which address to use, and each is named`() {
        assertTrue(pairingChoosesAddress("ios"))
        assertTrue(pairingChoosesAddress("android"))
        assertTrue(pairingChoosesAddress("agent"))
        assertFalse(pairingChoosesAddress("cli"))
        assertFalse(pairingChoosesAddress(null))
        assertEquals("an iPhone", pairingWithArticle(pairingNoun("ios")))
        assertEquals("an Android phone", pairingWithArticle(pairingNoun("android")))
        assertEquals("a device", pairingWithArticle(pairingNoun("agent")))
        assertEquals("Use a different address", pairAlternativesTitle(plan))
        assertEquals("Why other addresses aren't offered", pairAlternativesTitle(PairingAddressPlan("ios", listOf(lan, refused), lan.gatewayUrl)))
        assertEquals(null, pairAlternativesTitle(PairingAddressPlan("ios", listOf(lan), lan.gatewayUrl)))
        // Only a usable address is ever marked as the recommendation.
        assertEquals("Tailscale IP · 100.64.0.7", pairAddressTitle(refused, plan.copy(recommendedUrl = refused.gatewayUrl)))
    }

    @Test
    fun `agent pair kind is offered without experimental mode`() {
        assertEquals(
            listOf("collector", "cli", "portal", "ios", "android", "agent", "browser"),
            PAIR_KINDS,
        )
    }

    @Test
    fun `agent pair result uses only supported harness connect commands`() {
        assertEquals(
            listOf(
                "omnesis connect openclaw --gateway-url https://gateway.example:7600 --code FICTION-2486",
                "omnesis connect hermes --gateway-url https://gateway.example:7600 --code FICTION-2486",
            ),
            agentConnectCommands("https://gateway.example:7600/", "FICTION-2486"),
        )
        assertFalse(agentConnectCommands(null, "FICTION-2486").joinToString("\n").contains("devices pair"))
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Pure-logic tests for the pair-a-device flow: the pairing-QR gateway-URL host
 * swap, the agent setup URL, the offered device kinds, and the agent connect
 * commands. Parity twin of the iOS `swapHost` coverage.
 */
class PairDeviceLogicTest {

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

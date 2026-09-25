// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import dev.omnesis.android.transport.GatewayException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.cert.CertificateException

/**
 * Locks in the transport-throwable → [GatewayErrorKind] mapping and the copy each kind
 * renders. Mirrors the iOS `GatewayErrorViewTests`. The load-bearing case is the first-run
 * "no model assigned to the agent capability" 503, which must land on the friendly
 * [GatewayErrorKind.AgentNotConfigured] (sparkles/accent) rather than the warning-triangle
 * [GatewayErrorKind.Server] bucket.
 */
class GatewayErrorsTest {

    @Test
    fun `no model assigned 503 classifies as agent not configured`() {
        val bodies = listOf(
            "Agent disabled. Set inference.assignments.agent in omnesis.json (e.g. \"anthropic/claude-sonnet-4-6\") to enable it.",
            "Agent disabled. Set inference.assignments.agent in omnesis.json to enable it.",
            "Agent harness disabled. Set agent.backend to \"anthropic\" in omnesis.json.",
            "Anthropic API key not configured. Set it from the portal's Settings → Models tab.",
            "Replay backend selected but no fixture configured.",
        )
        for (body in bodies) {
            assertEquals(
                "Expected AgentNotConfigured for body: $body",
                GatewayErrorKind.AgentNotConfigured,
                gatewayErrorKind(GatewayException.ServerError(503, body)),
            )
        }
    }

    @Test
    fun `non-agent 503 stays a server error`() {
        val kind = gatewayErrorKind(GatewayException.ServerError(503, "Service temporarily unavailable."))
        assertEquals(GatewayErrorKind.Server(503, "Service temporarily unavailable."), kind)
    }

    @Test
    fun `500 with agent body is not misclassified`() {
        // Only 503s are a config state — a 500 with the same text is a genuine fault.
        val kind = gatewayErrorKind(GatewayException.ServerError(500, "Agent disabled. Set inference.assignments.agent in omnesis.json."))
        assertEquals(GatewayErrorKind.Server(500, "Agent disabled. Set inference.assignments.agent in omnesis.json."), kind)
    }

    @Test
    fun `network folds to unreachable`() {
        assertEquals(GatewayErrorKind.Unreachable, gatewayErrorKind(GatewayException.Network(Exception("offline"))))
    }

    @Test
    fun `certificate failure gets certificate guidance while Ask transport failure gets tailnet guidance`() {
        val certificate = GatewayException.Network(CertificateException("mismatch"))
        assertEquals(GatewayErrorKind.Certificate, gatewayErrorKind(certificate))
        assertTrue(classifyGatewayError(certificate).contains("certificate"))
        assertTrue(classifyGatewayError(GatewayException.Network(Exception("offline"))).contains("Tailscale hostname"))
    }

    @Test
    fun `agent-not-configured title and copy point at Models, not settings or portal`() {
        val kind = GatewayErrorKind.AgentNotConfigured
        assertEquals("Set up your agent", kind.title())
        val detail = kind.detail("start the agent")
        assertTrue(detail.contains("Models"))
        assertFalse(detail.lowercase().contains("portal"))
        assertFalse(detail.lowercase().contains("settings"))
    }

    @Test
    fun `agent-not-configured wears a friendly icon, not the server warning`() {
        assertNotEquals(
            GatewayErrorKind.AgentNotConfigured.icon,
            GatewayErrorKind.Server(503, "").icon,
        )
    }
}

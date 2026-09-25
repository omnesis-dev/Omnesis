// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import java.net.ConnectException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayConnectionAdviceTest {
    @Test fun `connection refused offers away from home setup without asserting the cause`() {
        val error = GatewayException.Network(ConnectException("refused"))
        assertEquals(GatewayConnectionProblem.UNREACHABLE, gatewayConnectionProblem(error))
        val advice = gatewayConnectionAdvice(error)!!
        assertTrue(advice.contains("If it works only at home"))
        assertTrue(advice.contains("Tailscale hostname"))
    }

    @Test fun `certificate failure stays distinct from unreachable gateway`() {
        val handshake = SSLHandshakeException("handshake failed")
        handshake.initCause(CertificateException("fingerprint mismatch"))
        val error = GatewayException.Network(handshake)
        assertEquals(GatewayConnectionProblem.CERTIFICATE, gatewayConnectionProblem(error))
        assertTrue(gatewayConnectionAdvice(error)!!.contains("certificate"))
    }

    @Test fun `authentication refusal is not treated as a network problem`() {
        assertNull(gatewayConnectionProblem(GatewayException.Unauthorized()))
        assertNull(gatewayConnectionAdvice(GatewayException.Forbidden()))
    }
}

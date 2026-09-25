// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.pairing.PairingPayloadException
import dev.omnesis.android.transport.GatewayException
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** How each way a pairing attempt fails reads on the pairing screen. */
class PairingErrorsTest {
    private val host = "gateway.example.org:7600"

    @Test
    fun `a spent or expired pairing code asks for a new one`() {
        val error = GatewayException.ServerError(400, "invalid or expired pairing code", "BAD_REQUEST")
        assertEquals(PAIRING_CODE_USED_MESSAGE, pairingErrorMessage(error, host))
    }

    @Test
    fun `a certificate the phone cannot verify names the address mismatch`() {
        val pinMismatch = SSLHandshakeException("handshake failed").apply {
            initCause(CertificateException("certificate fingerprint mismatch"))
        }
        listOf(
            GatewayException.Network(SSLPeerUnverifiedException("Hostname gateway.example.org not verified")),
            GatewayException.Network(pinMismatch),
        ).forEach { error ->
            assertEquals(PAIRING_CERTIFICATE_MESSAGE, pairingErrorMessage(error, host))
        }
    }

    @Test
    fun `an unreachable gateway names its host`() {
        val expected = "Couldn't reach your gateway at $host. Check its power and this phone's connection. If it works only at home, connect both devices to Tailscale and pair using the gateway's Tailscale hostname."
        listOf(
            GatewayException.Network(UnknownHostException("gateway.example.org")),
            GatewayException.Network(ConnectException("Failed to connect to gateway.example.org/192.0.2.10:7600")),
            GatewayException.Network(SocketTimeoutException("timeout")),
        ).forEach { error ->
            assertEquals(expected, pairingErrorMessage(error, host))
        }
    }

    @Test
    fun `an unreachable gateway without a known host still reads as a sentence`() {
        assertEquals(
            "Couldn't reach your gateway. Check its power and this phone's connection. If it works only at home, connect both devices to Tailscale and pair using the gateway's Tailscale hostname.",
            pairingErrorMessage(GatewayException.Network(UnknownHostException("gateway.example.org")), gatewayHost = null),
        )
    }

    @Test
    fun `any other gateway error carries the gateway's message`() {
        assertEquals(
            "Pairing didn't finish: the gateway is shutting down.",
            pairingErrorMessage(GatewayException.ServerError(500, "the gateway is shutting down"), host),
        )
    }

    @Test
    fun `a pairing payload the phone rejects carries its reason`() {
        assertEquals(
            "Pairing didn't finish: pairing URL must use https.",
            pairingErrorMessage(PairingPayloadException("pairing URL must use https"), gatewayHost = null),
        )
    }

    @Test
    fun `an error with nothing readable never shows a raw description`() {
        listOf(
            IllegalStateException("kotlin.IllegalStateException: pairing persisted but could not be read back"),
            GatewayException.ServerError(502, "<html><body>Bad Gateway</body></html>"),
            GatewayException.Decoding("failed to decode DevicePairResponse"),
            GatewayException.Network(IOException("unexpected end of stream")),
        ).forEach { error ->
            val message = pairingErrorMessage(error, host)
            assertEquals(PAIRING_FAILED_MESSAGE, message)
            assertFalse(message.contains("Exception"))
        }
    }

    @Test
    fun `a TLS failure that is not about the certificate reads as unreachable`() {
        val reset = GatewayException.Network(SSLException("Connection reset by peer"))
        assertEquals(
            "Couldn't reach your gateway at gateway.example.org. Check its power and this phone's connection. If it works only at home, connect both devices to Tailscale and pair using the gateway's Tailscale hostname.",
            pairingErrorMessage(reset, "gateway.example.org"),
        )
    }
}

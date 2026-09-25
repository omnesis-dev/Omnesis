// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.pairing.PairingPayloadException
import dev.omnesis.android.transport.GatewayException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

internal const val PAIRING_CODE_USED_MESSAGE =
    "This pairing code has already been used or has expired. Create a new one on your gateway and scan it again."

internal const val PAIRING_CERTIFICATE_MESSAGE =
    "Couldn't verify your gateway's certificate. Check the address in the pairing code. For Tailscale, use the gateway's hostname, not its IP address."

internal const val PAIRING_FAILED_MESSAGE = "Pairing didn't finish. Try again."

/**
 * What the pairing screen says when a pairing attempt fails, in plain words:
 * a spent or expired code, a certificate that doesn't check out, a gateway
 * this phone can't reach at [gatewayHost], or otherwise the gateway's own
 * message when it gave one. Transport and exception names never reach the
 * screen.
 */
internal fun pairingErrorMessage(error: Throwable, gatewayHost: String?): String {
    val chain = generateSequence(error) { current -> current.cause?.takeIf { it !== current } }.toList()
    return when {
        error is GatewayException.ServerError && isSpentPairingCode(error) -> PAIRING_CODE_USED_MESSAGE
        chain.any { it is SSLHandshakeException || it is SSLPeerUnverifiedException || it is CertificateException } ->
            PAIRING_CERTIFICATE_MESSAGE
        chain.any { it.isUnreachable() } -> unreachableMessage(gatewayHost)
        else -> readableDetail(error)?.let { "Pairing didn't finish: ${it.trimEnd('.')}." } ?: PAIRING_FAILED_MESSAGE
    }
}

private fun isSpentPairingCode(error: GatewayException.ServerError): Boolean {
    val body = error.body?.lowercase() ?: return false
    return "pairing code" in body && ("invalid" in body || "expired" in body || "used" in body)
}

private fun Throwable.isUnreachable(): Boolean =
    this is UnknownHostException ||
        this is ConnectException ||
        // A connection reset or other TLS failure that is not about the certificate.
        this is SSLException ||
        this is NoRouteToHostException ||
        this is InterruptedIOException

private fun unreachableMessage(host: String?): String {
    val where = host?.takeIf { it.isNotBlank() }?.let { " at $it" }.orEmpty()
    return "Couldn't reach your gateway$where. Check its power and this phone's connection. If it works only at home, connect both devices to Tailscale and pair using the gateway's Tailscale hostname."
}

/** The gateway's message, or a pairing payload's validation message; never a raw transport description. */
private fun readableDetail(error: Throwable): String? {
    val detail = when (error) {
        is GatewayException.ServerError -> error.body
        is PairingPayloadException -> error.message
        else -> null
    }?.trim()
    return detail?.takeIf { it.isNotEmpty() && it.length <= MAX_DETAIL_LENGTH && !it.startsWith("<") }
}

private const val MAX_DETAIL_LENGTH = 200

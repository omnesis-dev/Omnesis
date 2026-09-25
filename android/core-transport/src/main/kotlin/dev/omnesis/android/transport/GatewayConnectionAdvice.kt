// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import java.security.cert.CertificateException
import javax.net.ssl.SSLPeerUnverifiedException

/** Actionable diagnosis only when the transport has evidence for it. */
enum class GatewayConnectionProblem { UNREACHABLE, CERTIFICATE }

fun gatewayConnectionProblem(error: Throwable): GatewayConnectionProblem? {
    if (error !is GatewayException.Network) return null
    val causes = generateSequence<Throwable>(error) { current -> current.cause?.takeIf { it !== current } }
        .take(12)
    return if (causes.any { it is CertificateException || it is SSLPeerUnverifiedException }) {
        GatewayConnectionProblem.CERTIFICATE
    } else {
        GatewayConnectionProblem.UNREACHABLE
    }
}

fun gatewayConnectionAdvice(error: Throwable): String? = gatewayConnectionProblem(error)?.let(::gatewayConnectionAdvice)

fun gatewayConnectionAdvice(problem: GatewayConnectionProblem): String = when (problem) {
    GatewayConnectionProblem.CERTIFICATE ->
        "The gateway's certificate could not be verified. Check the paired address and re-pair if it changed. Use the Tailscale hostname, not its IP address."
    GatewayConnectionProblem.UNREACHABLE ->
        "This phone can't reach the gateway. Check its power and your connection. If it works only at home, connect both devices to Tailscale and re-pair using the gateway's Tailscale hostname."
}

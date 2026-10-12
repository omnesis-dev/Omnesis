// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import java.security.cert.CertificateParsingException
import java.security.cert.X509Certificate

/**
 * When a pinned client may trust the platform root store instead of its pin.
 *
 * Only a gateway reached by a DNS name can hold a publicly trusted certificate for
 * that name, so system trust can stand in for the pin only there: never for an IP
 * literal and never for `localhost`. The same rule decides pairing on the gateway,
 * `omnesis connect` for agents, and the iOS and Android apps.
 */
object GatewayTrustPolicy {

    private const val SAN_DNS_NAME = 2
    private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

    /** True when [host] is a DNS name that a public certificate could be issued for. */
    fun systemTrustQualifies(host: String?): Boolean {
        val name = host?.trim()?.removePrefix("[")?.removeSuffix("]")?.trimEnd('.')?.lowercase()
        if (name.isNullOrEmpty()) return false
        if (IPV4.matches(name) || ':' in name) return false
        if (name == "localhost" || name.endsWith(".localhost")) return false
        return true
    }

    /**
     * True when one of [certificate]'s DNS subject alternative names covers [host]:
     * an exact match, or a wildcard standing for exactly one left-most label
     * (`*.example.com` covers `a.example.com`, not `example.com` or `a.b.example.com`).
     * The subject common name is not consulted.
     */
    fun matchesHostname(certificate: X509Certificate, host: String): Boolean {
        val target = host.trimEnd('.').lowercase()
        if (target.isEmpty()) return false
        val names = try {
            certificate.subjectAlternativeNames.orEmpty()
        } catch (_: CertificateParsingException) {
            return false
        }
        return names.any { entry ->
            val type = entry.getOrNull(0) as? Int
            val value = entry.getOrNull(1) as? String
            type == SAN_DNS_NAME && value != null && dnsNameCovers(value.trimEnd('.').lowercase(), target)
        }
    }

    private fun dnsNameCovers(pattern: String, host: String): Boolean {
        if (!pattern.startsWith("*.")) return pattern == host
        val suffix = pattern.substring(1)
        if (!host.endsWith(suffix)) return false
        val label = host.substring(0, host.length - suffix.length)
        return label.isNotEmpty() && '.' !in label
    }
}

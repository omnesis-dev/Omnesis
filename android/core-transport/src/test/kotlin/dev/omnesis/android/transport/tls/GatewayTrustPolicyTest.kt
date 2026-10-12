// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayTrustPolicyTest {

    @Test
    fun dnsNamesQualifyForSystemTrust() {
        assertTrue(GatewayTrustPolicy.systemTrustQualifies("gateway.example.com"))
        assertTrue(GatewayTrustPolicy.systemTrustQualifies("Gateway.Tailnet-Example.ts.net"))
        assertTrue(GatewayTrustPolicy.systemTrustQualifies("intranet"))
    }

    @Test
    fun ipLiteralsLocalhostAndEmptyHostsDoNotQualify() {
        assertFalse(GatewayTrustPolicy.systemTrustQualifies(null))
        assertFalse(GatewayTrustPolicy.systemTrustQualifies(""))
        assertFalse(GatewayTrustPolicy.systemTrustQualifies("192.0.2.10"))
        assertFalse(GatewayTrustPolicy.systemTrustQualifies("198.51.100.2"))
        assertFalse(GatewayTrustPolicy.systemTrustQualifies("[2001:db8::1]"))
        assertFalse(GatewayTrustPolicy.systemTrustQualifies("2001:db8::1"))
        assertFalse(GatewayTrustPolicy.systemTrustQualifies("localhost"))
        assertFalse(GatewayTrustPolicy.systemTrustQualifies("LOCALHOST"))
        assertFalse(GatewayTrustPolicy.systemTrustQualifies("gateway.localhost"))
    }

    @Test
    fun exactDnsNameMatchesCaseInsensitively() {
        val cert = certificate("gateway.example.com")
        assertTrue(GatewayTrustPolicy.matchesHostname(cert, "gateway.example.com"))
        assertTrue(GatewayTrustPolicy.matchesHostname(cert, "GATEWAY.example.COM"))
        assertFalse(GatewayTrustPolicy.matchesHostname(cert, "other.example.com"))
        assertFalse(GatewayTrustPolicy.matchesHostname(cert, "example.com"))
    }

    @Test
    fun wildcardCoversExactlyOneLeftMostLabel() {
        val cert = certificate("*.example.com")
        assertTrue(GatewayTrustPolicy.matchesHostname(cert, "a.example.com"))
        assertTrue(GatewayTrustPolicy.matchesHostname(cert, "A.EXAMPLE.com"))
        assertFalse(GatewayTrustPolicy.matchesHostname(cert, "example.com"))
        assertFalse(GatewayTrustPolicy.matchesHostname(cert, "a.b.example.com"))
        assertFalse(GatewayTrustPolicy.matchesHostname(cert, "a.example.org"))
    }

    @Test
    fun onlyDnsSubjectAlternativeNamesAreConsulted() {
        val ipOnly = HeldCertificate.Builder()
            .commonName("gateway.example.com")
            .addSubjectAlternativeName("192.0.2.10")
            .build()
            .certificate
        assertFalse(GatewayTrustPolicy.matchesHostname(ipOnly, "gateway.example.com"))
        assertFalse(GatewayTrustPolicy.matchesHostname(ipOnly, "192.0.2.10"))

        val noSans = HeldCertificate.Builder().commonName("gateway.example.com").build().certificate
        assertFalse(GatewayTrustPolicy.matchesHostname(noSans, "gateway.example.com"))
    }

    private fun certificate(vararg names: String) =
        HeldCertificate.Builder()
            .apply { names.forEach(::addSubjectAlternativeName) }
            .build()
            .certificate
}

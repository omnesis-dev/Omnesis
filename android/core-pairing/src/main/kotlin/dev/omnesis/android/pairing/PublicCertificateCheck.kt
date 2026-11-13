// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.tls.GatewayTrustPolicy
import dev.omnesis.android.transport.tls.LeafCertPinner
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager

/**
 * First contact with a gateway: is the certificate the relay proposed publicly trusted for this
 * hostname and logged? Pairing never fails on the answer. A "no" asks the gateway to hold the
 * request for a person, because a fake gateway could not get a logged certificate unnoticed.
 */
class PublicCertificateCheck(
    private val trust: X509TrustManager = LeafCertPinner.platformDefaultTrustManager(),
) {
    fun accepts(chain: List<X509Certificate>, hostname: String): Boolean {
        val leaf = chain.firstOrNull() ?: return false
        return runCatching {
            trust.checkServerTrusted(chain.toTypedArray(), if (leaf.publicKey.algorithm == "RSA") "ECDHE_RSA" else "ECDHE_ECDSA")
            GatewayTrustPolicy.matchesHostname(leaf, hostname) && leaf.getExtensionValue(EMBEDDED_SCT_OID)?.isNotEmpty() == true
        }.getOrDefault(false)
    }

    private companion object {
        const val EMBEDDED_SCT_OID = "1.3.6.1.4.1.11129.2.4.2"
    }
}

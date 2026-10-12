// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Trust for a gateway paired with a pinned leaf certificate (the SHA-256
 * fingerprint carried in a V3 or V4 pinned-leaf pairing QR). Port of the iOS
 * `PinnedSession`.
 *
 * A server chain is accepted when either:
 * - its leaf matches the pinned fingerprint. System CA validation and hostname
 *   matching are bypassed, because the gateway's own certificate names a small set
 *   that won't cover every reachable host or IP (`10.0.2.2`, a VPN address); or
 * - [host] is a DNS name ([GatewayTrustPolicy.systemTrustQualifies]), [systemTrust]
 *   accepts the chain, and the leaf names [host]. This is what lets a phone survive
 *   the renewal of a publicly trusted gateway certificate.
 *
 * The first time a chain is system trusted for [host], [onSystemTrustVerified] runs
 * (once per pinner) so the caller can switch the pairing to system trust. It runs on
 * the TLS handshake thread and must only hand the work off.
 *
 * The trust manager is the single decision point, so [hostnameVerifier] accepts
 * every name.
 */
class LeafCertPinner(
    fingerprintHex: String,
    private val host: String? = null,
    private val onSystemTrustVerified: (() -> Unit)? = null,
    private val systemTrust: X509TrustManager = platformDefaultTrustManager(),
) {

    private val expected = fingerprintHex.lowercase()
    private val notified = AtomicBoolean(false)

    val trustManager: X509TrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull()
                ?: throw CertificateException("no server certificate presented")
            val pinMatches = sha256Hex(leaf.encoded) == expected
            // A pinned chain needs the system check only to learn whether to upgrade.
            if (pinMatches && (onSystemTrustVerified == null || notified.get())) return
            if (isSystemTrusted(chain, authType, leaf)) {
                if (notified.compareAndSet(false, true)) onSystemTrustVerified?.invoke()
                return
            }
            if (pinMatches) return
            throw CertificateException(
                if (GatewayTrustPolicy.systemTrustQualifies(host)) {
                    "certificate fingerprint mismatch and no public trust for $host"
                } else {
                    "certificate fingerprint mismatch; ${host ?: "this gateway"} cannot fall back to public trust"
                },
            )
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private fun isSystemTrusted(
        chain: Array<out X509Certificate>,
        authType: String?,
        leaf: X509Certificate,
    ): Boolean {
        val name = host?.takeIf(GatewayTrustPolicy::systemTrustQualifies) ?: return false
        val verified = runCatching {
            @Suppress("UNCHECKED_CAST")
            systemTrust.checkServerTrusted(chain as Array<X509Certificate>, authType ?: "UNKNOWN")
        }.isSuccess
        return verified && GatewayTrustPolicy.matchesHostname(leaf, name)
    }

    val socketFactory: SSLSocketFactory by lazy {
        SSLContext.getInstance("TLS")
            .apply { init(null, arrayOf<javax.net.ssl.TrustManager>(trustManager), SecureRandom()) }
            .socketFactory
    }

    /** Accepts any hostname; [trustManager] has already decided whether the chain is trusted. */
    val hostnameVerifier: HostnameVerifier = HostnameVerifier { _: String, _: SSLSession -> true }

    companion object {
        /** SHA-256 of [bytes] as lowercase hex with no separators (matches the QR fingerprint). */
        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes)
                .joinToString("") { "%02x".format(it) }

        private val HEX_64 = Regex("^[0-9a-fA-F]{64}$")

        fun isValidFingerprint(fp: String?): Boolean = fp != null && HEX_64.matches(fp)

        private val platformDefault: X509TrustManager by lazy {
            TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                .apply { init(null as KeyStore?) }
                .trustManagers
                .filterIsInstance<X509TrustManager>()
                .first()
        }

        /** The platform root-store trust manager, loaded once per process. */
        fun platformDefaultTrustManager(): X509TrustManager = platformDefault
    }
}

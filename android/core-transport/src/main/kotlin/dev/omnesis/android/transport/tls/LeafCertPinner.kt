// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/**
 * Pins the gateway's self-signed leaf certificate by its SHA-256 fingerprint (the
 * value carried in a V3 pairing QR). Faithful port of the iOS `PinnedSession`: hash
 * the leaf cert DER, compare lowercase hex, and — because the exact leaf is
 * cryptographically pinned — bypass system CA validation AND hostname matching (the
 * gateway's auto-cert SANs are a small LAN set that won't match every reachable
 * host/IP such as `10.0.2.2` or a VPN address).
 */
class LeafCertPinner(fingerprintHex: String) {

    private val expected = fingerprintHex.lowercase()

    val trustManager: X509TrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull()
                ?: throw CertificateException("no server certificate presented")
            if (sha256Hex(leaf.encoded) != expected) {
                throw CertificateException("certificate fingerprint mismatch")
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    val socketFactory: SSLSocketFactory by lazy {
        SSLContext.getInstance("TLS")
            .apply { init(null, arrayOf<javax.net.ssl.TrustManager>(trustManager), SecureRandom()) }
            .socketFactory
    }

    /** Accepts any hostname; the leaf is already pinned by fingerprint. */
    val hostnameVerifier: HostnameVerifier = HostnameVerifier { _: String, _: SSLSession -> true }

    companion object {
        /** SHA-256 of [bytes] as lowercase hex with no separators (matches the QR fingerprint). */
        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes)
                .joinToString("") { "%02x".format(it) }

        private val HEX_64 = Regex("^[0-9a-fA-F]{64}$")

        fun isValidFingerprint(fp: String?): Boolean = fp != null && HEX_64.matches(fp)
    }
}

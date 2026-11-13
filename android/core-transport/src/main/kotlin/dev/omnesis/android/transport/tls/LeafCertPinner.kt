// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.CertificateExpiredException
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager
import java.util.Date
import okhttp3.OkHttpClient

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
 * A key pin ([spkiFingerprint]) also requires the certificate's dates to hold, with one
 * exception: a certificate that has expired is accepted when its key matches the pin and
 * the connection goes straight to the gateway on the home network ([directPath] says so
 * for the socket's remote address). A gateway whose remote access was turned off, or that
 * left its account, keeps serving its last certificate at home and can no longer renew
 * it. The pinned key, not the dates or an authority, is what identifies the gateway, and
 * that check is unchanged. Through the relay's public address, where a current
 * certificate is always available, an expired one is still refused; so is one that is
 * not valid yet, on either path.
 *
 * The trust manager is the single decision point, so [hostnameVerifier] accepts
 * every name.
 */
class LeafCertPinner(
    fingerprintHex: String = "",
    private val host: String? = null,
    private val onSystemTrustVerified: (() -> Unit)? = null,
    private val systemTrust: X509TrustManager = platformDefaultTrustManager(),
    private val requireCertificateValidity: Boolean = false,
    private val verificationDate: () -> Date = { Date() },
    private val spkiFingerprint: String? = null,
    /** Whether a connection to this remote address is a direct one to the gateway itself. Null: none is. */
    private val directPath: ((InetSocketAddress) -> Boolean)? = null,
) {

    private val expected = fingerprintHex.lowercase()
    private val strict = requireCertificateValidity || spkiFingerprint != null
    private val notified = AtomicBoolean(false)

    // The extended form is the one a TLS handshake calls, with the socket it is securing.
    val trustManager: X509TrustManager = object : X509ExtendedTrustManager() {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {}
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {}

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = verify(chain, authType, null)

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
            verify(chain, authType, socket?.remoteSocketAddress as? InetSocketAddress)

        // No socket, so no way to tell the path: the dates are enforced.
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
            verify(chain, authType, null)

        private fun verify(chain: Array<out X509Certificate>?, authType: String?, peer: InetSocketAddress?) {
            val leaf = chain?.firstOrNull()
                ?: throw CertificateException("no server certificate presented")
            if (strict) {
                try {
                    leaf.checkValidity(verificationDate())
                } catch (expired: CertificateExpiredException) {
                    val direct = spkiFingerprint != null && peer != null && directPath?.invoke(peer) == true
                    // The key check below still decides whether this is the paired gateway.
                    if (!direct) throw expired
                }
            }
            if (spkiFingerprint != null) {
                if (sha256Hex(leaf.publicKey.encoded) != spkiFingerprint.lowercase()) throw CertificateException("public key fingerprint mismatch")
                return
            }
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

    /** Strict sessions verify SAN and their configured host; legacy leaf behavior remains unchanged. */
    val hostnameVerifier: HostnameVerifier = HostnameVerifier { name: String, session: SSLSession ->
        !strict || (spkiFingerprint == null || host == null || name.equals(host, ignoreCase = true)) && strictHostnameVerifier.verify(name, session)
    }

    companion object {
        private val strictHostnameVerifier: HostnameVerifier by lazy { OkHttpClient().hostnameVerifier }
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

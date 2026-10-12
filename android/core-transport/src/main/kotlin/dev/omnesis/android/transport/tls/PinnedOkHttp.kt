// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import okhttp3.OkHttpClient
import java.time.Duration
import javax.net.ssl.X509TrustManager

/**
 * Builds the [OkHttpClient] bound to the current pairing. If a valid 64-hex leaf
 * fingerprint is present (pinned-leaf pairing) the client trusts it through a
 * [LeafCertPinner] for [host] — the pairing URL's host — which also accepts a
 * publicly trusted chain for a DNS host and reports that through
 * `onSystemTrustVerified`. Otherwise a default client is returned (V2 / plaintext
 * dev / system trust). The OkHttp analogue of the iOS `OmnesisURLSession` — the
 * `SessionManager` rebuilds the client on pair/unpair/url-change.
 */
object PinnedOkHttp {

    /** Standard request/response client (30s call budget). */
    fun build(
        fingerprint: String? = null,
        requirePin: Boolean = false,
        host: String? = null,
        onSystemTrustVerified: (() -> Unit)? = null,
    ): OkHttpClient =
        baseBuilder(OkHttpClient.Builder(), fingerprint, requirePin, host, onSystemTrustVerified, systemTrust = null)
            .callTimeout(Duration.ofSeconds(30))
            .connectTimeout(Duration.ofSeconds(15))
            .readTimeout(Duration.ofSeconds(30))
            .build()

    /**
     * Long-lived client for the device WebSocket / agent SSE: no call or read
     * timeout (streams stay open), keep-alive pings. Inherits the same pinning.
     */
    fun buildStreaming(
        fingerprint: String? = null,
        requirePin: Boolean = false,
        host: String? = null,
        onSystemTrustVerified: (() -> Unit)? = null,
    ): OkHttpClient =
        baseBuilder(OkHttpClient.Builder(), fingerprint, requirePin, host, onSystemTrustVerified, systemTrust = null)
            .connectTimeout(Duration.ofSeconds(15))
            .readTimeout(Duration.ZERO)
            .callTimeout(Duration.ZERO)
            .pingInterval(Duration.ofSeconds(20))
            .build()

    internal fun buildForTest(
        builder: OkHttpClient.Builder,
        fingerprint: String? = null,
        requirePin: Boolean = false,
        host: String? = null,
        onSystemTrustVerified: (() -> Unit)? = null,
        systemTrust: X509TrustManager? = null,
    ): OkHttpClient =
        baseBuilder(builder, fingerprint, requirePin, host, onSystemTrustVerified, systemTrust).build()

    private fun baseBuilder(
        builder: OkHttpClient.Builder,
        fingerprint: String?,
        requirePin: Boolean,
        host: String?,
        onSystemTrustVerified: (() -> Unit)?,
        systemTrust: X509TrustManager?,
    ): OkHttpClient.Builder {
        val validFingerprint = LeafCertPinner.isValidFingerprint(fingerprint)
        require(!requirePin || validFingerprint) {
            "pinned-leaf TLS trust requires a valid certificate fingerprint"
        }
        if (validFingerprint) {
            val pinner = LeafCertPinner(
                fingerprint!!,
                host,
                onSystemTrustVerified,
                systemTrust ?: LeafCertPinner.platformDefaultTrustManager(),
            )
            builder.sslSocketFactory(pinner.socketFactory, pinner.trustManager)
            builder.hostnameVerifier(pinner.hostnameVerifier)
        }
        return builder
    }
}

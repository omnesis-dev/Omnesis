// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import okhttp3.OkHttpClient
import dev.omnesis.android.transport.routing.DirectGatewayRoute
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
        requireCertificateValidity: Boolean = false,
        spkiFingerprint: String? = null,
        directRoute: DirectGatewayRoute? = null,
    ): OkHttpClient =
        baseBuilder(OkHttpClient.Builder(), fingerprint, requirePin, host, onSystemTrustVerified, systemTrust = null, requireCertificateValidity, spkiFingerprint, directRoute)
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
        requireCertificateValidity: Boolean = false,
        spkiFingerprint: String? = null,
        directRoute: DirectGatewayRoute? = null,
    ): OkHttpClient =
        baseBuilder(OkHttpClient.Builder(), fingerprint, requirePin, host, onSystemTrustVerified, systemTrust = null, requireCertificateValidity, spkiFingerprint, directRoute)
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
        requireCertificateValidity: Boolean = false,
        spkiFingerprint: String? = null,
        directRoute: DirectGatewayRoute? = null,
    ): OkHttpClient =
        baseBuilder(builder, fingerprint, requirePin, host, onSystemTrustVerified, systemTrust, requireCertificateValidity, spkiFingerprint, directRoute).build()

    private fun baseBuilder(
        builder: OkHttpClient.Builder,
        fingerprint: String?,
        requirePin: Boolean,
        host: String?,
        onSystemTrustVerified: (() -> Unit)?,
        systemTrust: X509TrustManager?,
        requireCertificateValidity: Boolean,
        spkiFingerprint: String?,
        directRoute: DirectGatewayRoute?,
    ): OkHttpClient.Builder {
        val validFingerprint = LeafCertPinner.isValidFingerprint(fingerprint)
        val validKey = LeafCertPinner.isValidFingerprint(spkiFingerprint)
        require(spkiFingerprint == null || validKey) { "strict key pin must be a SHA-256 SPKI fingerprint" }
        require(!requirePin || validFingerprint || validKey) {
            "pinned-leaf TLS trust requires a valid certificate fingerprint"
        }
        require(directRoute == null || validKey || validFingerprint && requireCertificateValidity && host == null) {
            "direct routing requires a strict paired TLS identity"
        }
        val pinHost = if (validKey && directRoute != null) {
            require(host == null || host.equals(directRoute.host, ignoreCase = true))
            directRoute.host
        } else host
        if (validFingerprint || validKey) {
            val pinner = LeafCertPinner(
                fingerprint.orEmpty(),
                pinHost,
                onSystemTrustVerified,
                systemTrust ?: LeafCertPinner.platformDefaultTrustManager(),
                requireCertificateValidity = requireCertificateValidity,
                spkiFingerprint = spkiFingerprint,
            )
            builder.sslSocketFactory(pinner.socketFactory, pinner.trustManager)
            builder.hostnameVerifier(pinner.hostnameVerifier)
        }
        return directRoute?.install(builder) ?: builder
    }
}

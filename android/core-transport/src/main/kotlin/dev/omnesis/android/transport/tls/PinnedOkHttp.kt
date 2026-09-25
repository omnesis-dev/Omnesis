// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import okhttp3.OkHttpClient
import java.time.Duration

/**
 * Builds the [OkHttpClient] bound to the current pairing. If a valid 64-hex leaf
 * fingerprint is present (V3 pairing) the client pins to it; otherwise a default
 * client is returned (V2 / plaintext dev / system trust). The OkHttp analogue of the
 * iOS `OmnesisURLSession` — the `SessionManager` rebuilds the client on
 * pair/unpair/url-change.
 */
object PinnedOkHttp {

    /** Standard request/response client (30s call budget). */
    fun build(fingerprint: String? = null, requirePin: Boolean = false): OkHttpClient =
        baseBuilder(OkHttpClient.Builder(), fingerprint, requirePin)
            .callTimeout(Duration.ofSeconds(30))
            .connectTimeout(Duration.ofSeconds(15))
            .readTimeout(Duration.ofSeconds(30))
            .build()

    /**
     * Long-lived client for the device WebSocket / agent SSE: no call or read
     * timeout (streams stay open), keep-alive pings. Inherits the same pinning.
     */
    fun buildStreaming(fingerprint: String? = null, requirePin: Boolean = false): OkHttpClient =
        baseBuilder(OkHttpClient.Builder(), fingerprint, requirePin)
            .connectTimeout(Duration.ofSeconds(15))
            .readTimeout(Duration.ZERO)
            .callTimeout(Duration.ZERO)
            .pingInterval(Duration.ofSeconds(20))
            .build()

    internal fun buildForTest(
        builder: OkHttpClient.Builder,
        fingerprint: String? = null,
        requirePin: Boolean = false,
    ): OkHttpClient = baseBuilder(builder, fingerprint, requirePin).build()

    private fun baseBuilder(
        builder: OkHttpClient.Builder,
        fingerprint: String?,
        requirePin: Boolean,
    ): OkHttpClient.Builder {
        val validFingerprint = LeafCertPinner.isValidFingerprint(fingerprint)
        require(!requirePin || validFingerprint) {
            "pinned-leaf TLS trust requires a valid certificate fingerprint"
        }
        if (validFingerprint) {
            val pinner = LeafCertPinner(fingerprint!!)
            builder.sslSocketFactory(pinner.socketFactory, pinner.trustManager)
            builder.hostnameVerifier(pinner.hostnameVerifier)
        }
        return builder
    }
}

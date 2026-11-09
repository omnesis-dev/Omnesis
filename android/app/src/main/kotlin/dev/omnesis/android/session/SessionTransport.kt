// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import dev.omnesis.android.BuildConfig
import dev.omnesis.android.pairing.PairedGatewayTransport
import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.routing.DirectGatewayRoute
import dev.omnesis.android.transport.tls.PinnedOkHttp
import java.net.URI
import okhttp3.OkHttpClient

/**
 * The session's HTTP clients. A build without cloud connectivity builds them exactly as it
 * did before the feature: no routes, one client shared by the socket and the streams.
 */
internal class SessionTransport(private val cloudEnabled: Boolean = BuildConfig.CLOUD_RELAY_ENABLED) {
    fun http(pairing: Pairing, upgrade: (() -> Unit)?, route: DirectGatewayRoute?): OkHttpClient =
        if (cloudEnabled) PairedGatewayTransport.httpOnRoute(pairing, upgrade, route)
        else PinnedOkHttp.build(
            pairing.fingerprint,
            requirePin = pairing.tlsMode == PairingTlsMode.PINNED_LEAF,
            host = hostOf(pairing.url),
            onSystemTrustVerified = upgrade,
        )

    fun streaming(pairing: Pairing, upgrade: (() -> Unit)?, route: DirectGatewayRoute?): OkHttpClient =
        if (cloudEnabled) PairedGatewayTransport.streamingOnRoute(pairing, upgrade, route)
        else PinnedOkHttp.buildStreaming(
            pairing.fingerprint,
            requirePin = pairing.tlsMode == PairingTlsMode.PINNED_LEAF,
            host = hostOf(pairing.url),
            onSystemTrustVerified = upgrade,
        )

    /** The socket's own client with cloud connectivity, otherwise the [streaming] one. */
    fun socket(pairing: Pairing, upgrade: (() -> Unit)?, route: DirectGatewayRoute?, streaming: OkHttpClient): OkHttpClient =
        if (cloudEnabled) PairedGatewayTransport.socket(pairing, upgrade, route) else streaming

    fun revocation(pending: Pairing): OkHttpClient =
        if (cloudEnabled) PairedGatewayTransport.http(pending)
        else PinnedOkHttp.build(pending.fingerprint, host = hostOf(pending.url))

    fun socketRoute(route: DirectGatewayRoute?): DirectGatewayRoute? = route.takeIf { cloudEnabled }

    fun refreshesHints(pairing: Pairing): Boolean = cloudEnabled && pairing.tlsMode == PairingTlsMode.PINNED_KEY_STRICT

    /** The device the hello reply must name, checked only with cloud connectivity. */
    fun expectedDeviceId(pairing: Pairing): String? =
        pairing.deviceId.takeIf { cloudEnabled && pairing.pairingGeneration != null }

    private fun hostOf(url: String): String? = runCatching { URI(url).host }.getOrNull()
}

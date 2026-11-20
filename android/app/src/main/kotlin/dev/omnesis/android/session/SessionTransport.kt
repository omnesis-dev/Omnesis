// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import dev.omnesis.android.pairing.PairedGatewayTransport
import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.routing.DirectGatewayRoute
import okhttp3.OkHttpClient

/** The session's HTTP clients, each on the pairing's route and under its trust. */
internal class SessionTransport {
    fun http(pairing: Pairing, upgrade: (() -> Unit)?, route: DirectGatewayRoute?): OkHttpClient =
        PairedGatewayTransport.httpOnRoute(pairing, upgrade, route)

    fun streaming(pairing: Pairing, upgrade: (() -> Unit)?, route: DirectGatewayRoute?): OkHttpClient =
        PairedGatewayTransport.streamingOnRoute(pairing, upgrade, route)

    /** The socket has its own client, so replacing it never touches the streams. */
    fun socket(pairing: Pairing, upgrade: (() -> Unit)?, route: DirectGatewayRoute?): OkHttpClient =
        PairedGatewayTransport.socket(pairing, upgrade, route)

    fun revocation(pending: Pairing): OkHttpClient = PairedGatewayTransport.http(pending)

    fun refreshesHints(pairing: Pairing): Boolean = pairing.tlsMode == PairingTlsMode.PINNED_KEY_STRICT

    /** The device the hello reply must name. A pairing from before token generations has no identity to check. */
    fun expectedDeviceId(pairing: Pairing): String? = pairing.deviceId.takeIf { pairing.pairingGeneration != null }
}

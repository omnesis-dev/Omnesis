// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Build the `gatewayUrl` baked into a pairing QR by swapping the chosen network
 * identity's host into the gateway's own origin — preserving the real scheme and
 * port the gateway is served on. Mirrors the portal's
 * `swapHostForUrl(window.location.origin, host)`. Falls back to an
 * `https://host` URL when no origin is known (no port assumed).
 */
fun swapHost(origin: HttpUrl?, host: String): String {
    if (origin == null) return "https://$host"
    return origin.newBuilder().host(host).build().toString().trimEnd('/')
}

/** Resolve an agent setup URL using the selected advertised gateway identity. */
fun agentGatewayUrl(gatewayUrl: String?, identityAddresses: List<String>, selectedIndex: Int): String? {
    if (identityAddresses.isEmpty()) return gatewayUrl
    val boundedIndex = selectedIndex.coerceIn(0, identityAddresses.lastIndex)
    return swapHost(gatewayUrl?.toHttpUrlOrNull(), identityAddresses[boundedIndex])
}

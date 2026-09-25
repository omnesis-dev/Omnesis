// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * Body of `POST /admin/devices/pair` — mint a one-time pairing code. The
 * gateway grants the kind's canonical scopes; the paired device names itself.
 */
@Serializable
data class CreatePairingBody(
    val kind: String,
    val repairDeviceId: String? = null,
)

/**
 * Response of `POST /admin/devices/pair`. Mirrors `PendingPairing` in the
 * gateway's `DeviceRepository.ts`; only the fields the pairing UI renders are
 * decoded — the one-time `pairingCode` and its `expiresAt` (unix ms).
 */
@Serializable
data class PendingPairing(
    val pairingCode: String,
    val expiresAt: Long,
)

/**
 * Body of `POST /admin/devices/pair-qr` — the gateway encodes the QR payload
 * server-side so every client shares the versioned trust policy. `gatewayUrl` is which
 * network identity the new device should reach.
 */
@Serializable
data class PairQrBody(
    val pairingCode: String,
    val gatewayUrl: String,
    val trustMode: String? = null,
)

/** Response of `POST /admin/devices/pair-qr` — the JSON string to QR-encode. */
@Serializable
data class PairQrResponse(
    val qrPayload: String,
)

/**
 * One row of `GET /admin/network-identities`. Mirrors `NetworkIdentity` in
 * `@omnesis/core/network-discovery.ts` — an address the gateway is reachable
 * at, with a human label and an off-LAN flag the pairing UI surfaces as the
 * recommended pick when traveling.
 */
@Serializable
data class NetworkIdentity(
    val address: String,
    val label: String = "",
    val kind: String = "",
    val offLan: Boolean = false,
)

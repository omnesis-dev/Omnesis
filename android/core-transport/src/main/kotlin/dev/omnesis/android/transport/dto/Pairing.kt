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

/** Body of `POST /admin/devices/pair-addresses`. The code travels in the body so request logs cannot keep it. */
@Serializable
data class PairAddressesBody(val pairingCode: String)

/**
 * One address a phone could pair with, judged by the gateway for that phone
 * (`PairingAddressOption` in `packages/core/src/pairing-address.ts`). Every string shown to
 * the person comes from here; the app words none of it.
 */
@Serializable
data class PairingAddressOption(
    /** Passed to `pair-qr` exactly as given. */
    val gatewayUrl: String,
    val host: String = "",
    val label: String = "",
    val usable: Boolean = false,
    /** Why the phone cannot use it; set when [usable] is false. */
    val reason: String? = null,
    /** Where a phone paired with it works; set when [usable] is true. */
    val summary: String? = null,
    /** `this-computer`, `local-network`, `tailnet` or `anywhere`. */
    val reach: String? = null,
    /** The gateway encodes it with system trust, so it can also be typed by hand. */
    val systemTrust: Boolean = false,
    /** `relay` on the gateway's Omnesis address, absent otherwise. */
    val kind: String? = null,
)

/** What to do when no offered address reaches beyond the local network. */
@Serializable
data class AwayFromHomeHint(val onTailnet: Boolean = false, val tailscaleName: String? = null)

/** The gateway's answer to `POST /admin/devices/pair-addresses`: usable addresses best first, then the refused ones. */
@Serializable
data class PairingAddressPlan(
    /** `ios` or `android`: the phone the code was minted for. */
    val platform: String? = null,
    val addresses: List<PairingAddressOption> = emptyList(),
    val recommendedUrl: String? = null,
    val awayFromHome: AwayFromHomeHint? = null,
) {
    val usable: List<PairingAddressOption> get() = addresses.filter { it.usable }
    val refused: List<PairingAddressOption> get() = addresses.filterNot { it.usable }

    /** The usable option at [gatewayUrl], or null: a refused address is never selected. */
    fun selected(gatewayUrl: String?): PairingAddressOption? = usable.firstOrNull { it.gatewayUrl == gatewayUrl }
}

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

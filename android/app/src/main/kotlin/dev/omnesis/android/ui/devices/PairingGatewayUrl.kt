// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.dto.PairingAddressOption
import dev.omnesis.android.transport.dto.PairingAddressPlan

/**
 * The QR payload for the address chosen from the gateway's plan. The option's URL goes to
 * `pair-qr` exactly as the gateway gave it: the app's own route to the gateway (which may be
 * the relay's address and port) says nothing about how the new phone will reach it.
 */
suspend fun AdminClient.pairQrFor(pairingCode: String, option: PairingAddressOption): String =
    buildPairQr(pairingCode, option.gatewayUrl)

/** "<label> · <host>", marked when it is the gateway's recommendation. */
fun pairAddressTitle(option: PairingAddressOption, plan: PairingAddressPlan): String =
    "${option.label} · ${option.host}" + if (option.usable && option.gatewayUrl == plan.recommendedUrl) " (recommended)" else ""

/**
 * Whether the gateway URL and code may be typed by hand on the new phone. Only an address
 * the gateway encodes with system trust: any other carries a pin the QR must deliver.
 */
fun manualEntryOffered(option: PairingAddressOption?): Boolean = option?.usable == true && option.systemTrust

/** What the pairing screen calls the device a code is for. */
fun pairingNoun(kind: String?): String = when (kind) {
    "ios" -> "iPhone"
    "android" -> "Android phone"
    else -> "device"
}

/** "an iPhone", "an Android phone", "a device". */
fun pairingWithArticle(noun: String): String = "${if (noun == "device") "a" else "an"} $noun"

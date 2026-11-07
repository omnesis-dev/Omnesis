// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.BuildConfig
import java.net.URI

internal fun googlePairingConfigured(
    webClientId: String = BuildConfig.GOOGLE_WEB_CLIENT_ID,
    androidClientId: String = BuildConfig.GOOGLE_ANDROID_CLIENT_ID,
    relayOrigin: String = BuildConfig.CLOUD_RELAY_URL,
): Boolean = runCatching {
    val uri = URI(relayOrigin)
    webClientId.endsWith(".apps.googleusercontent.com") && androidClientId.endsWith(".apps.googleusercontent.com") &&
        uri.scheme == "https" && uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null &&
        uri.path in listOf("", "/") && (uri.port == -1 || uri.port in 1..65535)
}.getOrDefault(false)

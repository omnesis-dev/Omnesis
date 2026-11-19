// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.BuildConfig

/** Google sign-in needs the build's OAuth client IDs; without them only a passkey signs in. */
internal fun googlePairingConfigured(
    webClientId: String = BuildConfig.GOOGLE_WEB_CLIENT_ID,
    androidClientId: String = BuildConfig.GOOGLE_ANDROID_CLIENT_ID,
): Boolean = webClientId.endsWith(".apps.googleusercontent.com") && androidClientId.endsWith(".apps.googleusercontent.com")

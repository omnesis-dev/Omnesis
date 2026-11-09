// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import androidx.credentials.CredentialManager
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.session.SessionManager

/** The lazy production callbacks. Constructing an unconfigured pairing screen never opens Google. */
internal object GooglePairingDefaults {
    val credentialManager = GoogleCredentialToken::createManager

    fun ports(session: SessionManager): GooglePairingPorts = configuredPorts(
        session, BuildConfig.CLOUD_RELAY_URL, BuildConfig.GOOGLE_WEB_CLIENT_ID,
        BuildConfig.GOOGLE_ANDROID_CLIENT_ID, credentialManager,
    )

    fun configuredPorts(
        session: SessionManager,
        relay: String,
        webClientId: String,
        androidClientId: String,
        createManager: (Context) -> CredentialManager,
    ): GooglePairingPorts = GooglePairingPorts(
        acquireToken = { context, nonce ->
            GoogleCredentialToken.acquire(context, webClientId, nonce, createManager(context))
        },
        createClient = { GooglePairingSession(relay, webClientId, setOf(webClientId, androidClientId)) },
        applyPairing = { session.pairFromQr(it) },
    )
}

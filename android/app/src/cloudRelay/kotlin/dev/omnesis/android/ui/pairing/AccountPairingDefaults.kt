// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.BuildConfig
import dev.omnesis.android.pairing.AccountCloudPairingClient
import dev.omnesis.android.pairing.PublicCertificateCheck
import dev.omnesis.android.session.SessionManager
import java.net.URI

/** No network or account provider is opened while constructing an optional pairing screen. */
internal object AccountPairingDefaults {
    fun ports(session: SessionManager): AccountPairingPorts? {
        if (!accountPairingConfigured()) return null
        return AccountPairingPorts(
            acquireGoogle = { context, nonce -> GoogleCredentialToken.acquire(context, BuildConfig.GOOGLE_WEB_CLIENT_ID, nonce, GoogleCredentialToken.createManager(context)) },
            acquirePasskey = { context, options -> PasskeyCredentialToken.acquire(context, URI(BuildConfig.CLOUD_RELAY_URL).host, options, GoogleCredentialToken.createManager(context)) },
            createClient = {
                AccountPairingSession(
                    AccountCloudPairingClient(
                        BuildConfig.CLOUD_RELAY_URL,
                        BuildConfig.GOOGLE_WEB_CLIENT_ID,
                        setOf(BuildConfig.GOOGLE_WEB_CLIENT_ID, BuildConfig.GOOGLE_ANDROID_CLIENT_ID),
                        publicCertificateCheck = if (BuildConfig.CLOUD_RELAY_PUBLIC_CERT_CHECK) PublicCertificateCheck()::accepts else null,
                    ),
                )
            },
            applyPairing = { session.pairFromEnrollment(it) },
        )
    }
}

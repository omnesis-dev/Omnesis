// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.pairing.AccountCloudPairingClient
import dev.omnesis.android.pairing.GatewayPasskeySigner
import dev.omnesis.android.pairing.PublicCertificateCheck
import dev.omnesis.android.session.SessionManager
import java.net.URI

/** The production sign-in callbacks. Constructing the pairing screen opens no network connection or account provider. */
internal object AccountPairingDefaults {
    fun ports(session: SessionManager): AccountPairingPorts = AccountPairingPorts(
        acquireGoogle = { context, nonce -> GoogleCredentialToken.acquire(context, BuildConfig.GOOGLE_WEB_CLIENT_ID, nonce, GoogleCredentialToken.createManager(context)) },
        acquirePasskey = { context, options -> PasskeyCredentialToken.acquire(context, relayHost(), options, GoogleCredentialToken.createManager(context)) },
        createClient = {
            AccountPairingSession(
                AccountCloudPairingClient(
                    BuildConfig.CLOUD_RELAY_URL,
                    BuildConfig.GOOGLE_WEB_CLIENT_ID,
                    setOf(BuildConfig.GOOGLE_WEB_CLIENT_ID, BuildConfig.GOOGLE_ANDROID_CLIENT_ID),
                    publicCertificateCheck = if (BuildConfig.CLOUD_RELAY_PUBLIC_CERT_CHECK) PublicCertificateCheck()::accepts else null,
                    trustedGatewayKeys = { setOfNotNull(session.pinnedGatewayKey()) },
                ),
            )
        },
        applyPairing = { session.pairFromEnrollment(it) },
        gatewayPasskey = ::defaultGatewayPasskeySigner,
    )
}

/** The relay's host, the relying party of every Omnesis account passkey. The build checks the relay URL is an https origin. */
private fun relayHost(): String = requireNotNull(URI(BuildConfig.CLOUD_RELAY_URL).host)

/** Approving a held request with a passkey, in this app, for the passkeys of the build's relay. */
internal fun defaultGatewayPasskeySigner(context: Context): GatewayPasskeySigner? =
    PasskeyCredentialToken.gatewaySigner(context, relayHost()) { GoogleCredentialToken.createManager(context) }

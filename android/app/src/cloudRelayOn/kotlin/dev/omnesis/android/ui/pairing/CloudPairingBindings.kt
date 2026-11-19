// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.pairing.GatewayPasskeySigner
import dev.omnesis.android.session.SessionManager
import java.net.URI

/** A build with cloud connectivity: the sign-in ports, backed by the platform credential APIs. */
internal fun defaultGooglePairingPorts(session: SessionManager): GooglePairingPorts = GooglePairingDefaults.ports(session)

internal fun defaultAccountPairingPorts(session: SessionManager): AccountPairingPorts? = AccountPairingDefaults.ports(session)

/** Approving a held request with a passkey, in this app, for the passkeys of the build's relay. */
internal fun defaultGatewayPasskeySigner(context: Context): GatewayPasskeySigner? =
    if (!accountPairingConfigured()) null
    else PasskeyCredentialToken.gatewaySigner(context, URI(BuildConfig.CLOUD_RELAY_URL).host) { GoogleCredentialToken.createManager(context) }

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import dev.omnesis.android.pairing.GatewayPasskeySigner
import dev.omnesis.android.session.SessionManager

private fun absent(): Nothing = error("cloud connectivity is not part of this build")

/** A build without cloud connectivity carries no sign-in code or libraries; nothing reaches these ports. */
@Suppress("UNUSED_PARAMETER")
internal fun defaultGooglePairingPorts(session: SessionManager): GooglePairingPorts =
    GooglePairingPorts(acquireToken = { _, _ -> absent() }, createClient = { absent() }, applyPairing = { absent() })

@Suppress("UNUSED_PARAMETER")
internal fun defaultAccountPairingPorts(session: SessionManager): AccountPairingPorts? = null

@Suppress("UNUSED_PARAMETER")
internal fun defaultGatewayPasskeySigner(context: Context): GatewayPasskeySigner? = null

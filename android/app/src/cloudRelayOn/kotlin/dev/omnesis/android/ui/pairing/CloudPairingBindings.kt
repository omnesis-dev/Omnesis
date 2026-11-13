// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.session.SessionManager

/** A build with cloud connectivity: the sign-in ports, backed by the platform credential APIs. */
internal fun defaultGooglePairingPorts(session: SessionManager): GooglePairingPorts = GooglePairingDefaults.ports(session)

internal fun defaultAccountPairingPorts(session: SessionManager): AccountPairingPorts? = AccountPairingDefaults.ports(session)

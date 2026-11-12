// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context

/** Per-ViewModel boundaries; each successful flow applies to the session that created it. */
internal class GooglePairingPorts(
    val acquireToken: suspend (Context, String) -> String,
    val createClient: () -> GooglePairingAttempt,
    val applyPairing: suspend (String) -> Unit,
)

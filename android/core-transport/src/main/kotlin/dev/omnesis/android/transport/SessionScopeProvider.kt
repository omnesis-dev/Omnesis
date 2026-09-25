// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import kotlinx.coroutines.CoroutineScope

/**
 * The scope of the current gateway session. Work launched in it — a source's
 * first sync after it was turned on — is cancelled when the phone unpairs,
 * re-pairs or changes gateway, so it can never run against a session that
 * no longer exists.
 */
fun interface SessionScopeProvider {
    /** The current session's scope, or null while unpaired. */
    fun current(): CoroutineScope?

    /**
     * Changes every time the session is replaced. Work that started under one
     * value and finds another has outlived its pairing and must not act.
     */
    val generation: Long get() = 0L
}

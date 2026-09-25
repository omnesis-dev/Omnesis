// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The one "setup is presenting" signal. While it reads true, the app's own
 * presenters — relay consent, the held-answer offer, launch buses, deep links —
 * hold what they have and deliver it once it reads false again.
 *
 * Holders rather than a flag: the first-run flow and a flow opened from
 * Settings present through different hosts, and neither may clear the other.
 */
class PhoneSetupGate {
    private val holders = mutableSetOf<Any>()
    private val _presenting = MutableStateFlow(false)
    val presenting: StateFlow<Boolean> = _presenting.asStateFlow()

    fun present(holder: Any) = synchronized(holders) {
        holders += holder
        _presenting.value = true
    }

    fun dismiss(holder: Any) = synchronized(holders) {
        holders -= holder
        _presenting.value = holders.isNotEmpty()
    }
}

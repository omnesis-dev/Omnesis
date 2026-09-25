// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Hands a "open the capture screen" request from an Android entry point (the
 * Quick Settings tile, the static app shortcut — both land in `MainActivity`
 * as an intent) to the Compose nav graph. The scaffold observes [request],
 * navigates to the capture route with the carried surface slug, and calls
 * [consume]. The [nonce] makes back-to-back launches from the same entry point
 * distinct.
 */
@Singleton
class CaptureLaunchBus @Inject constructor() {

    data class Request(val surface: String, val nonce: Long)

    private val _request = MutableStateFlow<Request?>(null)
    val request: StateFlow<Request?> = _request.asStateFlow()

    fun post(surface: String) {
        _request.value = Request(surface = surface, nonce = System.nanoTime())
    }

    fun consume() {
        _request.value = null
    }
}

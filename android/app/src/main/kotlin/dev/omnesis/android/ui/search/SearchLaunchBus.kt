// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Relays an App Actions search request from [dev.omnesis.android.MainActivity] to Search. */
@Singleton
class SearchLaunchBus @Inject constructor() {
    data class Request(val query: String, val nonce: Long)

    private val _request = MutableStateFlow<Request?>(null)
    val request: StateFlow<Request?> = _request.asStateFlow()

    fun post(query: String?) {
        _request.value = Request(query.orEmpty().trim(), System.nanoTime())
    }

    fun consume(request: Request) {
        if (_request.value == request) _request.value = null
    }
}

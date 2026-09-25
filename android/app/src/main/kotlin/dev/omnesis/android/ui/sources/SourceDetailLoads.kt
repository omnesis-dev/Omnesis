// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.ui.common.Loadable
import kotlinx.coroutines.flow.MutableStateFlow

/** Main-thread request ownership keeps reconnects and removal ahead of older responses. */
internal class SourceDetailLoads<T> {
    val state = MutableStateFlow<Loadable<T>>(Loadable.Loading)
    private var generation = 0

    fun begin(clear: Boolean): Int {
        if (clear) state.value = Loadable.Loading
        return ++generation
    }

    fun owns(request: Int) = request == generation

    fun succeeded(request: Int, value: T) {
        if (owns(request)) state.value = Loadable.Content(value)
    }

    fun failed(request: Int, error: Throwable) {
        if (owns(request)) state.value = Loadable.Error(error)
    }

    fun removed(error: Throwable) {
        generation++
        state.value = Loadable.Error(error)
    }
}

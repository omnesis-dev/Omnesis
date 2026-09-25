// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.ModelsOverview

/** Discard reads overtaken by a local write or a newer overview request. */
internal class BehaviorOverviewReader(
    private val generation: () -> Long,
    private val fetch: suspend () -> ModelsOverview,
) {
    private var nextRead = 0L
    private var latestReturned = 0L

    suspend fun read(): ModelsOverview {
        while (true) {
            val atStart = generation()
            val readId = ++nextRead
            val overview = fetch()
            if (atStart != generation() || readId < latestReturned) continue
            latestReturned = readId
            return overview
        }
    }
}

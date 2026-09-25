// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelsOverview
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class BehaviorOverviewReaderTest {
    @Test fun an_overview_started_before_an_acknowledged_save_is_refetched_before_it_can_apply() = runTest {
        val stale = CompletableDeferred<ModelsOverview>()
        val before = overview("low")
        val after = overview("high")
        var generation = 0L
        var fetches = 0
        val reader = BehaviorOverviewReader(
            generation = { generation },
            fetch = {
                fetches++
                if (fetches == 1) stale.await() else after
            },
        )
        val read = async { reader.read() }
        runCurrent()
        generation++ // A PATCH was acknowledged while the first GET was in flight.
        stale.complete(before)
        runCurrent()

        assertEquals(after, read.await())
        assertEquals(2, fetches)
    }

    @Test fun an_older_parallel_get_cannot_replace_an_overview_returned_by_a_later_get() = runTest {
        val firstResponse = CompletableDeferred<ModelsOverview>()
        val current = overview("high")
        var fetches = 0
        val reader = BehaviorOverviewReader(
            generation = { 0L },
            fetch = {
                fetches++
                if (fetches == 1) firstResponse.await() else current
            },
        )
        val first = async { reader.read() }
        runCurrent()
        val second = async { reader.read() }
        runCurrent()
        assertEquals(current, second.await())
        firstResponse.complete(overview("low"))
        runCurrent()
        assertEquals(current, first.await())
        assertEquals(3, fetches)
    }

    private fun overview(effort: String) = ModelsOverview(modelSettings = mapOf(
        "agent" to ModelBehaviorSettings("openrouter/reasoner-v1",
            ModelBehaviorValues(reasoningEffort = effort)),
    ))
}

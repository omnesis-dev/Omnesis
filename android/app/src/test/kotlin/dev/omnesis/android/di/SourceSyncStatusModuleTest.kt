// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SourceSyncStatusModuleTest {
    @Test
    fun session_replacement_cancels_the_old_read_and_emits_the_new_gateway_status() = runTest {
        val sessions = MutableStateFlow<String?>("old")
        val oldReadStarted = CompletableDeferred<Unit>()
        val releaseOldRead = CompletableDeferred<Unit>()
        val observed = mutableListOf<String?>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            sessionBoundStatusFlow(
                sessions = sessions,
                triggers = { emptyFlow() },
                read = { session ->
                    if (session == "old") {
                        oldReadStarted.complete(Unit)
                        releaseOldRead.await()
                        "stale"
                    } else {
                        "fresh"
                    }
                },
            ).filterNotNull().take(1).collect(observed::add)
        }

        oldReadStarted.await()
        sessions.value = "new"
        job.join()
        releaseOldRead.complete(Unit)

        assertEquals(listOf("fresh"), observed)
    }

    @Test
    fun session_replacement_clears_an_already_visible_status_when_the_new_read_fails() = runTest {
        val sessions = MutableStateFlow<String?>("old")
        val observed = mutableListOf<String?>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            sessionBoundStatusFlow(
                sessions = sessions,
                triggers = { emptyFlow() },
                read = { session -> if (session == "old") "old gateway status" else null },
            ).take(3).collect(observed::add)
        }

        sessions.value = "new"
        job.join()

        assertEquals(listOf(null, "old gateway status", null), observed)
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class StatusProbeSerializerTest {
    @Test
    fun `a later status read waits until the earlier response is published`() = runTest {
        val serializer = StatusProbeSerializer()
        val releaseFirst = CompletableDeferred<Unit>()
        val events = mutableListOf<String>()

        launch {
            serializer.run {
                events += "first-started"
                releaseFirst.await()
                events += "first-finished"
            }
        }
        runCurrent()
        launch {
            serializer.run {
                events += "second-started"
                events += "second-finished"
            }
        }
        runCurrent()

        assertEquals(listOf("first-started"), events)
        releaseFirst.complete(Unit)
        runCurrent()
        assertEquals(
            listOf("first-started", "first-finished", "second-started", "second-finished"),
            events,
        )
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WearableReconnectTest {
    private val ready = MutableStateFlow(false)
    private var pausedByLoss = true
    private val calls = mutableListOf<String>()

    private fun TestScope.reconnect(onResume: () -> Unit = {}) = WearableReconnect(
        ready = ready,
        scope = backgroundScope,
        goneAfterMs = 10_000,
        pausedByLoss = { pausedByLoss },
        resume = { calls += "resume"; onResume() },
        giveUp = { calls += "giveUp" },
    )

    @Test fun theLinkComingBackResumes() = runTest {
        reconnect().await()
        runCurrent()
        ready.value = true
        runCurrent()
        assertEquals(listOf("resume"), calls)
    }

    @Test fun aReadyFlagNotYetClearedIsTheOldLink() = runTest {
        ready.value = true
        reconnect().await()
        runCurrent()
        assertEquals(emptyList<String>(), calls)
        ready.value = false
        runCurrent()
        ready.value = true
        runCurrent()
        assertEquals(listOf("resume"), calls)
    }

    @Test fun aLinkThatStaysAwayIsGivenUp() = runTest {
        val r = reconnect()
        r.await()
        advanceTimeBy(10_001)
        assertEquals(listOf("giveUp"), calls)
        assertFalse(r.isWaiting)
    }

    @Test fun aPauseTheUserChoseMeanwhileIsNotResumed() = runTest {
        reconnect().await()
        runCurrent()
        pausedByLoss = false
        ready.value = true
        runCurrent()
        assertEquals(emptyList<String>(), calls)
    }

    @Test fun aResumeThatFailsWaitsAgain() = runTest {
        lateinit var r: WearableReconnect
        r = reconnect(onResume = { r.await() })
        r.await()
        runCurrent()
        ready.value = true
        runCurrent()
        assertEquals(listOf("resume"), calls)
        assertTrue("waiting again after a failed resume", r.isWaiting)
        ready.value = false
        runCurrent()
        ready.value = true
        runCurrent()
        assertEquals(listOf("resume", "resume"), calls)
    }

    @Test fun cancelStopsWaiting() = runTest {
        val r = reconnect()
        r.await()
        runCurrent()
        r.cancel()
        ready.value = true
        advanceTimeBy(20_000)
        assertEquals(emptyList<String>(), calls)
    }
}

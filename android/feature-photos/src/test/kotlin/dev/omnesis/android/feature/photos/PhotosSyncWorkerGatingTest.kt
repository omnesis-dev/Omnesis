// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import androidx.work.ListenableWorker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotosSyncWorkerGatingTest {

    @Test
    fun `runs only when enabled, permitted, and a session exists`() {
        assertTrue(shouldRunPhotosBackgroundSync(enabled = true, hasPermission = true, hasSession = true))
    }

    @Test
    fun `does not run when disabled`() {
        assertFalse(shouldRunPhotosBackgroundSync(enabled = false, hasPermission = true, hasSession = true))
    }

    @Test
    fun `does not run without the photos permission`() {
        assertFalse(shouldRunPhotosBackgroundSync(enabled = true, hasPermission = false, hasSession = true))
    }

    @Test
    fun `does not run while unpaired`() {
        assertFalse(shouldRunPhotosBackgroundSync(enabled = true, hasPermission = true, hasSession = false))
    }

    @Test
    fun `health is reported before a denied worker gate returns success`() = runTest {
        val events = mutableListOf<String>()

        val shouldRun = reportPhotosHealthBeforeBackgroundGate(
            reportHealth = { events += "health" },
            gate = {
                events += "gate"
                shouldRunPhotosBackgroundSync(enabled = true, hasPermission = false, hasSession = true)
            },
        )

        assertFalse(shouldRun)
        assertEquals(listOf("health", "gate"), events)
    }

    @Test
    fun `terminal sync failure cannot poison a later media notification`() {
        assertTrue(terminalResult(isTriggeredDrain = true) is ListenableWorker.Result.Success)
        assertTrue(terminalResult(isTriggeredDrain = false) is ListenableWorker.Result.Failure)
    }

    @Test
    fun `cold-start exception retries a triggered drain without failing its successor`() = runTest {
        val result = protectPhotosWorkerResult(isTriggeredDrain = true) {
            throw IllegalStateException("synthetic dependency failure")
        }
        assertTrue(result is ListenableWorker.Result.Retry)
    }

    @Test(expected = CancellationException::class)
    fun `worker cancellation is not swallowed`() = runTest {
        protectPhotosWorkerResult(isTriggeredDrain = true) {
            throw CancellationException("synthetic stop")
        }
    }
}

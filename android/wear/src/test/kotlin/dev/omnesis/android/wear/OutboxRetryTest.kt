// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.wear.device.WorkManagerRetryScheduler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The outbox's next pass, as WorkManager holds it. */
@RunWith(RobolectricTestRunner::class)
class OutboxRetryTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val now = 1_790_000_000_000L
    private val scheduler = WorkManagerRetryScheduler(context) { now }

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
    }

    private fun pending(): List<WorkInfo> =
        WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(WorkManagerRetryScheduler.WORK_NAME)
            .get()
            .filter { it.state == WorkInfo.State.ENQUEUED }

    @Test
    fun a_pass_is_scheduled_for_when_the_next_backoff_ends() {
        scheduler.schedule(now + 90_000)
        assertEquals(listOf(90_000L), pending().map { it.initialDelayMillis })
    }

    @Test
    fun scheduling_again_replaces_the_pending_pass() {
        scheduler.schedule(now + 90_000)
        scheduler.schedule(now + 30_000)
        assertEquals(listOf(30_000L), pending().map { it.initialDelayMillis })
    }

    @Test
    fun a_time_already_past_runs_after_the_minimum_delay() {
        scheduler.schedule(now - 5_000)
        assertEquals(listOf(WorkManagerRetryScheduler.MINIMUM_DELAY_MS), pending().map { it.initialDelayMillis })
    }

    @Test
    fun nothing_left_to_retry_cancels_the_pending_pass() {
        scheduler.schedule(now + 90_000)
        scheduler.schedule(null)
        assertTrue(pending().isEmpty())
    }
}

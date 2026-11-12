// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.BackoffPolicy
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import dagger.hilt.EntryPoints
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.ui.home.HomeScaffoldHarnessEntryPoint
import dev.omnesis.android.ui.home.MockGateway
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The background drain on the real Hilt graph: the worker resolves the app's own
 * [NotesRepository], paired to a [MockGateway], and WorkManager's test instance records
 * what the scheduler enqueues.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34])
class PendingNotesDrainWorkerTest {
    @get:Rule
    val hilt = HiltAndroidRule(this)

    private val context: Context get() = ApplicationProvider.getApplicationContext<HiltTestApplication>()
    private val gateway = MockGateway()
    private val graph: HomeScaffoldHarnessEntryPoint
        get() = EntryPoints.get(context, HomeScaffoldHarnessEntryPoint::class.java)

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setExecutor(SynchronousExecutor()).build(),
        )
    }

    @After
    fun tearDown() {
        runCatching { graph.sessionManager().beginRepair() }
        gateway.close()
    }

    private fun pair() = runBlocking {
        graph.pairingService().pairManually(gateway.url, "ABCD-EFGH", gateway.fingerprint)
    }

    private fun runWorker(): ListenableWorker.Result = runBlocking {
        TestListenableWorkerBuilder<PendingNotesDrainWorker>(context).build().doWork()
    }

    private fun drainWork(): List<WorkInfo> =
        WorkManager.getInstance(context).getWorkInfosForUniqueWork(PendingNotesDrainScheduler.UNIQUE_WORK_NAME).get()

    @Test
    fun a_transient_failure_is_retried_and_everything_else_ends_the_work() {
        assertEquals(ListenableWorker.Result.retry(), PendingNotesDrainWorker.resultFor(DrainOutcome.RETRY_LATER))
        assertEquals(ListenableWorker.Result.success(), PendingNotesDrainWorker.resultFor(DrainOutcome.SETTLED))
    }

    @Test
    fun the_worker_posts_the_queue_to_the_paired_gateway() = runBlocking {
        pair()
        PendingNotesStore(context).insert("key-a", "Water the ferns", "2026-07-13T08:00:00.000Z", "android-tile")

        val result = runWorker()

        // This gateway has no `/notes` surface: the POST reached it, and a note that
        // waits on a gateway upgrade is not retried in the background.
        assertTrue("POST /notes" in gateway.requests)
        assertEquals(ListenableWorker.Result.success(), result)
        assertEquals(1, PendingNotesStore(context).readAll().size)
        assertTrue(drainWork().isEmpty())
    }

    @Test
    fun the_worker_retries_while_the_gateway_is_unreachable_and_stays_scheduled() = runBlocking {
        pair()
        PendingNotesStore(context).insert("key-a", "Water the ferns", "2026-07-13T08:00:00.000Z", "android-tile")
        gateway.close()

        assertEquals(ListenableWorker.Result.retry(), runWorker())

        val queued = PendingNotesStore(context).readAll().single()
        assertEquals("Gateway unreachable", queued.lastFailure)
        assertEquals(1, queued.retryCount)
        // The failed drain asked for another through the app's own scheduler.
        assertEquals(1, drainWork().size)
    }

    @Test
    fun the_worker_has_nothing_to_do_while_unpaired() = runBlocking {
        PendingNotesStore(context).insert("key-a", "Water the ferns", "2026-07-13T08:00:00.000Z", "android-tile")

        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertEquals(1, PendingNotesStore(context).readAll().size)
    }

    @Test
    fun scheduling_enqueues_one_network_constrained_drain_and_keeps_it() {
        PendingNotesDrainScheduler.schedule(context)
        val first = drainWork().single()
        assertEquals(WorkInfo.State.ENQUEUED, first.state)
        assertEquals(NetworkType.CONNECTED, first.constraints.requiredNetworkType)

        // A second queued note joins the drain already waiting instead of resetting it.
        PendingNotesDrainScheduler.schedule(context)
        assertEquals(first.id, drainWork().single().id)
    }

    @Test
    fun the_drain_request_waits_for_a_network_and_backs_off_exponentially() {
        val spec = PendingNotesDrainScheduler.request().workSpec
        assertEquals(NetworkType.CONNECTED, spec.constraints.requiredNetworkType)
        assertEquals(BackoffPolicy.EXPONENTIAL, spec.backoffPolicy)
        assertEquals(30_000L, spec.backoffDelayDuration)
    }
}

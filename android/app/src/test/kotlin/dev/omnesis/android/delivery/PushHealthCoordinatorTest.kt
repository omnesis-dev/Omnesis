// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.delivery

import dev.omnesis.android.transport.DeliveryEvidence
import dev.omnesis.android.transport.DeliveryReporter
import dev.omnesis.android.transport.PushHealth
import dev.omnesis.android.transport.RetryOutcome
import dev.omnesis.android.transport.SkippedPush
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The retry lifecycle, which is the reason the phase is held here rather than
 * in a composable: a re-entrant tap must be dropped rather than queued, and a
 * later pass must retire a report describing numbers that have since moved.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushHealthCoordinatorTest {

    private val now = Instant.parse("2026-03-04T12:00:00Z")

    /**
     * A source whose evidence and retry result the test dictates. [gate], when
     * set, holds a retry open so the test can observe the running phase.
     */
    private class FakeReporter(
        var evidence: DeliveryEvidence = DeliveryEvidence("photos:local"),
        var outcome: RetryOutcome = RetryOutcome.IDLE,
        var gate: CompletableDeferred<Unit>? = null,
        var evidenceFailure: Throwable? = null,
    ) : DeliveryReporter {
        var retries = 0
        var discards = 0

        override suspend fun deliveryEvidence(): DeliveryEvidence {
            evidenceFailure?.let { throw it }
            return evidence
        }

        override suspend fun retryDelivery(): RetryOutcome {
            retries++
            gate?.await()
            return outcome
        }

        override suspend fun discardUndelivered() {
            discards++
        }
    }

    private fun TestScope.coordinator(vararg reporters: DeliveryReporter) = PushHealthCoordinator(
        reporters = { reporters.toList() },
        scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
        clock = { now },
    )

    @Test
    fun `an unpaired app with no reporters reads healthy`() = runTest {
        val coordinator = coordinator()
        coordinator.refreshNow()
        assertTrue(PushHealth.isHealthy(coordinator.state.value.snapshot))
        assertEquals(PushHealth.RetryPhase.Idle, coordinator.state.value.retryPhase)
    }

    @Test
    fun `a refresh folds every source's evidence`() = runTest {
        val coordinator = coordinator(
            FakeReporter(DeliveryEvidence("photos:local", blocked = true)),
            FakeReporter(
                DeliveryEvidence(
                    sourceId = "activity:local",
                    queuedCount = 12,
                    oldestQueuedAtMillis = now.toEpochMilli() - 60_000,
                    setAsideCount = 3,
                ),
            ),
        )

        coordinator.refreshNow()

        val snapshot = coordinator.state.value.snapshot
        assertEquals(listOf("photos:local"), snapshot.blockedSourceIds)
        assertEquals(12, snapshot.queued.single().count)
        assertEquals(3, snapshot.setAside.single().count)
    }

    @Test
    fun `a source whose evidence cannot be read is left out rather than failing the pass`() = runTest {
        val coordinator = coordinator(
            FakeReporter(evidenceFailure = IllegalStateException("no store")),
            FakeReporter(DeliveryEvidence("photos:local", blocked = true)),
        )

        coordinator.refreshNow()

        assertEquals(listOf("photos:local"), coordinator.state.value.snapshot.blockedSourceIds)
    }

    @Test
    fun `a retry runs every source and reports one combined answer`() = runTest {
        val a = FakeReporter(outcome = RetryOutcome.DELIVERED)
        val b = FakeReporter(outcome = RetryOutcome.UNREACHABLE)
        val coordinator = coordinator(a, b)

        coordinator.retry()

        assertEquals(1, a.retries)
        assertEquals(1, b.retries)
        assertEquals(
            PushHealth.RetryPhase.Reported(RetryOutcome.UNREACHABLE),
            coordinator.state.value.retryPhase,
        )
    }

    @Test
    fun `a retry that throws is reported rather than swallowed`() = runTest {
        val thrower = object : DeliveryReporter {
            override suspend fun deliveryEvidence() = DeliveryEvidence("boom:local")

            override suspend fun retryDelivery(): RetryOutcome = throw IllegalStateException("boom")

            override suspend fun discardUndelivered() = Unit
        }
        val coordinator = coordinator(thrower)

        coordinator.retry()

        assertEquals(
            PushHealth.RetryPhase.Reported(RetryOutcome.FAILED),
            coordinator.state.value.retryPhase,
        )
    }

    @Test
    fun `a second tap while a retry runs is dropped, not queued`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val reporter = FakeReporter(outcome = RetryOutcome.DELIVERED, gate = gate)
        val coordinator = coordinator(reporter)

        coordinator.retry()
        assertEquals(PushHealth.RetryPhase.Running, coordinator.state.value.retryPhase)

        coordinator.retry()
        coordinator.retry()

        gate.complete(Unit)
        testScheduler.advanceUntilIdle()

        // A queued second pass would find the source busy, come back with
        // nothing, and overwrite the answer the first one produced.
        assertEquals(1, reporter.retries)
        assertEquals(
            PushHealth.RetryPhase.Reported(RetryOutcome.DELIVERED),
            coordinator.state.value.retryPhase,
        )
    }

    @Test
    fun `a retry can be started again once the previous one reported`() = runTest {
        val reporter = FakeReporter(outcome = RetryOutcome.IDLE)
        val coordinator = coordinator(reporter)

        coordinator.retry()
        coordinator.retry()

        assertEquals(2, reporter.retries)
    }

    @Test
    fun `a later refresh retires a finished report`() = runTest {
        val reporter = FakeReporter(outcome = RetryOutcome.UNREACHABLE)
        val coordinator = coordinator(reporter)

        coordinator.retry()
        assertTrue(coordinator.state.value.retryPhase is PushHealth.RetryPhase.Reported)

        // The counts the message described have moved; a stale "couldn't reach
        // Omnesis" sitting under them is worse than no message at all.
        reporter.evidence = DeliveryEvidence("photos:local", setAsideCount = 2)
        coordinator.refreshNow()

        assertEquals(PushHealth.RetryPhase.Idle, coordinator.state.value.retryPhase)
        assertEquals(2, coordinator.state.value.snapshot.setAside.single().count)
    }

    @Test
    fun `the refresh inside a retry does not retire the report that retry is about to make`() = runTest {
        val coordinator = coordinator(FakeReporter(outcome = RetryOutcome.REFUSED))

        coordinator.retry()

        assertEquals(
            PushHealth.RetryPhase.Reported(RetryOutcome.REFUSED),
            coordinator.state.value.retryPhase,
        )
    }

    @Test
    fun `discarding clears every source and re-reads the evidence`() = runTest {
        val reporter = FakeReporter(
            evidence = DeliveryEvidence(
                sourceId = "photos:local",
                skipped = listOf(SkippedPush("photos:local", "one page", 6, 0)),
            ),
        )
        val coordinator = coordinator(reporter)
        coordinator.refreshNow()
        assertTrue(PushHealth.hasUndelivered(coordinator.state.value.snapshot))

        reporter.evidence = DeliveryEvidence("photos:local")
        coordinator.discardUndelivered()

        assertEquals(1, reporter.discards)
        assertTrue(PushHealth.isHealthy(coordinator.state.value.snapshot))
    }
}

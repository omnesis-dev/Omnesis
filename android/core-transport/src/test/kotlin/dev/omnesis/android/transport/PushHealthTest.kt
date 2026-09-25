// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import java.time.Duration
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [PushHealth] decides, from what the sources report, whether to tell the user
 * their phone has stopped delivering data. Getting that wrong in either
 * direction is costly: a missed warning hides silent data loss, and a warning
 * that cannot be cleared trains the user to ignore the surface entirely.
 */
class PushHealthTest {

    private val now: Instant = Instant.parse("2026-03-04T12:00:00Z")
    private val threshold = PushHealth.BACKLOG_THRESHOLD.toMillis()

    private fun evidence(
        sourceId: String = "photos:local",
        blocked: Boolean = false,
        queuedCount: Int = 0,
        queuedAgeMillis: Long? = null,
        setAsideCount: Int = 0,
        skipped: List<SkippedPush> = emptyList(),
    ) = DeliveryEvidence(
        sourceId = sourceId,
        blocked = blocked,
        queuedCount = queuedCount,
        oldestQueuedAtMillis = queuedAgeMillis?.let { now.toEpochMilli() - it },
        setAsideCount = setAsideCount,
        skipped = skipped,
    )

    private fun marker(sourceId: String = "photos:local", atMillis: Long = 0) =
        SkippedPush(sourceId = sourceId, unit = "one page", refusals = 6, atMillis = atMillis)

    private fun snapshot(vararg evidence: DeliveryEvidence) = PushHealth.summarize(evidence.toList(), now)

    // --- summarize ---

    @Test
    fun `no sources at all is an empty snapshot`() {
        val snap = PushHealth.summarize(emptyList(), now)
        assertEquals(PushHealthSnapshot(), snap)
        assertTrue(PushHealth.isHealthy(snap))
    }

    @Test
    fun `a source with nothing to report contributes nothing`() {
        val snap = snapshot(evidence())
        assertEquals(PushHealthSnapshot(), snap)
    }

    @Test
    fun `blocked sources are collected and sorted`() {
        val snap = snapshot(
            evidence(sourceId = "photos:local", blocked = true),
            evidence(sourceId = "call-log:local", blocked = true),
            evidence(sourceId = "health:local"),
        )
        assertEquals(listOf("call-log:local", "photos:local"), snap.blockedSourceIds)
    }

    @Test
    fun `a queue's age is measured from the oldest row's clock`() {
        val snap = snapshot(evidence(queuedCount = 412, queuedAgeMillis = 3 * threshold))
        assertEquals(listOf(QueuedBacklog("photos:local", 412, 3 * threshold)), snap.queued)
    }

    @Test
    fun `a queue whose oldest row is unknown reports a null age rather than zero`() {
        // A count with no clock is not the same as "waiting no time at all":
        // reporting zero would silently promise the queue is moving.
        val snap = snapshot(evidence(queuedCount = 3, queuedAgeMillis = null))
        assertNull(snap.queued.single().oldestAgeMillis)
        assertFalse(PushHealth.isBacklogged(snap))
    }

    @Test
    fun `a clock that moved backwards under the queue reports no wait rather than a negative one`() {
        val snap = snapshot(evidence(queuedCount = 1, queuedAgeMillis = -60_000))
        assertEquals(0L, snap.queued.single().oldestAgeMillis)
    }

    @Test
    fun `empty queues and empty holdings are left out entirely`() {
        val snap = snapshot(evidence(queuedCount = 0, setAsideCount = 0))
        assertTrue(snap.queued.isEmpty())
        assertTrue(snap.setAside.isEmpty())
    }

    @Test
    fun `markers from every source are merged oldest first`() {
        val snap = snapshot(
            evidence(sourceId = "photos:local", skipped = listOf(marker("photos:local", atMillis = 200))),
            evidence(sourceId = "call-log:local", skipped = listOf(marker("call-log:local", atMillis = 100))),
        )
        assertEquals(listOf("call-log:local", "photos:local"), snap.skipped.map { it.sourceId })
    }

    // --- isHealthy ---

    @Test
    fun `nothing pending is healthy`() {
        assertTrue(PushHealth.isHealthy(snapshot(evidence())))
    }

    @Test
    fun `a fresh queue is healthy`() {
        // A non-empty queue is the normal state mid-sync — the warning is about
        // the oldest row aging, not about anything being queued at all.
        assertTrue(PushHealth.isHealthy(snapshot(evidence(queuedCount = 40, queuedAgeMillis = 60_000))))
    }

    @Test
    fun `a stale queue is not healthy`() {
        assertFalse(PushHealth.isHealthy(snapshot(evidence(queuedCount = 40, queuedAgeMillis = threshold + 1))))
    }

    @Test
    fun `a blocked source is not healthy`() {
        assertFalse(PushHealth.isHealthy(snapshot(evidence(blocked = true))))
    }

    @Test
    fun `set-aside rows are not healthy`() {
        assertFalse(PushHealth.isHealthy(snapshot(evidence(setAsideCount = 1))))
    }

    @Test
    fun `a skipped unit is not healthy`() {
        // The whole reason the banner can stop nagging: nothing is queued,
        // nothing is blocked, and the surface still has to say data never
        // arrived.
        assertFalse(PushHealth.isHealthy(snapshot(evidence(skipped = listOf(marker())))))
    }

    // --- isBacklogged ---

    @Test
    fun `the backlog threshold is inclusive`() {
        assertTrue(PushHealth.isBacklogged(snapshot(evidence(queuedCount = 1, queuedAgeMillis = threshold))))
        assertFalse(PushHealth.isBacklogged(snapshot(evidence(queuedCount = 1, queuedAgeMillis = threshold - 1))))
    }

    @Test
    fun `the threshold is overridable so a caller can reason at another horizon`() {
        val snap = snapshot(evidence(queuedCount = 1, queuedAgeMillis = Duration.ofHours(2).toMillis()))
        assertFalse(PushHealth.isBacklogged(snap))
        assertTrue(PushHealth.isBacklogged(snap, threshold = Duration.ofHours(1)))
    }

    @Test
    fun `a backlog is suppressed while any source is blocked`() {
        // A blocked source's rows are never removed and sit at the head of its
        // queue, so the oldest-row age grows without bound however healthy
        // everything else is. Reporting it would latch a second alarm whose
        // retry cannot help.
        val snap = snapshot(
            evidence(sourceId = "activity:local", queuedCount = 900, queuedAgeMillis = 5 * threshold),
            evidence(sourceId = "photos:local", blocked = true),
        )
        assertFalse(PushHealth.isBacklogged(snap))
        assertFalse(PushHealth.isHealthy(snap))
    }

    @Test
    fun `one stale queue among fresh ones still reports`() {
        val snap = snapshot(
            evidence(sourceId = "a:local", queuedCount = 5, queuedAgeMillis = 60_000),
            evidence(sourceId = "b:local", queuedCount = 5, queuedAgeMillis = threshold),
        )
        assertTrue(PushHealth.isBacklogged(snap))
    }

    @Test
    fun `no queue at all is never backlogged`() {
        assertFalse(PushHealth.isBacklogged(snapshot(evidence())))
    }

    // --- hasUndelivered ---

    @Test
    fun `undelivered covers both what is held and what was skipped`() {
        assertFalse(PushHealth.hasUndelivered(snapshot(evidence())))
        assertTrue(PushHealth.hasUndelivered(snapshot(evidence(setAsideCount = 1))))
        assertTrue(PushHealth.hasUndelivered(snapshot(evidence(skipped = listOf(marker())))))
    }

    // --- combine ---

    @Test
    fun `nothing to report combines to idle`() {
        assertEquals(RetryOutcome.IDLE, PushHealth.combine(emptyList()))
        assertEquals(RetryOutcome.IDLE, PushHealth.combine(listOf(RetryOutcome.IDLE, RetryOutcome.IDLE)))
    }

    @Test
    fun `the outcome the user can act on wins`() {
        assertEquals(
            RetryOutcome.FAILED,
            PushHealth.combine(listOf(RetryOutcome.DELIVERED, RetryOutcome.REFUSED, RetryOutcome.FAILED)),
        )
        assertEquals(
            RetryOutcome.UNREACHABLE,
            PushHealth.combine(listOf(RetryOutcome.DELIVERED, RetryOutcome.REFUSED, RetryOutcome.UNREACHABLE)),
        )
        assertEquals(
            RetryOutcome.REFUSED,
            PushHealth.combine(listOf(RetryOutcome.DELIVERED, RetryOutcome.IDLE, RetryOutcome.REFUSED)),
        )
    }

    @Test
    fun `a local read failure is trouble even when another source delivered`() {
        assertEquals(
            RetryOutcome.INCOMPLETE,
            PushHealth.combine(listOf(RetryOutcome.DELIVERED, RetryOutcome.INCOMPLETE, RetryOutcome.IDLE)),
        )
        for (higherPriority in listOf(RetryOutcome.FAILED, RetryOutcome.UNREACHABLE, RetryOutcome.REFUSED)) {
            assertEquals(higherPriority, PushHealth.combine(listOf(RetryOutcome.INCOMPLETE, higherPriority)))
        }
        assertTrue(PushHealth.retryIsTrouble(RetryOutcome.INCOMPLETE))
        val message = PushHealth.retryMessage(RetryOutcome.INCOMPLETE)
        assertTrue(message.contains("read on this phone"))
        assertFalse(message.contains("reach Omnesis"))
        assertFalse(message.contains("paired"))
    }

    @Test
    fun `a pass that delivered outranks the ones that did nothing`() {
        assertEquals(
            RetryOutcome.DELIVERED,
            PushHealth.combine(listOf(RetryOutcome.IDLE, RetryOutcome.BUSY, RetryOutcome.DELIVERED)),
        )
        assertEquals(RetryOutcome.BUSY, PushHealth.combine(listOf(RetryOutcome.IDLE, RetryOutcome.BUSY)))
    }

    @Test
    fun `a single outcome combines to itself`() {
        for (outcome in RetryOutcome.entries) {
            assertEquals(outcome, PushHealth.combine(listOf(outcome)))
        }
    }

    // --- Retry feedback ---

    @Test
    fun `every outcome reports back`() {
        // A retry that achieved nothing must be distinguishable from a button
        // that is not wired up.
        for (outcome in RetryOutcome.entries) {
            assertTrue("$outcome must report back", PushHealth.retryMessage(outcome).isNotBlank())
        }
    }

    @Test
    fun `each outcome has its own copy`() {
        val messages = RetryOutcome.entries.map(PushHealth::retryMessage)
        assertEquals(messages.size, messages.toSet().size)
    }

    @Test
    fun `the refusal message does not invite pointless retries`() {
        // The gateway answered and rejected the payload; tapping harder cannot
        // change that.
        val message = PushHealth.retryMessage(RetryOutcome.REFUSED)
        assertTrue("got: $message", message.contains("won't change that"))
    }

    @Test
    fun `only the outcomes that leave data undelivered read as trouble`() {
        for (outcome in listOf(RetryOutcome.REFUSED, RetryOutcome.UNREACHABLE, RetryOutcome.FAILED, RetryOutcome.INCOMPLETE)) {
            assertTrue("$outcome is bad news", PushHealth.retryIsTrouble(outcome))
        }
        for (outcome in listOf(RetryOutcome.DELIVERED, RetryOutcome.BUSY, RetryOutcome.IDLE)) {
            assertFalse("$outcome is not a failure", PushHealth.retryIsTrouble(outcome))
        }
    }

    // --- waitedLabel ---

    @Test
    fun `a wait is reported at one unit of precision`() {
        assertEquals("3 days", PushHealth.waitedLabel(Duration.ofHours(74).toMillis()))
        assertEquals("1 day", PushHealth.waitedLabel(Duration.ofHours(25).toMillis()))
        assertEquals("6 hours", PushHealth.waitedLabel(Duration.ofHours(6).toMillis()))
        assertEquals("1 hour", PushHealth.waitedLabel(Duration.ofMinutes(90).toMillis()))
        assertEquals("12 minutes", PushHealth.waitedLabel(Duration.ofMinutes(12).toMillis()))
    }

    @Test
    fun `anything shorter than a minute still reads as a minute`() {
        // "0 minutes" would say the queue is moving when it is not.
        assertEquals("1 minute", PushHealth.waitedLabel(0))
        assertEquals("1 minute", PushHealth.waitedLabel(-5_000))
        assertEquals("1 minute", PushHealth.waitedLabel(59_000))
    }

    // --- RetryPhase ---

    @Test
    fun `a reported phase carries the outcome it reports`() {
        val phase: PushHealth.RetryPhase = PushHealth.RetryPhase.Reported(RetryOutcome.REFUSED)
        assertEquals(PushHealth.RetryPhase.Reported(RetryOutcome.REFUSED), phase)
        assertFalse(phase == PushHealth.RetryPhase.Reported(RetryOutcome.IDLE))
    }
}

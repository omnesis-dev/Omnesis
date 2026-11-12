// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import dev.omnesis.android.wearprotocol.OutboxPolicy.Action
import dev.omnesis.android.wearprotocol.OutboxPolicy.Transport
import dev.omnesis.android.wearprotocol.OutboxPolicy.Trigger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class OutboxPolicyTest {
    private val now = 1_790_000_000_000L
    private val captureTime = NoteCaptureTime(now, "Europe/London", 3600)

    private fun recording(ref: String, ageMs: Long = 0, failures: Int = 0, failedAgoMs: Long? = null) = OutboxEntry(
        content = VoiceRecording(ref, captureTime, "en-GB").toMetadata(),
        queuedAt = now - ageMs,
        failures = failures,
        lastFailureAt = failedAgoMs?.let { now - it },
    )

    private fun textNote(ref: String, ageMs: Long = 0, failures: Int = 0, failedAgoMs: Long? = null) = OutboxEntry(
        content = TextNote.of("Order the birthday cake", captureTime, ref),
        queuedAt = now - ageMs,
        failures = failures,
        lastFailureAt = failedAgoMs?.let { now - it },
    )

    @Test
    fun the_limits_are_a_week_and_fifty_entries() {
        assertEquals(7.days, OutboxPolicy.RETENTION)
        assertEquals(50, OutboxPolicy.MAX_ENTRIES)
    }

    @Test
    fun every_waiting_entry_nothing_carries_is_sent() {
        val entries = listOf(recording("a"), recording("b", ageMs = 1_000), textNote("c", ageMs = 2_000))
        for (trigger in Trigger.entries) {
            assertEquals(
                mapOf("a" to Action.SEND, "b" to Action.WAIT, "c" to Action.SEND),
                OutboxPolicy.plan(entries, carried = setOf("b"), trigger = trigger, now = now),
            )
        }
    }

    @Test
    fun a_failed_entry_waits_out_its_backoff_on_a_retry() {
        val entries = listOf(
            recording("just-failed", failures = 1, failedAgoMs = 29_999),
            recording("due", failures = 1, failedAgoMs = 30_000),
            textNote("second-failure", failures = 2, failedAgoMs = 60_000),
            recording("never-failed"),
        )
        assertEquals(
            mapOf(
                "just-failed" to Action.WAIT,
                "due" to Action.SEND,
                "second-failure" to Action.WAIT,
                "never-failed" to Action.SEND,
            ),
            OutboxPolicy.plan(entries, carried = emptySet(), trigger = Trigger.RETRY, now = now),
        )
    }

    @Test
    fun the_link_coming_back_sends_a_failed_entry_at_once() {
        val entries = listOf(recording("a", failures = 3, failedAgoMs = 1_000))
        assertEquals(
            mapOf("a" to Action.SEND),
            OutboxPolicy.plan(entries, emptySet(), Trigger.LINK_MAY_HAVE_CHANGED, now),
        )
    }

    @Test
    fun backoff_grows_and_is_bounded() {
        assertEquals(
            listOf(30.seconds, 30.seconds, 2.minutes, 10.minutes, 30.minutes, 60.minutes, 60.minutes, 60.minutes),
            listOf(0, 1, 2, 3, 4, 5, 6, 40).map(OutboxPolicy::backoff),
        )
    }

    @Test
    fun entries_past_retention_are_dropped_even_when_carried() {
        val week = 7.days.inWholeMilliseconds
        val entries = listOf(recording("at-limit", ageMs = week), textNote("past", ageMs = week + 1))
        assertEquals(
            mapOf("at-limit" to Action.WAIT, "past" to Action.DROP),
            OutboxPolicy.plan(entries, carried = setOf("at-limit", "past"), Trigger.LINK_MAY_HAVE_CHANGED, now),
        )
    }

    @Test
    fun past_the_cap_the_oldest_are_dropped() {
        val entries = (0 until 53).map { recording("r$it", ageMs = it * 1_000L) }.shuffled(java.util.Random(7))
        val plan = OutboxPolicy.plan(entries, emptySet(), Trigger.LINK_MAY_HAVE_CHANGED, now)
        assertEquals(53, plan.size)
        assertEquals(setOf("r50", "r51", "r52"), plan.filterValues { it == Action.DROP }.keys)
        assertEquals(50, plan.count { it.value == Action.SEND })
    }

    @Test
    fun a_recording_goes_as_an_item_and_a_text_note_live_when_reachable() {
        for (reachable in listOf(true, false)) {
            assertEquals(Transport.RECORDING_ITEM, OutboxPolicy.transport(recording("a"), reachable))
        }
        assertEquals(Transport.LIVE_MESSAGE, OutboxPolicy.transport(textNote("a"), phoneReachable = true))
        assertEquals(Transport.QUEUED_ITEM, OutboxPolicy.transport(textNote("a"), phoneReachable = false))
    }

    @Test
    fun the_next_pass_is_the_earliest_backoff_still_running() {
        val entries = listOf(
            recording("soon", failures = 1, failedAgoMs = 10_000),
            textNote("later", failures = 2, failedAgoMs = 10_000),
        )
        assertEquals(now + 20_000, OutboxPolicy.nextRetry(entries, emptySet(), now))
        assertEquals(now + 110_000, OutboxPolicy.nextRetry(entries, carried = setOf("soon"), now = now))
    }

    @Test
    fun an_entry_nothing_took_and_nothing_failed_is_offered_again_after_the_recheck() {
        val recheck = OutboxPolicy.UNCARRIED_RECHECK.inWholeMilliseconds
        assertEquals(now + recheck, OutboxPolicy.nextRetry(listOf(recording("fresh")), emptySet(), now))
        // A backoff that has run out is no reason to wait longer than the recheck either.
        val due = recording("due", failures = 1, failedAgoMs = 30_000)
        assertEquals(now + recheck, OutboxPolicy.nextRetry(listOf(due), emptySet(), now))
        // A backoff still running comes first when it ends sooner.
        val soon = recording("soon", failures = 1, failedAgoMs = 10_000)
        assertEquals(now + 20_000, OutboxPolicy.nextRetry(listOf(recording("fresh"), soon), emptySet(), now))
    }

    @Test
    fun a_carried_entry_still_has_the_pass_that_drops_it_once_it_has_waited_too_long() {
        val retention = OutboxPolicy.RETENTION.inWholeMilliseconds
        val entries = listOf(recording("old", ageMs = 3_600_000), textNote("new", ageMs = 60_000))
        val dropsOldest = now - 3_600_000 + retention + 1
        assertEquals(dropsOldest, OutboxPolicy.nextRetry(entries, carried = setOf("old", "new"), now = now))
        // The pass at that moment drops it.
        val plan = OutboxPolicy.plan(entries, setOf("old", "new"), Trigger.RETRY, dropsOldest)
        assertEquals(Action.DROP, plan["old"])
        assertEquals(Action.WAIT, plan["new"])
    }

    @Test
    fun an_outbox_with_entries_always_has_a_pass_coming_and_an_empty_one_has_none() {
        val entries = listOf(
            recording("failed", failures = 3, failedAgoMs = 5_000),
            recording("due", failures = 1, failedAgoMs = 30_000),
            textNote("fresh"),
            recording("old", ageMs = 6 * 24 * 3_600_000L),
        )
        val refs = entries.map { it.ref }
        for (size in 0..refs.size) {
            val next = OutboxPolicy.nextRetry(entries, carried = refs.take(size).toSet(), now = now)
            assertTrue("carried=${refs.take(size)}", next != null && next > now)
        }
        assertNull(OutboxPolicy.nextRetry(emptyList(), emptySet(), now))
    }

    @Test
    fun a_failure_is_recorded_on_the_entry() {
        val failed = recording("a").failed(now + 5).failed(now + 9)
        assertEquals(2, failed.failures)
        assertEquals(now + 9, failed.lastFailureAt)
        assertEquals("a", failed.ref)
    }
}

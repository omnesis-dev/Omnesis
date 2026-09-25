// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import java.time.Duration
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Plain-JUnit tests for [ActivitySegmentsNormalizer] — no Robolectric, no
 * GMS import anywhere in this file.
 */
class ActivitySegmentsNormalizerTest {

    private val t0 = 1_772_582_400_000L // 2026-03-04T00:00:00Z

    private fun enter(id: Long, type: String, t: Long) = BufferedTransitionEvent(id, type, "ENTER", t * 1_000_000, t)
    private fun exit(id: Long, type: String, t: Long) = BufferedTransitionEvent(id, type, "EXIT", t * 1_000_000, t)

    @Test
    fun `a contiguous ENTER-EXIT pair becomes one closed segment`() {
        val events = listOf(enter(1, "walking", t0), exit(2, "walking", t0 + 6 * 60_000))
        val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(events, Instant.ofEpochMilli(t0 + 60 * 60_000))

        assertEquals(1, outcome.closedSegments.size)
        val segment = outcome.closedSegments.single()
        assertEquals("walking", segment.activityType)
        assertEquals(Duration.ofMinutes(6), segment.duration)
        assertEquals(false, segment.truncated)
        assertEquals(2L, outcome.consumedThroughId)
    }

    @Test
    fun `a segment shorter than the floor is dropped from output but still consumed`() {
        val events = listOf(enter(1, "still", t0), exit(2, "still", t0 + 5_000))
        val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(events, Instant.ofEpochMilli(t0 + 60_000))

        assertTrue(outcome.closedSegments.isEmpty())
        assertEquals(2L, outcome.consumedThroughId)
    }

    @Test
    fun `an EXIT with no matching open ENTER is consumed but produces no segment`() {
        val events = listOf(exit(1, "walking", t0))
        val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(events, Instant.ofEpochMilli(t0 + 60_000))

        assertTrue(outcome.closedSegments.isEmpty())
        assertEquals(1L, outcome.consumedThroughId)
    }

    @Test
    fun `an ENTER for a different type closes the old segment without a matching EXIT`() {
        val events = listOf(
            enter(1, "walking", t0),
            enter(2, "running", t0 + 6 * 60_000),
            exit(3, "running", t0 + 12 * 60_000),
        )
        val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(events, Instant.ofEpochMilli(t0 + 60 * 60_000))

        assertEquals(2, outcome.closedSegments.size)
        val (walking, running) = outcome.closedSegments.sortedBy { it.startMillis }
        assertEquals("walking", walking.activityType)
        assertEquals(Duration.ofMinutes(6), walking.duration)
        assertEquals("running", running.activityType)
        assertEquals(Duration.ofMinutes(6), running.duration)
        assertEquals(3L, outcome.consumedThroughId)
    }

    @Test
    fun `a redundant re-delivered ENTER for the already-open type keeps the original start`() {
        val events = listOf(
            enter(1, "walking", t0),
            enter(2, "walking", t0 + 3 * 60_000), // redundant re-delivery
            exit(3, "walking", t0 + 6 * 60_000),
        )
        val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(events, Instant.ofEpochMilli(t0 + 60 * 60_000))

        assertEquals(1, outcome.closedSegments.size)
        assertEquals(t0, outcome.closedSegments.single().startMillis)
        assertEquals(Duration.ofMinutes(6), outcome.closedSegments.single().duration)
    }

    @Test
    fun `a segment open longer than maxOpenAge is force-closed and flagged truncated`() {
        val events = listOf(enter(1, "still", t0))
        val now = Instant.ofEpochMilli(t0 + Duration.ofHours(13).toMillis())
        val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(events, now, maxOpenAge = Duration.ofHours(12))

        assertEquals(1, outcome.closedSegments.size)
        val segment = outcome.closedSegments.single()
        assertTrue(segment.truncated)
        assertEquals(SegmentConfidence.LOW, segment.confidence)
        assertEquals(now.toEpochMilli(), segment.endMillis)
        assertEquals(1L, outcome.consumedThroughId)
    }

    @Test
    fun `a genuinely still-open trailing segment is held back entirely`() {
        val events = listOf(enter(1, "walking", t0))
        val now = Instant.ofEpochMilli(t0 + Duration.ofMinutes(5).toMillis())
        val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(events, now, maxOpenAge = Duration.ofHours(12))

        assertTrue(outcome.closedSegments.isEmpty())
        assertNull(outcome.consumedThroughId)
    }

    @Test
    fun `a held-back trailing segment re-merges with a later drain's events`() {
        val first = listOf(enter(1, "walking", t0))
        val firstOutcome = ActivitySegmentsNormalizer.mergeIntoSegments(
            first,
            Instant.ofEpochMilli(t0 + Duration.ofMinutes(5).toMillis()),
        )
        assertNull(firstOutcome.consumedThroughId)

        // Next drain sees the SAME buffered ENTER (never deleted, since it
        // was excluded from consumedThroughId) plus a new EXIT.
        val second = listOf(enter(1, "walking", t0), exit(2, "walking", t0 + 20 * 60_000))
        val secondOutcome = ActivitySegmentsNormalizer.mergeIntoSegments(
            second,
            Instant.ofEpochMilli(t0 + Duration.ofMinutes(25).toMillis()),
        )
        assertEquals(1, secondOutcome.closedSegments.size)
        assertEquals(Duration.ofMinutes(20), secondOutcome.closedSegments.single().duration)
        assertEquals(2L, secondOutcome.consumedThroughId)
    }

    @Test
    fun `confidenceFor tiers by duration and truncation`() {
        assertEquals(SegmentConfidence.HIGH, ActivitySegmentsNormalizer.confidenceFor(Duration.ofMinutes(6), truncated = false))
        assertEquals(SegmentConfidence.MEDIUM, ActivitySegmentsNormalizer.confidenceFor(Duration.ofMinutes(1), truncated = false))
        assertEquals(SegmentConfidence.LOW, ActivitySegmentsNormalizer.confidenceFor(Duration.ofHours(1), truncated = true))
    }

    @Test
    fun `splitAtDayBoundaries returns the segment unchanged when it fits in one day`() {
        val segment = Segment("walking", t0 + 60_000, t0 + 120_000, SegmentConfidence.HIGH, truncated = false)
        val parts = ActivitySegmentsNormalizer.splitAtDayBoundaries(segment)
        assertEquals(listOf(segment), parts)
    }

    @Test
    fun `splitAtDayBoundaries clamps a midnight-spanning segment to each day's window`() {
        val dayEnd = t0 + Duration.ofHours(24).toMillis()
        val segment = Segment(
            "in_vehicle",
            startMillis = dayEnd - Duration.ofMinutes(10).toMillis(),
            endMillis = dayEnd + Duration.ofMinutes(10).toMillis(),
            confidence = SegmentConfidence.HIGH,
            truncated = false,
        )
        val parts = ActivitySegmentsNormalizer.splitAtDayBoundaries(segment)

        assertEquals(2, parts.size)
        assertEquals(segment.startMillis, parts[0].startMillis)
        assertEquals(dayEnd, parts[0].endMillis)
        assertEquals(dayEnd, parts[1].startMillis)
        assertEquals(segment.endMillis, parts[1].endMillis)
        assertEquals(ActivitySegmentsNormalizer.startDate(segment), ActivitySegmentsNormalizer.startDate(parts[0]))
        assertEquals(ActivitySegmentsNormalizer.startDate(segment).plusDays(1), ActivitySegmentsNormalizer.startDate(parts[1]))
    }

    @Test
    fun `buildDayDocument surfaces segment count and per-type totals`() {
        val date = ActivitySegmentsNormalizer.startDate(Segment("walking", t0, t0 + 60_000, SegmentConfidence.HIGH, false))
        val segments = listOf(
            Segment("walking", t0, t0 + 6 * 60_000, SegmentConfidence.HIGH, false),
            Segment("in_vehicle", t0 + 3600_000, t0 + 3600_000 + 20 * 60_000, SegmentConfidence.HIGH, false),
        )
        val doc = ActivitySegmentsNormalizer.buildDayDocument(segments, date, "android", "android-activity-segments:local")

        assertEquals("activity-segments:${date}", doc.externalId)
        assertEquals("activity-segments", doc.metadata.documentType)
        assertEquals(true, doc.metadata.rollingAggregate)
        assertTrue(doc.content.contains("2 segments"))
        assertTrue(doc.content.contains("in vehicle"))
        assertTrue(doc.content.contains("walking"))
    }

    @Test
    fun `buildDayDocument is deterministic (idempotent re-sync contract)`() {
        val date = ActivitySegmentsNormalizer.startDate(Segment("walking", t0, t0 + 60_000, SegmentConfidence.HIGH, false))
        val segments = listOf(Segment("walking", t0, t0 + 60_000, SegmentConfidence.HIGH, false))
        fun build() = ActivitySegmentsNormalizer.buildDayDocument(segments, date, "android", "android-activity-segments:local")
        assertEquals(build().contentHash, build().contentHash)
    }
}

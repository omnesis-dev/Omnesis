// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import dev.omnesis.android.transport.dto.DocumentInputDto
import dev.omnesis.android.transport.dto.DocumentMetadataDto
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One row read back from [ActivityTransitionBuffer]. Plain data — no GMS or
 * `android.*` import anywhere in this file, so [ActivitySegmentsNormalizer]
 * is fully unit-testable as plain JVM code (no Robolectric).
 */
data class BufferedTransitionEvent(
    val id: Long,
    val activityType: String,
    val transitionType: String,
    val elapsedRealtimeNanos: Long,
    val eventWallClockMillis: Long,
)

/** Merge confidence — see [ActivitySegmentsNormalizer.confidenceFor]'s doc comment. */
enum class SegmentConfidence { HIGH, MEDIUM, LOW }

/** One reconstructed movement segment. */
data class Segment(
    val activityType: String,
    val startMillis: Long,
    val endMillis: Long,
    val confidence: SegmentConfidence,
    /** True if this segment was force-closed by [ActivitySegmentsNormalizer.MIN_SEGMENT_DURATION]/[maxOpenAge], not a real EXIT event. */
    val truncated: Boolean,
) {
    val duration: Duration get() = Duration.ofMillis(maxOf(0L, endMillis - startMillis))
}

/** Result of one [ActivitySegmentsNormalizer.mergeIntoSegments] pass. */
data class MergeOutcome(
    val closedSegments: List<Segment>,
    /**
     * The highest buffer row id whose events are fully resolved — safe to
     * [ActivityTransitionBuffer.deleteUpTo]. Null when nothing was resolved
     * (every event belongs to the still-open trailing segment). Events
     * belonging to a below-floor segment are consumed even though they
     * produce no [Segment] in [closedSegments] — see [ActivitySegmentsNormalizer.MIN_SEGMENT_DURATION].
     */
    val consumedThroughId: Long?,
)

/**
 * Pure ENTER/EXIT transition-event merge logic — the core, fully
 * unit-testable half of the activity-segments feature. Everything here
 * operates on plain [BufferedTransitionEvent]s; [ActivityTransitionBuffer]
 * and [ActivitySegmentsSyncCoordinator] are the only callers that ever touch
 * GMS types or SQLite.
 */
object ActivitySegmentsNormalizer {

    /** Segments shorter than this are dropped from [MergeOutcome.closedSegments] but still consumed. */
    val MIN_SEGMENT_DURATION: Duration = Duration.ofSeconds(30)

    /** Maximum time an unmatched ENTER may remain unfinished before a drain closes it. */
    val MAX_OPEN_AGE: Duration = Duration.ofHours(12)

    /** A normally-closed segment (real ENTER+EXIT) at or above this duration is [SegmentConfidence.HIGH]. */
    private val HIGH_CONFIDENCE_DURATION: Duration = Duration.ofMinutes(5)

    /**
     * Merges a row-ordered event stream into closed [Segment]s.
     *
     * - An ENTER for a type with no currently-open segment opens one; an
     *   ENTER for a *different* type than the currently-open one implicitly
     *   closes the old segment at the new ENTER's time (the OS occasionally
     *   omits the EXIT when transitioning directly between two activity
     *   types) and opens the new one.
     * - An EXIT matching the open type closes it normally.
     * - A segment open longer than [maxOpenAge] as of [now] is force-closed
     *   at `now`, flagged [Segment.truncated], and given
     *   [SegmentConfidence.LOW] — this is a resolved closure (its events are
     *   consumed), not an unresolved one.
     * - The genuinely still-open trailing segment (the most recent ENTER,
     *   still under [maxOpenAge] as of [now]) is held back entirely: excluded
     *   from both [MergeOutcome.closedSegments] and
     *   [MergeOutcome.consumedThroughId] so it re-merges with whatever
     *   events land on top of it on the next drain.
     */
    fun mergeIntoSegments(
        events: List<BufferedTransitionEvent>,
        now: Instant,
        maxOpenAge: Duration = MAX_OPEN_AGE,
    ): MergeOutcome {
        if (events.isEmpty()) return MergeOutcome(emptyList(), null)
        val sorted = events.sortedBy { it.id }

        val closed = mutableListOf<Segment>()
        var open: BufferedTransitionEvent? = null
        // The high-water mark advances only to an event known to be fully
        // resolved — critically, NOT to a pending ENTER's own id, so the
        // still-open trailing segment (if any) is naturally excluded once the
        // loop ends without having closed it.
        var resolvedThroughId: Long? = null

        fun closeOpen(endMillis: Long, truncated: Boolean) {
            val start = open ?: return
            val duration = Duration.ofMillis(maxOf(0L, endMillis - start.eventWallClockMillis))
            if (duration >= MIN_SEGMENT_DURATION) {
                closed += Segment(
                    activityType = start.activityType,
                    startMillis = start.eventWallClockMillis,
                    endMillis = endMillis,
                    confidence = confidenceFor(duration, truncated),
                    truncated = truncated,
                )
            }
            open = null
        }

        for (event in sorted) {
            when (event.transitionType) {
                TRANSITION_ENTER -> {
                    val current = open
                    when {
                        current == null -> open = event
                        current.activityType == event.activityType ->
                            // A redundant re-delivery of the already-open type —
                            // keep the original start time, drop the duplicate.
                            Unit
                        else -> {
                            // A genuine transition directly into a new type,
                            // with no EXIT for the old one — close it here.
                            closeOpen(event.eventWallClockMillis, truncated = false)
                            resolvedThroughId = current.id
                            open = event
                        }
                    }
                }
                TRANSITION_EXIT -> {
                    val current = open
                    if (current != null && current.activityType == event.activityType) {
                        closeOpen(event.eventWallClockMillis, truncated = false)
                    }
                    // An EXIT with no matching open ENTER belongs to a segment
                    // that started before this buffer window — nothing to
                    // close, but the row is still fully handled.
                    resolvedThroughId = event.id
                }
                else -> resolvedThroughId = event.id
            }
        }

        val trailing = open
        if (trailing != null) {
            val age = Duration.ofMillis(maxOf(0L, now.toEpochMilli() - trailing.eventWallClockMillis))
            if (age >= maxOpenAge) {
                closeOpen(now.toEpochMilli(), truncated = true)
                resolvedThroughId = trailing.id
            }
            // else: genuinely still open — held back, resolvedThroughId stays
            // at whatever the last fully-resolved event was (never advances
            // into the still-open ENTER itself).
        }

        return MergeOutcome(closed.toList(), resolvedThroughId)
    }

    /**
     * Confidence is SYNTHESIZED here from segment shape (duration + how it
     * closed) — unlike iOS's `CMMotionActivity.confidence`, a genuine
     * OS-reported value, the Activity Transition Updates API carries no
     * numeric confidence field at all.
     */
    fun confidenceFor(duration: Duration, truncated: Boolean): SegmentConfidence = when {
        truncated -> SegmentConfidence.LOW
        duration >= HIGH_CONFIDENCE_DURATION -> SegmentConfidence.HIGH
        else -> SegmentConfidence.MEDIUM
    }

    /** UTC calendar date a segment's start instant falls on. */
    fun startDate(segment: Segment): LocalDate =
        Instant.ofEpochMilli(segment.startMillis).atZone(ZoneOffset.UTC).toLocalDate()

    /**
     * Split a segment spanning a UTC day boundary into one part per day it
     * touches, each clamped to that day's `[00:00, 24:00)` window. A segment
     * fully inside one day returns a single-element list (itself, unchanged).
     */
    fun splitAtDayBoundaries(segment: Segment): List<Segment> {
        val startDate = startDate(segment)
        val endDate = Instant.ofEpochMilli(segment.endMillis - 1).atZone(ZoneOffset.UTC).toLocalDate()
        if (startDate == endDate) return listOf(segment)

        val parts = mutableListOf<Segment>()
        var date = startDate
        while (!date.isAfter(endDate)) {
            val dayStart = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
            val dayEnd = date.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
            val partStart = maxOf(segment.startMillis, dayStart)
            val partEnd = minOf(segment.endMillis, dayEnd)
            if (partEnd > partStart) {
                parts += segment.copy(startMillis = partStart, endMillis = partEnd)
            }
            date = date.plusDays(1)
        }
        return parts
    }

    /** Stable identity shared by a segment's analytics row and its [ActivitySegmentsHistoryStore] record. */
    fun segmentId(segment: Segment): String = "${segment.activityType}:${segment.startMillis}"

    /** Build the `android_activity_segments` analytics row for one segment. */
    fun analyticsRow(segment: Segment): Map<String, JsonElement> = buildMap {
        put("id", JsonPrimitive(segmentId(segment)))
        put("activity_type", JsonPrimitive(segment.activityType))
        put("start_time", JsonPrimitive(Instant.ofEpochMilli(segment.startMillis).toString()))
        put("end_time", JsonPrimitive(Instant.ofEpochMilli(segment.endMillis).toString()))
        put("duration_seconds", JsonPrimitive(segment.duration.seconds))
        put("confidence", JsonPrimitive(segment.confidence.name.lowercase()))
        put("truncated", JsonPrimitive(segment.truncated))
        put("date", JsonPrimitive(DateTimeFormatter.ISO_LOCAL_DATE.format(startDate(segment))))
    }

    /**
     * Build the day-aggregate "Movement Timeline" document for [date] from
     * every segment on record for it (see [ActivitySegmentsHistoryStore] for
     * why this must be the FULL day, not just one drain's slice).
     */
    fun buildDayDocument(
        segments: List<Segment>,
        date: LocalDate,
        providerId: String,
        sourceId: String,
    ): DocumentInputDto {
        val dateStr = date.format(DateTimeFormatter.ISO_LOCAL_DATE)
        val sorted = segments.sortedBy { it.startMillis }
        val totalByType = sorted.groupBy { it.activityType }
            .mapValues { (_, segs) -> segs.sumOf { it.duration.seconds } }
            .toList()
            .sortedByDescending { (_, secs) -> secs }

        val lines = mutableListOf("# Movement Timeline — $dateStr", "")
        lines += "**Total:** ${sorted.size} segment${if (sorted.size == 1) "" else "s"}"
        lines += ""
        for ((activityType, seconds) in totalByType) {
            lines += "- ${activityType.replace('_', ' ')} — ${formatDuration(seconds)}"
        }

        val content = lines.joinToString("\n")
        return DocumentInputDto(
            providerId = providerId,
            sourceId = sourceId,
            externalId = "activity-segments:$dateStr",
            title = "Movement Timeline — $dateStr",
            content = content,
            contentHash = sha256Hex(content),
            metadata = DocumentMetadataDto(
                documentType = "activity-segments",
                // Rewritten every time a new segment resolves for this date —
                // route to the daily batch instead of waking the real-time agent.
                rollingAggregate = true,
                tags = emptyList(),
                extra = buildJsonObject {
                    put("date", dateStr)
                    put("segmentCount", sorted.size)
                    put(
                        "segments",
                        buildJsonArray {
                            sorted.forEach { segment ->
                                add(
                                    buildJsonObject {
                                        put("activityType", segment.activityType)
                                        put("startTime", Instant.ofEpochMilli(segment.startMillis).toString())
                                        put("endTime", Instant.ofEpochMilli(segment.endMillis).toString())
                                        put("durationSeconds", segment.duration.seconds)
                                        put("confidence", segment.confidence.name.lowercase())
                                        put("truncated", segment.truncated)
                                    },
                                )
                            }
                        },
                    )
                },
            ),
            sourceCreatedAt = "${dateStr}T00:00:00.000Z",
            sourceUpdatedAt = "${dateStr}T23:59:59.999Z",
        )
    }

    /** Format a duration in seconds as a short human string ("1h 20m", "45m", "12s"). */
    fun formatDuration(seconds: Long): String {
        val total = seconds.coerceAtLeast(0)
        val h = total / 3600
        val m = (total % 3600) / 60
        return when {
            h > 0 && m > 0 -> "${h}h ${m}m"
            h > 0 -> "${h}h"
            m > 0 -> "${m}m"
            else -> "${total}s"
        }
    }

    private fun sha256Hex(content: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(content.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    private const val TRANSITION_ENTER = "ENTER"
    private const val TRANSITION_EXIT = "EXIT"
}

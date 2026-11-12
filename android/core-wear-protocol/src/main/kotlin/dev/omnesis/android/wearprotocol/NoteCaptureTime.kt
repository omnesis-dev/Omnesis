// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * The instant something was captured and how the local calendar read it then.
 * Keeping the observed offset beside the zone freezes the wall clock across
 * travel, daylight-saving changes and late delivery. The iOS counterpart is
 * `NoteCaptureTime` in `WatchNote.swift`.
 */
data class NoteCaptureTime(
    val capturedAt: EpochMillis,
    val timeZoneId: String,
    val utcOffsetSeconds: Int,
) {
    /** [capturedAt] as an ISO-8601 UTC instant with milliseconds, the form the wire carries. */
    val isoString: String
        get() = ISO_MILLIS.format(Instant.ofEpochMilli(capturedAt))

    companion object {
        /** The widest offset from UTC accepted as real: eighteen hours either way. */
        val UTC_OFFSET_RANGE: IntRange = -64_800..64_800

        private val ISO_MILLIS: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

        /** The capture time for [now] as [zone] reads it. */
        fun at(now: EpochMillis, zone: ZoneId): NoteCaptureTime = NoteCaptureTime(
            capturedAt = now,
            timeZoneId = zone.id,
            utcOffsetSeconds = zone.rules.getOffset(Instant.ofEpochMilli(now)).totalSeconds,
        )

        /** The instant an ISO-8601 date-time names, with or without fractional seconds. */
        fun parseInstant(value: String): EpochMillis? = try {
            OffsetDateTime.parse(value).toInstant().toEpochMilli()
        } catch (_: DateTimeParseException) {
            null
        }

        /**
         * The capture time three wire fields describe, or null when the
         * instant is unreadable, the zone is blank or the offset is impossible.
         */
        fun fromWire(capturedAt: String, timeZoneId: String, utcOffsetSeconds: Int): NoteCaptureTime? {
            val instant = parseInstant(capturedAt) ?: return null
            if (timeZoneId.isEmpty() || utcOffsetSeconds !in UTC_OFFSET_RANGE) return null
            return NoteCaptureTime(instant, timeZoneId, utcOffsetSeconds)
        }
    }
}

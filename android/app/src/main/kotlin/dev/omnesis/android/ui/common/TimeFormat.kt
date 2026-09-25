// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Epoch-millis formatting for the watch surfaces (firing times, created/updated). */
object TimeFormat {

    private val DATE_TIME = DateTimeFormatter.ofPattern("d MMM yyyy, HH:mm")
    private val DAY = DateTimeFormatter.ofPattern("d MMM yyyy")
    private val CLOCK = DateTimeFormatter.ofPattern("HH:mm:ss")

    /** Absolute local date-time, e.g. "2 Jan 2026, 10:00". Blank for a non-positive epoch. */
    fun dateTime(epochMillis: Long): String {
        if (epochMillis <= 0) return ""
        return DATE_TIME.withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(epochMillis))
    }

    /**
     * The two halves of an instant, for a column of them down the side of a
     * story. A ledger read top to bottom wants the time on every line and the
     * date only where it changes: twelve steps inside one minute all carrying
     * the same date bury the one number that is moving.
     */
    fun day(epochMillis: Long): String {
        if (epochMillis <= 0) return ""
        return DAY.withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(epochMillis))
    }

    fun clock(epochMillis: Long): String {
        if (epochMillis <= 0) return ""
        return CLOCK.withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(epochMillis))
    }

    /** Coarse relative time, e.g. "just now", "5m ago", "3h ago", "2d ago", else the date. */
    fun relative(epochMillis: Long, now: Long = System.currentTimeMillis()): String {
        if (epochMillis <= 0) return "never"
        val diff = now - epochMillis
        if (diff < 0) return dateTime(epochMillis)
        val minutes = diff / 60_000
        val hours = minutes / 60
        val days = hours / 24
        return when {
            minutes < 1 -> "just now"
            minutes < 60 -> "${minutes}m ago"
            hours < 24 -> "${hours}h ago"
            days < 7 -> "${days}d ago"
            else -> dateTime(epochMillis)
        }
    }
}

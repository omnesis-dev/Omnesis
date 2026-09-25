// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * Display helpers shared by the Sources list, detail, and recent-documents screens.
 * Ported from the iOS `SourcesView` / `SourceRecentDocumentsView` formatters so the two
 * apps render identical relative times, humanized doc-type labels, and compact counts.
 */

/** Compact count: `>=1e6 → "1.2M"`, `>=1000 → "4.3k"`, else the raw integer. */
fun formatCount(n: Int): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
    n >= 1_000 -> "%.1fk".format(n / 1_000.0)
    else -> n.toString()
}

/**
 * Coarse relative time from an ISO-8601 instant string, e.g. "12s ago", "20m ago",
 * "1h ago", "3d ago". Stays relative up to 30 days, then falls back to the calendar
 * date. Returns null for a blank/unparseable value. Mirrors the iOS
 * `DocumentRowHelpers.timeAgo` thresholds.
 */
fun formatTimeAgo(iso: String?, now: Instant = Instant.now()): String? {
    val instant = parseInstant(iso) ?: return null
    val seconds = (now.toEpochMilli() - instant.toEpochMilli()) / 1000
    if (seconds < 0) return shortDate(instant)
    val minutes = seconds / 60
    val hours = minutes / 60
    val days = hours / 24
    return when {
        seconds < 60 -> "${seconds}s ago"
        minutes < 60 -> "${minutes}m ago"
        hours < 24 -> "${hours}h ago"
        days < 30 -> "${days}d ago"
        else -> shortDate(instant)
    }
}

/** Humanize a document-type token for the recent-row meta line, e.g. "email" → "Email". */
fun docTypeLabel(type: String?): String? {
    val t = type?.trim()?.takeIf { it.isNotBlank() } ?: return null
    return t.split('-', '_', ' ')
        .filter { it.isNotEmpty() }
        .joinToString(" ") { word -> word.replaceFirstChar { it.uppercaseChar() } }
}

private val SHORT_DATE = DateTimeFormatter.ofPattern("MMM d")

private fun shortDate(instant: Instant): String =
    SHORT_DATE.withZone(java.time.ZoneId.systemDefault()).format(instant)

private fun parseInstant(iso: String?): Instant? {
    val raw = iso?.trim()?.takeIf { it.isNotBlank() } ?: return null
    return runCatching { Instant.parse(raw) }.getOrNull()
        ?: runCatching {
            java.time.OffsetDateTime.parse(raw, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
        }.getOrNull()
        ?: try {
            java.time.LocalDateTime.parse(raw, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                .atZone(java.time.ZoneId.systemDefault()).toInstant()
        } catch (_: DateTimeParseException) {
            null
        }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmTheme
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// ---------------------------------------------------------------------------
// Section header — port of iOS Theme.swift `FlatSectionHeader`.
// ---------------------------------------------------------------------------

/**
 * `LABEL` ─────────────────────────── 12 (or trailing count). Uppercased, 12sp semibold
 * `textSecondary` with 0.5sp tracking, a 1px `border` rule filling the remaining width, and
 * an optional monospaced-digit trailing count in `textMuted`. Mirrors the iOS
 * `FlatSectionHeader`; the parent owns the horizontal/bottom padding (matching iOS).
 */
@Composable
fun PeopleSectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    trailing: String? = null,
) {
    val c = OmTheme.colors
    Row(
        modifier = modifier.padding(top = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = title.uppercase(),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
            color = c.textSecondary,
        )
        Box(Modifier.weight(1f).height(1.dp).background(c.border))
        if (trailing != null) {
            // iOS FlatSectionHeader trailing count: system-11 + monospacedDigit, textMuted.
            Text(
                text = trailing,
                fontSize = 11.sp,
                fontWeight = FontWeight.Normal,
                color = c.textMuted,
                style = TextStyle(fontFeatureSettings = "tnum"),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Avatar — port of iOS `PersonAvatar` (PeopleView.swift).
// ---------------------------------------------------------------------------

/**
 * iOS hash palette (`PersonAvatar.backgroundColor`). The lavender/violet/magenta swatches
 * seen in the snapshots. Hash is the unicode-scalar sum of the name `% 11`, so the same
 * name always lands on the same swatch and the colour matches the iOS app exactly.
 */
private val PEOPLE_AVATAR_PALETTE = listOf(
    0x5B8DEF, 0x7B4EE0, 0xD24FE0, 0xE0556E, 0xE08855, 0xD2A455,
    0x6DC257, 0x4DBFAE, 0x4F9FD2, 0x9B6DD2, 0xC25777,
).map { Color(0xFF000000L or it.toLong()) }

private fun peopleAvatarColor(name: String): Color {
    val hash = name.sumOf { it.code }
    val idx = ((hash % PEOPLE_AVATAR_PALETTE.size) + PEOPLE_AVATAR_PALETTE.size) % PEOPLE_AVATAR_PALETTE.size
    return PEOPLE_AVATAR_PALETTE[idx]
}

/** First+last initial, or first two chars — matches iOS `PersonAvatar.initials`. */
fun peopleInitials(name: String): String {
    val trimmed = name.trim()
    if (trimmed.isEmpty()) return "?"
    val parts = trimmed.split(Regex("\\s+"), limit = 2)
    return if (parts.size == 2) {
        "${parts[0].take(1)}${parts[1].take(1)}".uppercase()
    } else {
        trimmed.take(2).uppercase()
    }
}

/**
 * Initials avatar with the iOS hash-derived background, white semibold initials sized to
 * `size * 0.4`, and a 2px `success` ring when `isSelf`. Ported from the iOS `PersonAvatar`
 * so the colours/ring/scaling match across the two apps.
 */
@Composable
fun PeopleAvatar(
    name: String,
    modifier: Modifier = Modifier,
    isSelf: Boolean = false,
    size: Dp = 36.dp,
) {
    val c = OmTheme.colors
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(peopleAvatarColor(name))
            // Self-ring: iOS strokes a Circle of the SAME diameter as the fill, so the 2dp
            // stroke is centered on the edge (half spills outside, half overlaps the fill).
            // Modifier.border would inset the stroke entirely within bounds; drawWithContent
            // strokes a circle at the box-edge radius to reproduce the centered overlap.
            .then(
                if (isSelf) {
                    Modifier.drawWithContent {
                        drawContent()
                        val stroke = 2.dp.toPx()
                        drawCircle(
                            color = c.success,
                            radius = this.size.minDimension / 2f,
                            style = Stroke(width = stroke),
                        )
                    }
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = peopleInitials(name),
            color = Color.White,
            fontSize = (size.value * 0.4f).sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

// ---------------------------------------------------------------------------
// Source strip — port of iOS `PersonSourceStrip`.
// ---------------------------------------------------------------------------

/**
 * Up to [max] source glyphs at [size], deduped by full sourceId preserving first-occurrence
 * order. Icon models are pre-resolved by the caller via [iconFor] (keeps this composable
 * catalog-free, honouring source encapsulation). Mirrors the iOS `PersonSourceStrip`.
 */
@Composable
fun PersonSourceStrip(
    sourceIds: List<String>,
    iconFor: (String) -> SourceIconModel,
    modifier: Modifier = Modifier,
    max: Int = 5,
    size: Dp = 14.dp,
) {
    val visible = sourceIds.filter { it.isNotEmpty() }.distinct().take(max)
    if (visible.isEmpty()) return
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        visible.forEach { id -> SourceIcon(iconFor(id), size = size) }
    }
}

// ---------------------------------------------------------------------------
// Helpers ported from iOS DocumentRowHelpers.swift.
// ---------------------------------------------------------------------------

// Locale-aware short date (respects the device locale's order/separators) for the >1-month
// fallback, matching the iOS/portal date rendering rather than a hardcoded US `M/d/yy`.
private val SHORT_DATE: DateTimeFormatter =
    DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(Locale.getDefault())

/**
 * Port of iOS `formatTimeAgo`: "5s ago"/"3m ago"/"2h ago"/"4d ago" within a month, else a
 * short locale date. Accepts ISO-8601 (with or without fractional seconds); returns null when
 * [iso] is null and the input unchanged if it can't be parsed.
 */
fun personRelativeTime(iso: String?, now: Instant = Instant.now()): String? {
    if (iso == null) return null
    val instant = runCatching { Instant.parse(iso) }
        .recoverCatching { OffsetDateTime.parse(iso).toInstant() }
        .getOrNull() ?: return iso
    val seconds = now.epochSecond - instant.epochSecond
    if (seconds < 0) return "just now"
    return when {
        seconds < 60 -> "${seconds}s ago"
        seconds < 3600 -> "${seconds / 60}m ago"
        seconds < 86_400 -> "${seconds / 3600}h ago"
        seconds < 86_400L * 30 -> "${seconds / 86_400}d ago"
        else -> SHORT_DATE.withZone(ZoneId.systemDefault()).format(instant)
    }
}

/** Port of iOS `docTypeLabel` — maps a documentType to a user-facing label. */
fun personDocTypeLabel(type: String?): String? {
    if (type.isNullOrEmpty()) return null
    return when (type) {
        "email" -> "Email"
        "event" -> "Event"
        "conversation" -> "Conversation"
        "note" -> "Note"
        "page" -> "Page"
        "task" -> "Task"
        "reminder" -> "Reminder"
        "contact" -> "Contact"
        "bookmark" -> "Bookmark"
        "history" -> "History"
        "message" -> "Message"
        "activity" -> "Activity"
        "file", "document" -> "Document"
        else -> type.replaceFirstChar { it.uppercase() }
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Notices are the gateway's words about a source on one device. Status areas never
 * print them: one small control sits beside the device the notices belong to, showing
 * a glyph per severity present, and tapping it opens a sheet with the full text. These
 * components render what they are given verbatim — the wording is the gateway's.
 */

/** A notice's severity, least to most severe. */
enum class NoticeSeverity { INFO, WARNING, ERROR }

/** One notice as the UI shows it. [since] is the ISO 8601 time it was first observed. */
data class NoticeUi(
    val severity: NoticeSeverity,
    val title: String,
    val detail: String? = null,
    val steps: List<String> = emptyList(),
    val since: String? = null,
)

/** The notices of one device, labelled for a sheet that may list several devices. */
data class NoticeGroup(
    /** Display name of the device, or `null` when it is unknown. */
    val deviceLabel: String?,
    val notices: List<NoticeUi>,
)

/** The most severe severity among [notices], or `null` when there are none. */
fun worstSeverity(notices: List<NoticeUi>): NoticeSeverity? = notices.maxOfOrNull { it.severity }

/**
 * Spoken summary for a notice control, e.g. "2 warnings for studio-mac" or
 * "1 error and 1 warning for Gmail". Counts only the severities present, most severe first.
 */
fun noticesDescription(notices: List<NoticeUi>, target: String): String {
    val parts = NoticeSeverity.entries.reversed().mapNotNull { severity ->
        val n = notices.count { it.severity == severity }
        if (n == 0) null else "$n ${severityNoun(severity, n)}"
    }
    val counted = when (parts.size) {
        0 -> "No notices"
        1 -> parts[0]
        else -> parts.dropLast(1).joinToString(", ") + " and " + parts.last()
    }
    return "$counted for $target"
}

private fun severityNoun(severity: NoticeSeverity, n: Int): String {
    val noun = when (severity) {
        NoticeSeverity.ERROR -> "error"
        NoticeSeverity.WARNING -> "warning"
        NoticeSeverity.INFO -> "notice"
    }
    return if (n == 1) noun else noun + "s"
}

/**
 * "Since 3h ago" / "Since Jan 5" from a notice's ISO [since], or `null` when absent or
 * unparseable. Relative up to 30 days, then the calendar date.
 */
fun noticeSinceLabel(since: String?, now: Instant = Instant.now()): String? {
    val instant = since?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return null
    val seconds = (now.toEpochMilli() - instant.toEpochMilli()) / 1000
    val minutes = seconds / 60
    val hours = minutes / 60
    val days = hours / 24
    val relative = when {
        seconds < 0 || days >= 30 -> SINCE_DATE.withZone(ZoneId.systemDefault()).format(instant)
        seconds < 60 -> "${seconds}s ago"
        minutes < 60 -> "${minutes}m ago"
        hours < 24 -> "${hours}h ago"
        else -> "${days}d ago"
    }
    return "Since $relative"
}

private val SINCE_DATE = DateTimeFormatter.ofPattern("MMM d", Locale.US)

@Composable
private fun severityGlyph(severity: NoticeSeverity): Pair<ImageVector, Color> {
    val c = OmTheme.colors
    return when (severity) {
        NoticeSeverity.INFO -> Icons.Outlined.Info to c.textMuted
        NoticeSeverity.WARNING -> Icons.Filled.Warning to c.warning
        NoticeSeverity.ERROR -> Icons.Filled.Error to c.danger
    }
}

private val GLYPH = 16.dp
private val GLYPH_GAP = 2.dp
private val VISIBLE_HEIGHT = 24.dp

/**
 * Lays the node out at no more than [width] × [height] while its content keeps its own,
 * larger measured size, centred over that slot. The overflow still takes touches, so a
 * 48dp target fits in a 24dp line without making the line taller.
 */
private fun Modifier.occupyAtMost(width: Dp, height: Dp): Modifier = layout { measurable, constraints ->
    val placeable = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
    val w = minOf(placeable.width, width.roundToPx())
    val h = minOf(placeable.height, height.roundToPx())
    layout(w, h) { placeable.place((w - placeable.width) / 2, (h - placeable.height) / 2) }
}

/**
 * One button for a device's notices: a glyph per severity present (most severe first),
 * or only the worst when [worstOnly] is set for a row too dense for more. At least 48dp
 * to touch, but it lays out at glyph size so the line it sits in keeps its height.
 */
@Composable
fun NoticeButton(
    notices: List<NoticeUi>,
    target: String,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
    worstOnly: Boolean = false,
) {
    if (notices.isEmpty()) return
    val present = NoticeSeverity.entries.reversed().filter { s -> notices.any { it.severity == s } }
    val shown = if (worstOnly) present.take(1) else present
    val description = noticesDescription(notices, target)
    val visibleWidth = GLYPH * shown.size + GLYPH_GAP * (shown.size - 1) + 8.dp
    Box(
        modifier
            .occupyAtMost(visibleWidth, VISIBLE_HEIGHT)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = ripple(bounded = false, radius = 18.dp),
                role = Role.Button,
                onClickLabel = "Show details",
                onClick = onOpen,
            )
            .semantics { contentDescription = description }
            // After the click and semantics nodes, so the size it enforces is theirs:
            // the whole 48dp is the button, not only the glyphs.
            .minimumInteractiveComponentSize(),
        contentAlignment = Alignment.Center,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(GLYPH_GAP), verticalAlignment = Alignment.CenterVertically) {
            shown.forEach { severity ->
                val (icon, tint) = severityGlyph(severity)
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(GLYPH))
            }
        }
    }
}

/**
 * A [NoticeButton] that opens its own sheet — for a status line that has no screen-level
 * state to hold which sheet is open.
 */
@Composable
fun NoticeControl(notices: List<NoticeUi>, target: String, modifier: Modifier = Modifier) {
    if (notices.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    NoticeButton(notices, target, onOpen = { open = true }, modifier = modifier)
    if (open) {
        NoticeSheet(title = target, groups = listOf(NoticeGroup(null, notices)), onDismiss = { open = false })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoticeSheet(
    title: String,
    groups: List<NoticeGroup>,
    onDismiss: () -> Unit,
    deviceHeadings: Boolean = groups.size > 1,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        NoticeSheetBody(title, groups, deviceHeadings = deviceHeadings)
    }
}

/**
 * The sheet's content: [title], then each group's notices under its device heading when
 * [deviceHeadings] is set. A sheet opened from one device's control names the device in
 * its title instead.
 */
@Composable
fun NoticeSheetBody(
    title: String,
    groups: List<NoticeGroup>,
    modifier: Modifier = Modifier,
    deviceHeadings: Boolean = groups.size > 1,
) {
    val c = OmTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.xl),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        groups.forEachIndexed { gi, group ->
            if (gi > 0) HorizontalDivider(color = c.borderLight)
            val heading = group.deviceLabel?.takeIf { deviceHeadings }
            if (heading != null) {
                Text(
                    heading.uppercase(),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.5.sp,
                    color = c.textSecondary,
                )
            }
            group.notices.forEach { NoticeItem(it) }
        }
    }
}

@Composable
private fun NoticeItem(notice: NoticeUi) {
    val c = OmTheme.colors
    val (icon, tint) = severityGlyph(notice.severity)
    Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm), verticalAlignment = Alignment.Top) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.padding(top = 2.dp).size(GLYPH))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(notice.title, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
            notice.detail?.takeIf(String::isNotBlank)?.let {
                Text(it, fontSize = 13.sp, color = c.textSecondary)
            }
            val steps = notice.steps.filter(String::isNotBlank)
            if (steps.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    steps.forEachIndexed { i, step ->
                        Row {
                            Text("${i + 1}.", fontSize = 13.sp, color = c.textSecondary, modifier = Modifier.width(20.dp))
                            Text(step, fontSize = 13.sp, color = c.textPrimary)
                        }
                    }
                }
            }
            noticeSinceLabel(notice.since)?.let {
                Text(it, fontSize = 11.sp, color = c.textMuted)
            }
        }
    }
}

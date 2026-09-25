// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.notes

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.notes.PendingNote
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Local-only diagnostics for captures that have not reached the gateway. This
 * is deliberately not a notes-history surface: it never fetches synced notes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PendingNotesSheet(
    notes: List<PendingNote>,
    now: Instant,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    onDiscard: (Long) -> Unit,
) {
    val colors = OmTheme.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = colors.bgPrimary,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .padding(horizontal = OmSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss) {
                    Text("Close")
                }
                Text(
                    "Unsent notes",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                TextButton(onClick = onRetry) {
                    Text("Retry")
                }
            }
            HorizontalDivider(color = colors.borderLight)
            Text(
                "These notes are stored securely on this phone until the gateway accepts them.",
                style = MaterialTheme.typography.bodySmall,
                color = colors.textSecondary,
                modifier = Modifier.padding(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
            )
            LazyColumn(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 480.dp)
                    .padding(horizontal = OmSpacing.lg),
            ) {
                items(notes, key = { it.id }) { note ->
                    PendingNoteDiagnosticRow(note, now = now, onDiscard = { onDiscard(note.id) })
                    if (note != notes.last()) {
                        HorizontalDivider(color = colors.borderLight)
                    }
                }
            }
        }
    }
}

@Composable
private fun PendingNoteDiagnosticRow(
    note: PendingNote,
    now: Instant,
    onDiscard: () -> Unit,
) {
    val colors = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = OmSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                note.text,
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textPrimary,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                captureSummary(note, now),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textMuted,
            )
            note.lastFailure?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Medium,
                    color = colors.warning,
                )
            }
            note.lastAttemptAt?.let {
                Text(
                    "Last attempt ${relativeAge(it, now)}${retrySuffix(note.retryCount)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textMuted,
                )
            }
        }
        Spacer(Modifier.width(OmSpacing.sm))
        IconButton(onClick = onDiscard, modifier = Modifier.size(48.dp)) {
            Icon(
                Icons.Outlined.DeleteOutline,
                contentDescription = "Discard queued note",
                tint = colors.textMuted,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

private val CAPTURE_TIME = DateTimeFormatter.ofPattern("d MMM, HH:mm")

internal fun captureSummary(note: PendingNote, now: Instant): String {
    val captured = runCatching { Instant.parse(note.capturedAt) }.getOrNull()
    val whenLabel = captured?.let {
        "${CAPTURE_TIME.withZone(ZoneId.systemDefault()).format(it)} (${durationLabel(Duration.between(it, now))} ago)"
    } ?: "Capture time unavailable"
    return "$whenLabel · ${surfaceLabel(note.surface)}"
}

private fun relativeAge(value: String, now: Instant): String =
    runCatching { "${durationLabel(Duration.between(Instant.parse(value), now))} ago" }
        .getOrDefault("at an unknown time")

private fun retrySuffix(retryCount: Int): String = when (retryCount) {
    0 -> ""
    1 -> " · 1 failed retry"
    else -> " · $retryCount failed retries"
}

private fun durationLabel(duration: Duration): String {
    val safe = if (duration.isNegative) Duration.ZERO else duration
    return when {
        safe.toDays() > 0 -> "${safe.toDays()}d"
        safe.toHours() > 0 -> "${safe.toHours()}h"
        safe.toMinutes() > 0 -> "${safe.toMinutes()}m"
        else -> "less than a minute"
    }
}

private fun surfaceLabel(surface: String): String = when (surface) {
    "android-tile" -> "Quick Settings"
    "android-shortcut" -> "App shortcut"
    "android-app" -> "Android app"
    else -> surface.ifBlank { "Unknown surface" }
}

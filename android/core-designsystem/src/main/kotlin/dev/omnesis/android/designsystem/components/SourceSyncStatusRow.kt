// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme
import java.time.Duration
import java.time.Instant

enum class SyncStatusTone { SUCCESS, WARNING, ERROR, NEUTRAL }

data class SyncStatusSummary(val text: String, val tone: SyncStatusTone)

/**
 * One-line summary of a source's sync status for an on-phone settings row.
 *
 * It never carries warning or error text: what went wrong is the gateway's notices,
 * shown by [AuthoritativeSyncStatus] as a control beside this line. For the states
 * notices cover, the line keeps saying when the source last synced.
 */
fun sourceSyncStatusSummary(
    state: String,
    progressMessage: String? = null,
    lastSyncAt: String? = null,
    now: Instant = Instant.now(),
): SyncStatusSummary = when (state) {
    "syncing" -> SyncStatusSummary(
        progressMessage?.takeIf(String::isNotBlank) ?: "Syncing…",
        SyncStatusTone.NEUTRAL,
    )
    "synced", "completed" -> SyncStatusSummary(lastSuccessfulUpdate(lastSyncAt, now), SyncStatusTone.SUCCESS)
    "error", "needs-auth", "rate-limited", "stale", "auth-expiring" -> SyncStatusSummary(
        if (lastSyncAt == null) "Not synced yet" else lastSuccessfulUpdate(lastSyncAt, now),
        SyncStatusTone.NEUTRAL,
    )
    "permission-degraded" -> SyncStatusSummary("Permissions need attention", SyncStatusTone.WARNING)
    "background-access-missing" -> SyncStatusSummary("Background access needs attention", SyncStatusTone.WARNING)
    "unavailable" -> SyncStatusSummary("Source unavailable", SyncStatusTone.WARNING)
    "paused", "disabled" -> SyncStatusSummary("Sync paused", SyncStatusTone.WARNING)
    else -> SyncStatusSummary("Ready to sync", SyncStatusTone.NEUTRAL)
}

private fun lastSuccessfulUpdate(lastSyncAt: String?, now: Instant): String {
    val syncedAt = lastSyncAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        ?: return "Synced"
    val age = Duration.between(syncedAt, now).coerceAtLeast(Duration.ZERO)
    val relative = when {
        age.seconds < 60 -> "just now"
        age.toMinutes() < 60 -> "${age.toMinutes()}m ago"
        age.toHours() < 24 -> "${age.toHours()}h ago"
        else -> "${age.toDays()}d ago"
    }
    return "Last synced $relative"
}

/**
 * The status line plus, when the gateway has [notices] for this device, the control
 * that reveals them — the line itself never spells out a warning or an error.
 */
@Composable
fun RowScope.AuthoritativeSyncStatus(
    summary: SyncStatusSummary,
    notices: List<NoticeUi> = emptyList(),
    noticeTarget: String = "this phone",
) {
    val colors = OmTheme.colors
    val (icon, color) = when (summary.tone) {
        SyncStatusTone.SUCCESS -> Icons.Outlined.CheckCircle to colors.success
        SyncStatusTone.WARNING -> Icons.Outlined.WarningAmber to colors.warning
        SyncStatusTone.ERROR -> Icons.Outlined.ErrorOutline to colors.danger
        SyncStatusTone.NEUTRAL -> Icons.Outlined.Schedule to colors.textSecondary
    }
    Icon(icon, null, tint = color, modifier = Modifier.size(18.dp))
    Text(
        summary.text,
        style = MaterialTheme.typography.bodyMedium,
        color = color,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
    NoticeControl(notices, target = noticeTarget)
}

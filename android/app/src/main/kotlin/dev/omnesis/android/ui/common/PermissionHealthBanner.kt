// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.PermissionHealthEntry
import dev.omnesis.android.transport.PermissionRepairAction

/** Source-agnostic remediation list; labels and actions come from source-owned reporters. */
@Composable
fun PermissionHealthBanner(
    entries: List<PermissionHealthEntry>,
    labelForSourceId: (String) -> String,
    onRepair: (String, String) -> Unit,
) {
    val actionable = entries.flatMap { entry -> entry.actionable.map { entry.sourceId to it } }
    if (actionable.isEmpty()) return
    OmnesisCard(padding = OmSpacing.lg) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Icon(Icons.Outlined.WarningAmber, null, tint = OmTheme.colors.warning)
            Text("Permissions need attention", fontWeight = FontWeight.SemiBold, color = OmTheme.colors.textPrimary)
        }
        actionable.forEach { (sourceId, capability) ->
            val repairModifier = if (capability.repairAction == PermissionRepairAction.NONE) {
                Modifier
            } else {
                Modifier.clickable { onRepair(sourceId, capability.id) }
            }
            Column(
                repairModifier.fillMaxWidth().padding(top = OmSpacing.md),
            ) {
                Text("${labelForSourceId(sourceId)} · ${capability.label}", style = MaterialTheme.typography.bodyMedium, color = OmTheme.colors.accent)
                capability.impact?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textSecondary) }
                capability.remediation?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textSecondary) }
            }
        }
    }
}

/** Bounded app-wide summary; the complete, per-capability list lives in Settings. */
@Composable
fun GlobalHealthWarningBanner(
    notificationNeedsAttention: Boolean,
    permissionIssueCount: Int,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
    /** Dismisses the notification part for this disabled epoch; null hides the cross. */
    onDismissNotification: (() -> Unit)? = null,
) {
    if (!notificationNeedsAttention && permissionIssueCount == 0) return
    OmnesisCard(
        modifier = modifier.fillMaxWidth().clickable(onClick = onOpenSettings),
        padding = OmSpacing.md,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Icon(Icons.Outlined.WarningAmber, null, tint = OmTheme.colors.warning)
            Column(Modifier.weight(1f)) {
                Text("Omnesis needs attention", fontWeight = FontWeight.SemiBold, color = OmTheme.colors.textPrimary)
                val detail = when {
                    notificationNeedsAttention && permissionIssueCount > 0 ->
                        "Notifications and $permissionIssueCount data permission ${if (permissionIssueCount == 1) "issue" else "issues"} need review."
                    notificationNeedsAttention -> "Notifications need review."
                    else -> "$permissionIssueCount data permission ${if (permissionIssueCount == 1) "issue needs" else "issues need"} review."
                }
                Text(detail, style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textSecondary)
            }
            if (notificationNeedsAttention && onDismissNotification != null) {
                androidx.compose.material3.IconButton(onClick = onDismissNotification) {
                    Icon(
                        Icons.Outlined.Close,
                        contentDescription = "Dismiss notifications warning",
                        tint = OmTheme.colors.textSecondary,
                    )
                }
            }
        }
    }
}

/** App-wide warning for the permission that delivers every proactive repair alert. */
@Composable
fun NotificationHealthBanner(
    status: String,
    /** Asks Android for the permission; offered only while it has never been answered. */
    onTurnOn: (() -> Unit)? = null,
    onRepair: () -> Unit,
) {
    if (status == "healthy") return
    val turnOn = onTurnOn.takeIf { status == "not-determined" }
    OmnesisCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = turnOn ?: onRepair),
        padding = OmSpacing.lg,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Icon(Icons.Outlined.WarningAmber, null, tint = OmTheme.colors.warning)
            Text(
                if (status == "not-determined") "Notifications aren't set up" else "Notifications are disabled",
                fontWeight = FontWeight.SemiBold,
                color = OmTheme.colors.textPrimary,
            )
        }
        Text(
            if (turnOn != null) {
                "Omnesis can tell you when a slow answer is ready, when something needs your approval, " +
                    "and when a source stops syncing."
            } else {
                "Open Android notification settings so Omnesis can alert you when data needs attention."
            },
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.textSecondary,
            modifier = Modifier.padding(top = OmSpacing.sm),
        )
        if (turnOn != null) {
            Text(
                "Turn on notifications",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = OmTheme.colors.accent,
                modifier = Modifier.padding(top = OmSpacing.md),
            )
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.SetupUnit
import dev.omnesis.android.transport.dto.SourceSyncStatus
import java.text.NumberFormat
import java.util.Locale

/** The plain-language headline for this device's sync status. */
fun setupStatusHeadline(status: SourceSyncStatus?): String = when (status?.state) {
    "syncing" -> "Syncing…"
    "error" -> "Last sync failed"
    "needs-auth" -> "Needs authorization"
    "auth-expiring" -> "Authorization expiring"
    "rate-limited" -> "Temporarily limited"
    "stale" -> "Not receiving new data"
    "paused", "disabled" -> "Sync paused"
    "unavailable" -> "Unavailable"
    "permission-degraded", "background-access-missing" -> "Needs attention"
    "synced", "completed" -> "Up to date"
    else -> if (status?.lastSyncAt == null) "Not synced yet" else "Up to date"
}

/** Which mark the status earns: a spinner while syncing, a check once up to date, a warning when it needs the user. */
fun setupStatusKind(status: SourceSyncStatus?): SetupStatusKind = when (status?.state) {
    "syncing" -> SetupStatusKind.SYNCING
    "synced", "completed" -> SetupStatusKind.UP_TO_DATE
    "error", "needs-auth", "auth-expiring", "rate-limited", "stale", "paused", "disabled", "unavailable",
    "permission-degraded", "background-access-missing",
    -> SetupStatusKind.ATTENTION
    else -> if (status?.lastSyncAt == null) SetupStatusKind.NOT_SYNCED else SetupStatusKind.UP_TO_DATE
}

/**
 * This device's sync line for a source: while a run reports a count,
 * "{count} {unit} processed" with its fill; otherwise the headline.
 */
fun setupStatusLine(status: SourceSyncStatus?, unit: SetupUnit?): SetupStatusLine {
    val kind = setupStatusKind(status)
    val progress = status?.progress
    // A run that has processed nothing yet reads as its headline, not "0 … processed".
    val processed = progress?.processed?.takeIf { kind == SetupStatusKind.SYNCING && it > 0 }
    val count = processed?.let { n ->
        when {
            unit != null -> "${unit.count(n.toLong())} processed"
            status.unitName != null -> "${NumberFormat.getIntegerInstance(Locale.US).format(n)} ${status.unitName} processed"
            else -> "${NumberFormat.getIntegerInstance(Locale.US).format(n)} processed"
        }
    }
    val fraction = if (kind == SetupStatusKind.SYNCING) {
        progress?.percentComplete?.let { (it / 100.0).toFloat() }
            ?: progress?.total?.takeIf { it > 0 }?.let { total -> progress.processed?.let { it.toFloat() / total } }
    } else {
        null
    }
    return SetupStatusLine(count ?: setupStatusHeadline(status), kind, fraction?.coerceIn(0f, 1f))
}

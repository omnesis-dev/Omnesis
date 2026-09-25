// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.SyncProblem
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.PushHealth
import dev.omnesis.android.transport.PushHealthSnapshot
import dev.omnesis.android.transport.RetryOutcome
import dev.omnesis.android.transport.SetAside
import dev.omnesis.android.transport.SkippedPush

/**
 * Surfaces the ways this phone can stop delivering data while every other
 * indicator still reads "synced".
 *
 * A sync answers "did the source run?", which is not the same question as "did
 * the data arrive?". A pass reads from Android, pushes, and advances a cursor —
 * and the push is the part that fails on its own. When it does, the source
 * keeps reporting completed syncs and the cursor keeps moving, so the phone
 * looks healthy while the gateway silently goes stale.
 *
 * Three failures get their own row because the remedies differ:
 *
 *  - **Blocked** — the gateway refused this device's authority to send for a
 *    source. Nothing on the phone fixes it; it needs a grant on the gateway,
 *    or a fresh pairing.
 *  - **Backlog** — a source that owns a durable queue has one, and its oldest
 *    row keeps aging. Retry is the right action.
 *  - **Undelivered** — a source stopped re-sending something. Nothing is
 *    pending any more, so there is nothing to retry; what is left is to say
 *    the data didn't make it, and to let the user clear the notice.
 *
 * A merely non-empty queue is *not* a problem — that is the normal state
 * mid-sync — so the backlog row is gated on the oldest row's age, never on the
 * count.
 *
 * Every source name and unit noun is resolved by the caller through the source
 * catalog: this view never spells one out.
 */
@Composable
fun PushHealthBanner(
    snapshot: PushHealthSnapshot,
    retryPhase: PushHealth.RetryPhase,
    labelForSourceId: (String) -> String,
    unitLabelForSourceId: (String, Int) -> String,
    onRetry: () -> Unit,
    onDiscardUndelivered: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Nothing worth reporting renders nothing at all — no empty row, and no
    // padding from a modifier the caller supplied for the populated case.
    if (PushHealth.isHealthy(snapshot)) return
    var confirmingDiscard by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        if (snapshot.blockedSourceIds.isNotEmpty()) {
            BlockedRow(snapshot.blockedSourceIds, labelForSourceId)
        }
        if (PushHealth.isBacklogged(snapshot)) {
            BacklogRow(
                snapshot = snapshot,
                retryPhase = retryPhase,
                labelForSourceId = labelForSourceId,
                unitLabelForSourceId = unitLabelForSourceId,
                onRetry = onRetry,
            )
        }
        if (PushHealth.hasUndelivered(snapshot)) {
            UndeliveredRow(
                setAside = snapshot.setAside,
                skipped = snapshot.skipped,
                labelForSourceId = labelForSourceId,
                unitLabelForSourceId = unitLabelForSourceId,
                onDiscard = { confirmingDiscard = true },
            )
        }
    }
    if (confirmingDiscard) {
        DiscardUndeliveredDialog(
            setAside = snapshot.setAside,
            skippedCount = snapshot.skipped.size,
            unitLabelForSourceId = unitLabelForSourceId,
            onConfirm = {
                confirmingDiscard = false
                onDiscardUndelivered()
            },
            onDismiss = { confirmingDiscard = false },
        )
    }
}

@Composable
private fun BlockedRow(blockedSourceIds: List<String>, labelForSourceId: (String) -> String) {
    val c = OmTheme.colors
    val one = blockedSourceIds.size == 1
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
        RowTitle("Omnesis isn't accepting some data", Icons.Outlined.Lock, c.danger)
        Text(
            joinNames(blockedSourceIds.map(labelForSourceId)),
            fontSize = 12.sp,
            lineHeight = 17.sp,
            fontWeight = FontWeight.Medium,
            color = c.textPrimary,
        )
        Text(
            "This phone isn't allowed to send ${if (one) "it" else "them"}. Granting that on Omnesis — or " +
                "pairing this phone again — is the fix; retrying isn't. Nothing queued here is thrown away " +
                "meanwhile, but Android expires what ${if (one) "this source reads" else "these sources read"} " +
                "on its own schedule.",
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = c.textMuted,
        )
    }
}

@Composable
private fun BacklogRow(
    snapshot: PushHealthSnapshot,
    retryPhase: PushHealth.RetryPhase,
    labelForSourceId: (String) -> String,
    unitLabelForSourceId: (String, Int) -> String,
    onRetry: () -> Unit,
) {
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
        RowTitle("Data isn't reaching Omnesis", Icons.Outlined.SyncProblem, c.warning)
        snapshot.queued.forEach { queue ->
            val waited = queue.oldestAgeMillis?.let { ", oldest waiting ${PushHealth.waitedLabel(it)}" }.orEmpty()
            Text(
                "${labelForSourceId(queue.sourceId)} — ${unitLabelForSourceId(queue.sourceId, queue.count)}$waited",
                fontSize = 12.sp,
                lineHeight = 17.sp,
                fontWeight = FontWeight.Medium,
                color = c.textPrimary,
            )
        }
        Text(
            "Omnesis hasn't taken it. It stays on this phone until it does.",
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = c.textMuted,
        )
        RetryControl(retryPhase, onRetry)
        if (retryPhase is PushHealth.RetryPhase.Reported) {
            RetryStatusLine(retryPhase.outcome)
        }
    }
}

@Composable
private fun RetryControl(retryPhase: PushHealth.RetryPhase, onRetry: () -> Unit) {
    val c = OmTheme.colors
    if (retryPhase is PushHealth.RetryPhase.Running) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(top = 4.dp),
        ) {
            OmSpinner(modifier = Modifier.size(14.dp), color = c.accent, strokeWidth = 2.dp)
            Text("Syncing…", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.textMuted)
        }
    } else {
        TextButton(onClick = onRetry, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
            Text(
                if (retryPhase is PushHealth.RetryPhase.Idle) "Retry now" else "Try again",
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.accent,
            )
        }
    }
}

/**
 * The one line a finished retry leaves behind. Its own composable so a golden
 * can render every outcome side by side, which the banner itself only ever
 * shows one at a time.
 */
@Composable
fun RetryStatusLine(outcome: RetryOutcome) {
    val c = OmTheme.colors
    Text(
        PushHealth.retryMessage(outcome),
        fontSize = 12.sp,
        lineHeight = 17.sp,
        color = if (PushHealth.retryIsTrouble(outcome)) c.warning else c.textMuted,
    )
}

@Composable
private fun UndeliveredRow(
    setAside: List<SetAside>,
    skipped: List<SkippedPush>,
    labelForSourceId: (String) -> String,
    unitLabelForSourceId: (String, Int) -> String,
    onDiscard: () -> Unit,
) {
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
        RowTitle("Some data never reached Omnesis", Icons.Outlined.Inbox, c.textPrimary)
        if (setAside.isNotEmpty()) {
            setAside.forEach { held ->
                Text(
                    "${labelForSourceId(held.sourceId)} — ${unitLabelForSourceId(held.sourceId, held.count)} set aside",
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    fontWeight = FontWeight.Medium,
                    color = c.textPrimary,
                )
            }
            Text(
                "These were refused often enough that this phone stopped re-sending them, and keeps them " +
                    "as evidence instead. It holds a bounded number, so the oldest are dropped as new ones arrive.",
                fontSize = 12.sp,
                lineHeight = 17.sp,
                color = c.textMuted,
            )
        }
        if (skipped.isNotEmpty()) {
            skipped.forEach { marker ->
                Text(
                    "${labelForSourceId(marker.sourceId)} — ${marker.unit}",
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    fontWeight = FontWeight.Medium,
                    color = c.textPrimary,
                )
            }
            Text(
                "Syncing moved past this so everything behind it could keep flowing. Omnesis read it from " +
                    "Android rather than storing a copy here, so it only arrives if the source is removed and " +
                    "added again in Omnesis — and only as far back as Android still keeps it.",
                fontSize = 12.sp,
                lineHeight = 17.sp,
                color = c.textMuted,
            )
        }
        TextButton(onClick = onDiscard, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
            Text("Discard", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.danger)
        }
    }
}

/**
 * Confirms a discard, because it cannot be undone: the retained rows are
 * deleted outright, and dropping the markers removes the only thing on this
 * phone that says a re-sync would be worth running.
 */
@Composable
fun DiscardUndeliveredDialog(
    setAside: List<SetAside>,
    skippedCount: Int,
    unitLabelForSourceId: (String, Int) -> String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = OmTheme.colors
    val held = setAside.joinToString(" and ") { unitLabelForSourceId(it.sourceId, it.count) }
    val message = buildString {
        if (setAside.isNotEmpty()) {
            append("$held will be deleted from this phone")
            if (skippedCount > 0) append(", and the record of what syncing skipped will be cleared")
            append(". ")
        } else {
            append("The record of what syncing skipped will be cleared. ")
        }
        append("This can't be undone.")
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.bgSecondary,
        title = { Text("Discard undelivered data?", color = c.textPrimary) },
        text = { Text(message, color = c.textSecondary, fontSize = 13.sp, lineHeight = 19.sp) },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Discard", color = c.danger) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Keep", color = c.accent) } },
    )
}

@Composable
private fun RowTitle(text: String, icon: ImageVector, tint: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            icon,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(14.dp).clearAndSetSemantics {},
        )
        Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = tint)
    }
}

/** "A", "A and B", "A, B and C" — the same shape a person would write. */
internal fun joinNames(names: List<String>): String = when (names.size) {
    0 -> ""
    1 -> names[0]
    else -> names.dropLast(1).joinToString(", ") + " and " + names.last()
}

// MARK: - Previews

private const val HOUR_MILLIS = 60L * 60 * 1000

private val previewLabels: (String) -> String = { id ->
    when (id) {
        "activity-segments:local" -> "Activity Segments"
        "photos:local" -> "Photos"
        else -> "Health Connect"
    }
}

private val previewUnits: (String, Int) -> String = { id, count ->
    val plural = if (id == "photos:local") "photos" else "events"
    val noun = if (count == 1) plural.removeSuffix("s") else plural
    "$count $noun"
}

@Composable
private fun PreviewBanner(
    snapshot: PushHealthSnapshot,
    retryPhase: PushHealth.RetryPhase = PushHealth.RetryPhase.Idle,
    dark: Boolean = true,
) {
    OmnesisTheme(darkTheme = dark) {
        PushHealthBanner(
            snapshot = snapshot,
            retryPhase = retryPhase,
            labelForSourceId = previewLabels,
            unitLabelForSourceId = previewUnits,
            onRetry = {},
            onDiscardUndelivered = {},
            modifier = Modifier.padding(OmSpacing.lg),
        )
    }
}

@Preview(name = "Push health · blocked · dark")
@Composable
private fun PushHealthBlockedPreview() {
    PreviewBanner(PushHealthSnapshot(blockedSourceIds = listOf("photos:local")))
}

@Preview(name = "Push health · backlog · dark")
@Composable
private fun PushHealthBacklogPreview() {
    PreviewBanner(
        PushHealthSnapshot(
            queued = listOf(
                dev.omnesis.android.transport.QueuedBacklog("activity-segments:local", 412, 72 * HOUR_MILLIS),
            ),
        ),
    )
}

@Preview(name = "Push health · undelivered · dark")
@Composable
private fun PushHealthUndeliveredPreview() {
    PreviewBanner(
        PushHealthSnapshot(
            setAside = listOf(SetAside("activity-segments:local", 128)),
            skipped = listOf(
                SkippedPush(
                    sourceId = "photos:local",
                    unit = "42 photos in the backfill pass, added after 2 Jan 2026, 09:00",
                    refusals = 5,
                    atMillis = 0,
                ),
            ),
        ),
    )
}

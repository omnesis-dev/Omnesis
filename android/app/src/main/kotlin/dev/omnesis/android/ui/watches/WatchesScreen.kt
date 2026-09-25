// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.watches

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.EmptyView
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.WatchFiringDto
import dev.omnesis.android.transport.dto.WatchRecordDto
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.TimeFormat
import java.time.Instant

/**
 * What this phone's Omnesis is watching for, and what it has fired.
 *
 * The runtime's own surface, which is not the same thing as the records next
 * door under Privacy: a record is the agreement with an integration — who
 * asked, what they were told, what they may be sent. A watch is the thing that
 * actually runs. An operator asking "is it working?" is asking about this one.
 *
 * Read-only. A watch is created by asking for one in conversation or from the
 * CLI, and removed the same way; a phone that could delete one from a list is
 * the easiest place to do it by accident.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WatchesScreen(
    onOpenMenu: () -> Unit,
    onOpenWatch: (String) -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: WatchesViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    Scaffold(
        containerColor = OmTheme.colors.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Watches") },
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Outlined.Menu, contentDescription = "Menu")
                    }
                },
            )
        },
    ) { padding ->
        WatchesContent(
            state = state,
            onOpenWatch = onOpenWatch,
            onRetry = vm::reload,
            onOpenSettings = onOpenSettings,
            modifier = Modifier.padding(padding),
        )
    }
}

/**
 * The list, taking its data as arguments.
 *
 * Split from the screen so a preview or a screenshot test can render every
 * state — loading, failed, empty, populated — without a session, a gateway or
 * a paired device.
 *
 * It paints its own background rather than inheriting the scaffold's. Those
 * callers have no scaffold, so text coloured for the current theme would land
 * on the platform's default white surface — which in dark mode is light grey
 * on white, i.e. a screenshot that shows nothing wrong while showing nothing.
 */
@Composable
fun WatchesContent(
    state: WatchesUiState,
    onOpenWatch: (String) -> Unit,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val surface = modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)
    // Hoisted out of the list below: a `LazyListScope` lambda is not composable,
    // and the sort is a property of the whole list rather than of any row.
    val ordered = remember(state.watches) { orderedWatches(state.watches) }
    when {
        state.loading -> LoadingView(surface)
        state.error != null -> GatewayErrorView(
            context = "watches",
            error = state.error,
            onRetry = onRetry,
            onOpenSettings = onOpenSettings,
            modifier = surface,
        )
        state.watches.isEmpty() -> EmptyView(
            // Named as something to do rather than as an absence: this screen
            // cannot create one, so an empty state that only said "none" would
            // leave the reader with nowhere to go.
            message = "No watches yet. Ask Omnesis to keep an eye on something.",
            modifier = surface,
        )
        // Side insets match the Privacy feed: rows and dividers share them.
        else -> LazyColumn(
            modifier = surface,
            contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.sm),
        ) {
            items(ordered, key = { it.id }) { watch ->
                WatchRow(watch = watch, onClick = { onOpenWatch(watch.id) })
                HorizontalDivider(thickness = Dp.Hairline, color = OmTheme.colors.borderLight)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WatchRow(watch: WatchRecordDto, onClick: () -> Unit) {
    val c = OmTheme.colors
    // Side insets come from the list's content padding (matching the Privacy
    // feed), so the row carries only its vertical padding.
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = watch.name,
                style = MaterialTheme.typography.titleSmall,
                color = c.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            WatchStatusChip(watch.status)
        }
        watch.request?.takeIf { it.isNotBlank() }?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodyMedium,
                color = c.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            text = if (watch.firings == 1) "1 firing" else "${watch.firings} firings",
            style = MaterialTheme.typography.labelSmall,
            color = c.textSecondary,
        )
        // Who asked and where a firing goes are properties of the row, not sections of the
        // list: one watch is one thing however it was asked for.
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
        ) {
            WatchIndicator(watchAskedBy(watch))
            WatchIndicator(watchDeliveryLabel(watch))
        }
        watchVerdictMark(watch.verdict)?.let { mark ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = mark,
                    style = MaterialTheme.typography.labelSmall,
                    color = c.warning,
                    modifier = Modifier
                        .clip(RoundedCornerShape(OmRadius.pill))
                        .background(c.warning.copy(alpha = 0.14f))
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                )
                watch.verdict?.because?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.labelSmall,
                        color = c.textSecondary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        watch.note?.takeIf { it.isNotBlank() }?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.labelSmall,
                color = c.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Running, held, or finished — coloured so the one that needs attention is the one that draws
 * the eye. The only coloured thing on a row, which is what makes it readable at a glance.
 */
@Composable
internal fun WatchStatusChip(status: String) {
    val c = OmTheme.colors
    val tint = when (status) {
        "active" -> c.accent
        "paused" -> c.warning
        else -> c.textSecondary
    }
    Text(
        text = watchStatusLabel(status),
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
        color = tint,
        modifier = Modifier
            .clip(RoundedCornerShape(OmRadius.pill))
            .background(tint.copy(alpha = 0.18f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/**
 * A fact about a watch that is not its state — who asked for it, where its firings go.
 * Deliberately colourless, so it never competes with the status chip.
 */
@Composable
private fun WatchIndicator(text: String) {
    val c = OmTheme.colors
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = c.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .clip(RoundedCornerShape(OmRadius.pill))
            .background(c.textSecondary.copy(alpha = 0.12f))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

/**
 * Running first, held next, finished last.
 *
 * Which of these is still doing something is the question a reader brings to
 * the list, and each row states its own status — so order is enough to answer
 * it, and no heading has to.
 *
 * Stable within a rank, so the runtime's own order survives inside each band,
 * and a status this build has not heard of sorts with the finished rather than
 * vanishing.
 */
internal fun orderedWatches(watches: List<WatchRecordDto>): List<WatchRecordDto> =
    watches.sortedBy {
        when (it.status) {
            "active" -> 0
            "paused" -> 1
            else -> 2
        }
    }

/**
 * When the watch spoke.
 *
 * A firing is stamped with the subject's time so a replay reaches the same
 * answers, and for a watch about something that already had a date of its own
 * that is not when the watch spoke. Leading with the moment the journal
 * noticed is what stops a ledger reading as though the watch fired last month.
 */
internal fun firingWhen(firing: WatchFiringDto): String {
    val iso = firing.noticedAt ?: firing.firedAt
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return iso
    return TimeFormat.dateTime(instant.toEpochMilli())
}

/** The subject's own date, named only when it is genuinely a different day. */
internal fun firingSubjectDate(firing: WatchFiringDto): String? {
    val noticed = firing.noticedAt ?: return null
    val a = runCatching { Instant.parse(noticed) }.getOrNull() ?: return null
    val b = runCatching { Instant.parse(firing.firedAt) }.getOrNull() ?: return null
    if (kotlin.math.abs(a.toEpochMilli() - b.toEpochMilli()) < 60_000) return null
    return TimeFormat.dateTime(b.toEpochMilli())
}

/**
 * What delivering a firing did, when it was meant to go anywhere.
 *
 * Null for a watch that delivers nowhere, which is most of them — a firing
 * with no delivery block was never sent, and saying so would read as a failure
 * rather than as the watch doing exactly what was asked. When there is an
 * outcome the failing case is the one worth the ink: a notification that never
 * arrived looks exactly like a watch that never fired.
 */
internal fun firingDeliveryLabel(firing: WatchFiringDto): String? {
    val delivery = firing.delivery ?: return null
    if (delivery.delivered > 0) {
        return if (delivery.kind == "agent-wake") "woke an agent" else "notified you"
    }
    return delivery.error?.let { "not delivered — $it" } ?: "not delivered"
}

/** Whether the failing case should be painted as one. */
internal fun firingDeliveryFailed(firing: WatchFiringDto): Boolean {
    val delivery = firing.delivery ?: return false
    return delivery.delivered == 0
}

@Composable
internal fun monospace() = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)

/** The back arrow every detail screen in this stack uses. */
@Composable
internal fun BackButton(onBack: () -> Unit) {
    IconButton(onClick = onBack) {
        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
    }
}

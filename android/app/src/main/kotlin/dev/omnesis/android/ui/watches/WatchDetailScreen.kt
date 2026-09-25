// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.watches

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.PrivacySubscriptionFiring
import dev.omnesis.android.transport.dto.WatchDisclosureDto
import dev.omnesis.android.transport.dto.WatchFiringDocumentDto
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.classifyGatewayError
import dev.omnesis.android.ui.common.TimeFormat
import dev.omnesis.android.ui.privacy.canRevokePrivacySubscription

/** One watch: what it is, whether it is running, who hears about it, and what it has said. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WatchDetailScreen(
    onBack: () -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: WatchDetailViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    Scaffold(
        containerColor = OmTheme.colors.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Text(
                        text = state.watch?.name ?: "Watch",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = { BackButton(onBack) },
            )
        },
    ) { padding ->
        WatchDetailContent(
            state = state,
            onRetry = vm::reload,
            onShowDefinition = vm::loadDefinition,
            onRevoke = vm::revoke,
            onOpenSettings = onOpenSettings,
            modifier = Modifier.padding(padding),
        )
    }
}

/**
 * The detail, taking its data as arguments so a preview or a screenshot test
 * can render every state without a session or a gateway.
 *
 * Paints its own background for the same reason the list does: those callers
 * have no scaffold to inherit one from.
 */
@Composable
fun WatchDetailContent(
    state: WatchDetailUiState,
    onRetry: () -> Unit,
    onShowDefinition: () -> Unit,
    onRevoke: () -> Unit = {},
    onOpenSettings: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    val surface = modifier.fillMaxSize().background(c.bgPrimary)
    if (state.loading) {
        LoadingView(surface)
        return
    }
    if (state.error != null) {
        GatewayErrorView(
            context = "this watch",
            error = state.error,
            onRetry = onRetry,
            onOpenSettings = onOpenSettings,
            modifier = surface,
        )
        return
    }
    val rows = remember(state.firings, state.sentFirings) {
        mergeWatchFirings(state.firings, state.sentFirings)
    }
    val targetIndex = state.targetFiringSeq
        ?.let { seq -> rows.indexOfFirst { it.caught?.seq == seq } }
        ?.takeIf { it >= 0 }
    // Summary (when the watch is known), the disclosure section (when it discloses anything),
    // the definition, and the section heading all precede the firing rows.
    val leadingItems = listOf(state.watch != null, state.disclosure != null, true, true).count { it }
    val listState = rememberLazyListState(
        initialFirstVisibleItemIndex = targetIndex?.plus(leadingItems) ?: 0,
    )
    LazyColumn(
        modifier = surface,
        state = listState,
        contentPadding = PaddingValues(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        state.watch?.let { watch ->
            item("summary") {
                Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                    watch.request?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            text = it,
                            style = MaterialTheme.typography.bodyLarge,
                            color = c.textPrimary,
                        )
                    }
                    // Where a firing goes, unless the disclosure section below is about to say
                    // the same thing at greater length.
                    if (state.disclosure == null) {
                        Text(
                            text = watchDeliverySentence(watch),
                            style = MaterialTheme.typography.labelSmall,
                            color = c.textSecondary,
                        )
                    }
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        WatchStatusChip(watch.status)
                        // A paused watch that cannot say why is one the operator has to delete
                        // to recover from, so the reason sits beside the state.
                        watch.note?.takeIf { it.isNotBlank() }?.let {
                            Text(
                                text = it,
                                style = MaterialTheme.typography.labelSmall,
                                color = c.textSecondary,
                            )
                        }
                    }
                }
            }
        }

        state.disclosure?.let { disclosure ->
            item("disclosure") {
                WatchDisclosureSection(
                    disclosure = disclosure,
                    revoking = state.revoking,
                    actionError = state.actionError,
                    onRevoke = onRevoke,
                )
            }
        }

        item("definition") {
            WatchDefinitionSection(state = state, onShow = onShowDefinition)
        }

        item("firings-head") {
            SectionHeading(
                title = "FIRINGS",
                trailing = rows.size.takeIf { it > 0 }?.toString(),
            )
        }

        if (state.egressUnavailable) {
            item("egress-unreadable") {
                Text(
                    text = "What this watch has sent could not be read, so this list may be " +
                        "missing disclosures.",
                    style = MaterialTheme.typography.labelSmall,
                    color = c.warning,
                )
            }
        }

        if (rows.isEmpty()) {
            item("firings-empty") {
                Text(
                    text = "Nothing yet — this watch has not found anything to tell you about.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                    modifier = Modifier.fillMaxWidth().padding(vertical = OmSpacing.sm),
                )
            }
        } else {
            items(rows, key = { it.id }) { row ->
                val notified = state.targetFiringSeq != null && row.caught?.seq == state.targetFiringSeq
                WatchFiringRowView(row = row, fromNotification = notified)
                HorizontalDivider(color = c.borderLight)
            }
        }
    }
}

/**
 * What this watch may tell an integration, and the way out of it.
 *
 * The wake sentence is quoted from the record the integration was granted under, so a reader
 * comparing this against what the integration claims is comparing against the same words the
 * gateway enforces.
 */
@Composable
private fun WatchDisclosureSection(
    disclosure: WatchDisclosureDto,
    revoking: Boolean,
    actionError: Throwable?,
    onRevoke: () -> Unit,
) {
    val c = OmTheme.colors
    var confirming by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        SectionHeading("WHAT IT TELLS AN INTEGRATION")
        Text(
            text = watchDisclosureWakeSentence(disclosure),
            style = MaterialTheme.typography.bodyMedium,
            color = c.textPrimary,
        )
        Text(
            text = "A firing discloses only that a matching event exists. Anything more has to " +
                "pass the answer privacy boundary.",
            style = MaterialTheme.typography.labelSmall,
            color = c.textSecondary,
        )
        actionError?.let {
            Row(
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Outlined.WarningAmber,
                    contentDescription = "Warning",
                    tint = c.warning,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    text = "Revoke failed: ${classifyGatewayError(it)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = c.warning,
                )
            }
        }
        if (canRevokePrivacySubscription(disclosure.status)) {
            TextButton(
                onClick = { confirming = true },
                enabled = !revoking,
                // A text button carries its own tap padding; the offset pulls its label back
                // flush with the section it belongs to.
                modifier = Modifier.offset(x = -OmSpacing.md),
            ) {
                Text("Revoke this watch's access", color = c.danger)
            }
        }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Revoke this watch's access?") },
            text = {
                Text(
                    "The watch stays, and stops waking the integration. Everything it has " +
                        "already sent is kept — an egress ledger with the record removed would " +
                        "describe disclosures nothing accounts for.",
                )
            },
            confirmButton = {
                TextButton(onClick = { confirming = false; onRevoke() }) {
                    Text("Revoke", color = c.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("Cancel") }
            },
        )
    }
}

/**
 * The spec the runtime is actually running, behind a disclosure.
 *
 * Behind one because it is the largest thing on the screen and the one nobody
 * opens by default — but reachable, because "what is this watch actually
 * looking for?" has no other answer on a phone.
 */
@Composable
private fun WatchDefinitionSection(state: WatchDetailUiState, onShow: () -> Unit) {
    val c = OmTheme.colors
    val clipboard = LocalClipboardManager.current
    var expanded by remember { mutableStateOf(false) }
    Column {
        TextButton(
            onClick = {
                expanded = !expanded
                if (expanded) onShow()
            },
            modifier = Modifier.offset(x = -OmSpacing.md),
        ) {
            Text(if (expanded) "Hide definition" else "Show definition")
        }
        if (!expanded) return@Column
        when {
            state.definitionLoading -> Text(
                text = "Reading the definition…",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
            state.definitionError != null -> Text(
                text = "The definition could not be read.",
                style = MaterialTheme.typography.bodySmall,
                color = c.danger,
            )
            state.definition != null -> Column {
                Text(
                    text = state.definition,
                    style = monospace(),
                    color = c.textPrimary,
                    // Horizontally scrollable rather than wrapped: the DSL is
                    // indented, and re-wrapping it destroys the structure that
                    // makes it readable at all.
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(vertical = OmSpacing.xs),
                )
                TextButton(
                    onClick = { clipboard.setText(AnnotatedString(state.definition)) },
                    modifier = Modifier.offset(x = -OmSpacing.md),
                ) {
                    Icon(
                        Icons.Outlined.ContentCopy,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                    )
                    Text("  Copy", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

/** An uppercase section rule, matching the way the other detail screens head a group. */
@Composable
private fun SectionHeading(title: String, trailing: String? = null) {
    val c = OmTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = OmSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
            color = c.textSecondary,
        )
        if (trailing != null) {
            Text(
                text = trailing,
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/**
 * One event in a watch's history — what the runtime caught, what the ledger says left, or both.
 *
 * A row with no caught half is a disclosure the runtime has no record of, which is exactly the
 * discrepancy worth showing rather than hiding.
 */
@Composable
private fun WatchFiringRowView(row: WatchFiringRow, fromNotification: Boolean) {
    val c = OmTheme.colors
    val background = if (fromNotification) c.accent.copy(alpha = 0.12f) else c.bgPrimary
    Column(
        Modifier
            .fillMaxWidth()
            .background(background)
            .padding(vertical = OmSpacing.xs),
    ) {
        if (fromNotification) {
            Text(
                text = "What you were notified about",
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                color = c.accent,
            )
        }
        val caught = row.caught
        if (caught != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                Text(
                    text = firingWhen(caught),
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
                Text(
                    text = "seq ${caught.seq}",
                    style = monospace(),
                    color = c.textSecondary,
                )
            }
            // Both times, but only when they differ. A firing is stamped with the
            // time of the thing it is about, which for a calendar event or an old
            // document is not when the watch spoke.
            firingSubjectDate(caught)?.let {
                Text(
                    text = "About something dated $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            }
            firingDeliveryLabel(caught)?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (firingDeliveryFailed(caught)) c.danger else c.textSecondary,
                )
            }
            if (caught.documents.isNotEmpty()) {
                Column(
                    modifier = Modifier.padding(start = OmSpacing.sm, top = 2.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    caught.documents.forEach { WatchFiringDocumentRow(it) }
                }
            }
        } else {
            Text(
                text = TimeFormat.dateTime(row.at),
                style = MaterialTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
        }
        row.sent?.let { SentLine(it) }
    }
}

/** The egress ledger's half of an event: that something left, and whether it was accepted. */
@Composable
private fun SentLine(sent: PrivacySubscriptionFiring) {
    val c = OmTheme.colors
    Text(
        text = if (sent.acceptedAt != null) {
            "disclosed — ${sent.deliveryStatus.ifBlank { "accepted" }}"
        } else {
            "disclosed — ${sent.deliveryStatus.ifBlank { "recorded" }}"
        },
        style = MaterialTheme.typography.bodySmall,
        color = c.textSecondary,
    )
}

/**
 * One document the runtime read to decide this firing.
 *
 * Named rather than linked: a watch's ledger answers "why did this fire?", and
 * following it into the document belongs to a screen that can hold one, which
 * a list inside a row cannot.
 */
@Composable
private fun WatchFiringDocumentRow(document: WatchFiringDocumentDto) {
    Text(
        text = document.title.ifBlank { "Untitled" },
        style = MaterialTheme.typography.bodySmall,
        color = OmTheme.colors.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

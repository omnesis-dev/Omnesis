// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DirectionsRun
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.MembershipRefusalNotice
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.components.StopContributingRow
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.designsystem.components.AuthoritativeSyncStatus
import dev.omnesis.android.designsystem.components.sourceSyncStatusSummary
import dev.omnesis.android.setup.notices.toNoticeUi
import dev.omnesis.android.feature.health.HealthCategory
import dev.omnesis.android.feature.health.HealthSyncCoordinator
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.feature.health.setup.HealthSetupCopy
import dev.omnesis.android.setup.ui.SetupWhatsSentDisclosure
import dev.omnesis.android.setup.ui.LocalOpenPhoneSetupStep

/**
 * The "Health Connect" block of the app's Settings page — the single health
 * touchpoint the app module renders. Disabled → an opt-in hero card opening
 * Health Connect's setup page; enabled → status + actions + per-category toggles.
 * Mirrors the iOS SettingsView's Apple Health card pair.
 */
@Composable
fun HealthSettingsSection(vm: HealthViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val openSetupStep = LocalOpenPhoneSetupStep.current

    // Re-read availability + grants every time the screen RESUMES — not just on first
    // composition. The user may have just returned from the Play Store (having installed or
    // updated Health Connect) or from the Health Connect permission UI; in both cases this
    // composition stays alive in the background, so a one-shot LaunchedEffect would never
    // re-check.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    HealthSettingsSectionContent(
        state = state,
        // Turning Health Connect on always goes through its setup page: categories, the
        // disclosure, then Health Connect's consent.
        onSetUp = { openSetupStep(HealthSyncCoordinator.SOURCE_ID) },
        onSyncNow = vm::syncNow,
        // Re-prompt opens Health Connect's manage-permissions screen rather than
        // re-launching the permission contract: once the user has answered the
        // consent sheet, Health Connect silently ignores a contract re-launch, so
        // the settings screen is the only reliable way to (re-)grant. When the
        // provider isn't installed/updated there's nothing to grant yet — send
        // them to the Play Store. The ON_RESUME refresh re-reads grants on return.
        onRequestPermissions = {
            if (state.availability == HealthConnectAvailability.Available) {
                openHealthConnectPermissions(context)
            } else {
                openHealthConnectPlayStore(context)
            }
        },
        onToggleCategory = vm::toggleCategory,
        onDisable = vm::disable,
    )
}

/** Stateless body, split out so previews and screenshots can drive every state. */
@Composable
fun HealthSettingsSectionContent(
    state: HealthViewModel.UiState,
    onSetUp: () -> Unit,
    onSyncNow: () -> Unit,
    onRequestPermissions: () -> Unit,
    onToggleCategory: (HealthCategory, Boolean) -> Unit,
    onDisable: () -> Unit,
) {
    val c = OmTheme.colors
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(OmSpacing.md))
        SectionLabel("Health Connect")
        // A refusal put the switch back off: say so above whichever card
        // follows, or the reason would go with the switch.
        state.membershipRefusal?.let {
            MembershipRefusalNotice(it)
            Spacer(Modifier.height(OmSpacing.sm))
        }
        state.membershipPending?.let {
            MembershipRefusalNotice(it)
            Spacer(Modifier.height(OmSpacing.sm))
        }
        if (!state.enabled) {
            SetUpCard(onSetUp)
            Spacer(Modifier.height(OmSpacing.sm))
            SetupWhatsSentDisclosure(HealthSetupCopy)
        } else {
            StatusCard(state, onSyncNow, onRequestPermissions, onDisable)
            Spacer(Modifier.height(OmSpacing.sm))
            SetupWhatsSentDisclosure(HealthSetupCopy)
            Spacer(Modifier.height(OmSpacing.sm))
            CategoriesCard(state.enabledCategories, onToggleCategory)
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                if (state.availability == HealthConnectAvailability.Available) {
                    "Disabled categories stop syncing even while Health Connect still " +
                        "allows access. Background sync runs hourly."
                } else {
                    "Category choices are saved locally; no health data syncs until Health Connect is available."
                },
                style = MaterialTheme.typography.labelMedium,
                color = c.textSecondary,
            )
        }
    }
}

/** Opt-in hero card (iOS `appleHealthEnableCard` port): pitch + category chips + Set up. */
@Composable
private fun SetUpCard(onSetUp: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(
                Brush.linearGradient(listOf(c.success.copy(alpha = 0.10f), c.bgSecondary)),
            )
            .border(1.dp, c.success.copy(alpha = 0.35f), shape)
            .clickable(onClick = onSetUp)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            Icon(
                Icons.Outlined.MonitorHeart,
                contentDescription = null,
                tint = c.success,
                modifier = Modifier.size(32.dp),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "Set up Health Connect",
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp),
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                )
                Text(
                    "Sync this phone's health data to your gateway.",
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
                    color = c.textSecondary,
                )
            }
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(20.dp),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            HealthChip(Icons.AutoMirrored.Outlined.DirectionsRun, "Activity")
            HealthChip(Icons.Outlined.MonitorHeart, "Vitals")
            HealthChip(Icons.Outlined.Bedtime, "Sleep")
            HealthChip(null, "+4")
        }
    }
}

@Composable
private fun HealthChip(icon: ImageVector?, label: String) {
    val c = OmTheme.colors
    Row(
        Modifier
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(c.bgTertiary)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = c.success, modifier = Modifier.size(12.dp))
        }
        Text(
            label,
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
            fontWeight = FontWeight.Medium,
            color = c.textSecondary,
        )
    }
}

/** Status + permissions summary + the Sync now / re-prompt / stop-contributing action rows. */
@Composable
private fun StatusCard(
    state: HealthViewModel.UiState,
    onSyncNow: () -> Unit,
    onRequestPermissions: () -> Unit,
    onDisable: () -> Unit,
) {
    val c = OmTheme.colors
    OmnesisCard(padding = OmSpacing.lg) {
        StatusRow(state)
        Row(
            Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Health data", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
            Spacer(Modifier.width(OmSpacing.lg))
            Text(
                "${state.grantedTypePermissions} of ${state.totalTypePermissions} types",
                style = MaterialTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
        }
        if (state.backgroundAccessSupported) {
            RowDivider()
            CapabilityRow("Background updates", state.backgroundAccessGranted)
        }
        if (state.historyAccessSupported) {
            RowDivider()
            CapabilityRow("Older history", state.historyAccessGranted)
        }
        if (state.availability == HealthConnectAvailability.Available) {
            RowDivider()
            if (state.syncing || state.lastResult == null && state.authoritativeStatus?.state == "syncing") {
                // The sync-in-progress affordance: the action row swaps for a spinner.
                Row(
                    Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
                ) {
                    OmSpinner(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = c.textSecondary)
                    Text("Syncing…", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
                }
            } else {
                ActionRow("Sync now", c.accent, onSyncNow)
            }
            RowDivider()
            ActionRow("Request permissions again", c.accent, onRequestPermissions)
        } else if (state.availability != HealthConnectAvailability.NotSupported) {
            RowDivider()
            ActionRow("Install or update Health Connect", c.accent, onRequestPermissions)
        }
        RowDivider()
        StopContributingRow(onConfirm = onDisable)
    }
}

@Composable
private fun CapabilityRow(label: String, granted: Boolean) {
    Row(Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = OmTheme.colors.textSecondary)
        Text(if (granted) "Allowed" else "Needs attention", style = MaterialTheme.typography.bodyMedium, color = if (granted) OmTheme.colors.success else OmTheme.colors.warning)
    }
}

/**
 * One icon + line summarizing availability and the last sync outcome. The
 * in-flight spinner lives on the Sync now row, not here, so a running sync
 * keeps the previous outcome visible.
 */
@Composable
private fun StatusRow(state: HealthViewModel.UiState) {
    val c = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        when {
            state.availability != HealthConnectAvailability.Available -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText(availabilityLabel(state.availability), c.warning)
            }
            state.grantedTypePermissions < state.totalTypePermissions ||
                (state.backgroundAccessSupported && !state.backgroundAccessGranted) ||
                (state.historyAccessSupported && !state.historyAccessGranted) -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Health permissions need attention", c.warning)
            }
            state.syncing -> AuthoritativeSyncStatus(sourceSyncStatusSummary(state = "syncing"))
            state.lastResult is HealthSyncCoordinator.SyncResult.Success -> {
                val n = state.lastResult.processed
                Icon(Icons.Outlined.CheckCircle, null, tint = c.success, modifier = Modifier.size(18.dp))
                StatusText(if (n == 0) "Synced · up to date" else "Synced · $n records", c.success)
            }
            state.lastResult is HealthSyncCoordinator.SyncResult.NeedsAttention -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Needs attention: ${state.lastResult.message}", c.warning)
            }
            state.lastResult is HealthSyncCoordinator.SyncResult.Failed -> {
                Icon(Icons.Outlined.ErrorOutline, null, tint = c.danger, modifier = Modifier.size(18.dp))
                StatusText("Sync failed: ${state.lastResult.message}", c.danger, maxLines = Int.MAX_VALUE)
            }
            state.lastResult is HealthSyncCoordinator.SyncResult.SourceRemoved -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Removed in Omnesis — re-enable to resume", c.warning)
            }
            state.lastResult is HealthSyncCoordinator.SyncResult.SourcePaused -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Paused in Omnesis — resume it there", c.warning)
            }
            state.lastResult is HealthSyncCoordinator.SyncResult.Skipped -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText(state.lastResult.reason, c.warning)
            }
            state.authoritativeStatus != null -> state.authoritativeStatus.let { status ->
                AuthoritativeSyncStatus(
                    sourceSyncStatusSummary(status.state, progressMessage = status.progress?.message, lastSyncAt = status.lastSyncAt),
                    notices = status.displayNotices.toNoticeUi(),
                )
            }
            else -> {
                Icon(Icons.Outlined.CheckCircle, null, tint = c.success, modifier = Modifier.size(18.dp))
                StatusText("Ready to sync", c.textSecondary)
            }
        }
    }
}

@Composable
private fun StatusText(text: String, color: Color, maxLines: Int = 2) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = color,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

private fun availabilityLabel(availability: HealthConnectAvailability): String = when (availability) {
    HealthConnectAvailability.NotInstalled -> "Health Connect is not installed"
    HealthConnectAvailability.UpdateRequired -> "Health Connect needs an update"
    HealthConnectAvailability.NotSupported -> "Health Connect isn't supported on this device"
    HealthConnectAvailability.Available -> "Health Connect is available"
}

/** Per-category toggle rows, in catalog order. */
@Composable
private fun CategoriesCard(
    enabledCategories: Set<HealthCategory>,
    onToggleCategory: (HealthCategory, Boolean) -> Unit,
) {
    val c = OmTheme.colors
    OmnesisCard(padding = OmSpacing.lg) {
        healthCategoryUi.forEachIndexed { i, entry ->
            if (i > 0) RowDivider()
            // Fixed compact height + a scaled-down switch: the stock Switch's
            // 48dp touch-target would inflate every row well past the page's
            // grouped-card rhythm.
            Row(
                Modifier.fillMaxWidth().height(36.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.md),
            ) {
                Icon(entry.icon, contentDescription = null, tint = c.accent, modifier = Modifier.size(20.dp))
                Text(
                    entry.title,
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = entry.category in enabledCategories,
                    onCheckedChange = { onToggleCategory(entry.category, it) },
                    modifier = Modifier.scale(0.78f),
                )
            }
        }
    }
}

/** Grey-caps section label matching the Settings page's section headers. */
@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 0.5.sp),
        fontWeight = FontWeight.SemiBold,
        color = OmTheme.colors.textSecondary,
        modifier = Modifier.padding(top = OmSpacing.sm, bottom = OmSpacing.xs),
    )
}

/** Hairline separator between grouped card rows, echoing an iOS Form row divider. */
@Composable
private fun RowDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(vertical = OmSpacing.xs),
        thickness = 1.dp,
        color = OmTheme.colors.borderLight,
    )
}

/** Tappable list row sized to the card's body rhythm (same as the Gateway card's rows). */
@Composable
private fun ActionRow(label: String, tint: Color, onClick: () -> Unit) {
    Text(
        label,
        style = MaterialTheme.typography.bodyMedium,
        color = tint,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = OmSpacing.xs),
    )
}

// --- previews ---

private fun enabledState() = HealthViewModel.UiState(
    availability = HealthConnectAvailability.Available,
    enabled = true,
    grantedPermissions = 24,
    syncing = false,
    lastResult = HealthSyncCoordinator.SyncResult.Success(1184),
)

@Preview(name = "Health settings · disabled · light", showBackground = true)
@Composable
private fun HealthSettingsDisabledLight() {
    OmnesisTheme(darkTheme = false) {
        HealthSettingsSectionContent(HealthViewModel.UiState(), {}, {}, {}, { _, _ -> }, {})
    }
}

@Preview(name = "Health settings · enabled · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun HealthSettingsEnabledDark() {
    OmnesisTheme(darkTheme = true) {
        HealthSettingsSectionContent(enabledState(), {}, {}, {}, { _, _ -> }, {})
    }
}

@Preview(name = "Health settings · syncing · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun HealthSettingsSyncingDark() {
    OmnesisTheme(darkTheme = true) {
        HealthSettingsSectionContent(enabledState().copy(syncing = true), {}, {}, {}, { _, _ -> }, {})
    }
}

@Preview(name = "Health settings · error · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun HealthSettingsErrorDark() {
    OmnesisTheme(darkTheme = true) {
        HealthSettingsSectionContent(
            enabledState().copy(
                lastResult = HealthSyncCoordinator.SyncResult.NeedsAttention("authentication failed"),
            ),
            {}, {}, {}, { _, _ -> }, {},
        )
    }
}

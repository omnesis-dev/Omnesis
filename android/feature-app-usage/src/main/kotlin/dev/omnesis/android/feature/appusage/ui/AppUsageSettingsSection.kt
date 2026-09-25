// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.ui

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
import dev.omnesis.android.feature.appusage.AppUsageSyncCoordinator
import dev.omnesis.android.designsystem.components.AuthoritativeSyncStatus
import dev.omnesis.android.designsystem.components.sourceSyncStatusSummary
import dev.omnesis.android.setup.notices.toNoticeUi
import dev.omnesis.android.feature.appusage.setup.AppUsageSetupCopy
import dev.omnesis.android.feature.appusage.setup.openUsageAccessSettings
import dev.omnesis.android.setup.ui.SetupWhatsSentDisclosure
import dev.omnesis.android.setup.ui.LocalOpenPhoneSetupStep

/**
 * The "App Usage" block of the app's Settings page. Disabled → an opt-in card
 * that opens App Usage's setup page, where the user agrees and is sent to the
 * system usage-access screen; enabled → status + actions.
 */
@Composable
fun AppUsageSettingsSection(vm: AppUsageViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val openSetupStep = LocalOpenPhoneSetupStep.current

    // Re-read the usage-access grant on every RESUME — the user may have just
    // returned from the system Settings app after granting/revoking it there.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    AppUsageSettingsSectionContent(
        state = state,
        onSetUp = { openSetupStep(AppUsageSyncCoordinator.SOURCE_ID) },
        onSyncNow = vm::syncNow,
        onOpenSettings = { openUsageAccessSettings(context) },
        onDisable = vm::disable,
    )
}

/** Stateless body, split out so previews and screenshots can drive every state. */
@Composable
fun AppUsageSettingsSectionContent(
    state: AppUsageViewModel.UiState,
    onSetUp: () -> Unit,
    onSyncNow: () -> Unit,
    onOpenSettings: () -> Unit,
    onDisable: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(OmSpacing.md))
        SectionLabel("App Usage")
        // A refusal put the switch back off a moment ago: say so above
        // whichever card follows, or the reason would go with the switch.
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
            SetupWhatsSentDisclosure(AppUsageSetupCopy)
        } else {
            StatusCard(state, onSyncNow, onOpenSettings, onDisable)
            Spacer(Modifier.height(OmSpacing.sm))
            SetupWhatsSentDisclosure(AppUsageSetupCopy)
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                "How long you spend in each app, and when you pick up your phone. Never what's " +
                    "on screen — just timing and duration.",
                style = MaterialTheme.typography.labelMedium,
                color = OmTheme.colors.textSecondary,
            )
        }
    }
}

/** Opt-in hero card: pitch + Set up. */
@Composable
private fun SetUpCard(onSetUp: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Brush.linearGradient(listOf(c.success.copy(alpha = 0.10f), c.bgSecondary)))
            .border(1.dp, c.success.copy(alpha = 0.35f), shape)
            .clickable(onClick = onSetUp)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            Icon(Icons.Outlined.BarChart, contentDescription = null, tint = c.success, modifier = Modifier.size(32.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "Set up App Usage",
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp),
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                )
                Text(
                    "Sync this phone's screen time to your gateway.",
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
    }
}

/** Status summary + the Sync now / re-open Settings / stop-contributing action rows. */
@Composable
private fun StatusCard(
    state: AppUsageViewModel.UiState,
    onSyncNow: () -> Unit,
    onOpenSettings: () -> Unit,
    onDisable: () -> Unit,
) {
    val c = OmTheme.colors
    OmnesisCard(padding = OmSpacing.lg) {
        StatusRow(state)
        RowDivider()
        if (state.syncing || state.lastResult == null && state.authoritativeStatus?.state == "syncing") {
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
        if (!state.hasUsageAccess) {
            RowDivider()
            ActionRow("Grant usage access in Settings", c.accent, onOpenSettings)
        }
        RowDivider()
        StopContributingRow(onConfirm = onDisable)
    }
}

@Composable
private fun StatusRow(state: AppUsageViewModel.UiState) {
    val c = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        when {
            !state.hasUsageAccess -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Usage access not granted", c.warning)
            }
            state.syncing -> AuthoritativeSyncStatus(sourceSyncStatusSummary(state = "syncing"))
            state.lastResult is AppUsageSyncCoordinator.SyncResult.Success -> {
                val n = state.lastResult.processed
                Icon(Icons.Outlined.CheckCircle, null, tint = c.success, modifier = Modifier.size(18.dp))
                StatusText(if (n == 0) "Synced · up to date" else "Synced · $n records", c.success)
            }
            state.lastResult is AppUsageSyncCoordinator.SyncResult.NeedsAttention -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Needs attention: ${state.lastResult.message}", c.warning)
            }
            state.lastResult is AppUsageSyncCoordinator.SyncResult.Failed -> {
                Icon(Icons.Outlined.ErrorOutline, null, tint = c.danger, modifier = Modifier.size(18.dp))
                StatusText("Sync failed: ${state.lastResult.message}", c.danger)
            }
            state.lastResult is AppUsageSyncCoordinator.SyncResult.SourceRemoved -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Removed in Omnesis — re-enable to resume", c.warning)
            }
            state.lastResult is AppUsageSyncCoordinator.SyncResult.SourcePaused -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Paused in Omnesis — resume it there", c.warning)
            }
            state.lastResult is AppUsageSyncCoordinator.SyncResult.Skipped -> {
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
private fun StatusText(text: String, color: Color) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = color, maxLines = 2, overflow = TextOverflow.Ellipsis)
}

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

@Composable
private fun RowDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(vertical = OmSpacing.xs),
        thickness = 1.dp,
        color = OmTheme.colors.borderLight,
    )
}

@Composable
private fun ActionRow(label: String, tint: Color, onClick: () -> Unit) {
    Text(
        label,
        style = MaterialTheme.typography.bodyMedium,
        color = tint,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = OmSpacing.xs),
    )
}

// --- previews ---

private fun enabledState() = AppUsageViewModel.UiState(
    enabled = true,
    hasUsageAccess = true,
    syncing = false,
    lastResult = AppUsageSyncCoordinator.SyncResult.Success(42),
)

@Preview(name = "App usage settings · disabled · light", showBackground = true)
@Composable
private fun AppUsageSettingsDisabledLight() {
    OmnesisTheme(darkTheme = false) {
        AppUsageSettingsSectionContent(AppUsageViewModel.UiState(), {}, {}, {}, {})
    }
}

@Preview(name = "App usage settings · enabled · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun AppUsageSettingsEnabledDark() {
    OmnesisTheme(darkTheme = true) {
        AppUsageSettingsSectionContent(enabledState(), {}, {}, {}, {})
    }
}

@Preview(name = "App usage settings · syncing · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun AppUsageSettingsSyncingDark() {
    OmnesisTheme(darkTheme = true) {
        AppUsageSettingsSectionContent(enabledState().copy(syncing = true), {}, {}, {}, {})
    }
}

@Preview(name = "App usage settings · access revoked · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun AppUsageSettingsNoAccessDark() {
    OmnesisTheme(darkTheme = true) {
        AppUsageSettingsSectionContent(enabledState().copy(hasUsageAccess = false), {}, {}, {}, {})
    }
}

@Preview(name = "App usage settings · error · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun AppUsageSettingsErrorDark() {
    OmnesisTheme(darkTheme = true) {
        AppUsageSettingsSectionContent(
            enabledState().copy(lastResult = AppUsageSyncCoordinator.SyncResult.NeedsAttention("authentication failed")),
            {}, {}, {}, {},
        )
    }
}

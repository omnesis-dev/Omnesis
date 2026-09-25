// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments.ui

import android.os.Build
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
import androidx.compose.material.icons.automirrored.outlined.DirectionsWalk
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
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
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsAvailability
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSyncCoordinator
import dev.omnesis.android.designsystem.components.AuthoritativeSyncStatus
import dev.omnesis.android.designsystem.components.sourceSyncStatusSummary
import dev.omnesis.android.setup.notices.toNoticeUi
import dev.omnesis.android.feature.activitysegments.setup.ActivitySegmentsSetupCopy
import dev.omnesis.android.feature.activitysegments.setup.openPlayStoreForGms
import dev.omnesis.android.setup.ui.LocalOpenPhoneSetupStep
import dev.omnesis.android.setup.ui.SetupWhatsSentDisclosure
import dev.omnesis.android.setup.ui.openAppDetailsSettings

/**
 * The "Activity Segments" block of the app's Settings page. Disabled → an
 * opt-in hero card that opens the source's setup page; enabled → status +
 * actions. Gated first on Google Play services [ActivitySegmentsAvailability]
 * (unlike Call Log/App Usage, which have no such dependency), then on the
 * `ACTIVITY_RECOGNITION` permission — a real runtime dialog on API 29+,
 * implicitly granted below that.
 */
@Composable
fun ActivitySegmentsSettingsSection(vm: ActivitySegmentsViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val openSetupStep = LocalOpenPhoneSetupStep.current
    // Re-read availability + the permission grant on every RESUME — the user
    // may have just returned from the Play Store or system Settings.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    val permanentlyDenied = Build.VERSION.SDK_INT >= 29 && !state.hasPermission &&
        state.permissionPermanentlyDenied

    ActivitySegmentsSettingsSectionContent(
        state = state,
        permanentlyDenied = permanentlyDenied,
        // Turning Activity Segments on always goes through its setup page: the disclosure, then Android's prompt.
        onSetUp = { openSetupStep(ActivitySegmentsSyncCoordinator.SOURCE_ID) },
        onSyncNow = vm::syncNow,
        onOpenAppSettings = { openAppDetailsSettings(context) },
        onUpdatePlayServices = { openPlayStoreForGms(context) },
        onDisable = vm::disable,
    )
}

/** Stateless body, split out so previews and screenshots can drive every state. */
@Composable
fun ActivitySegmentsSettingsSectionContent(
    state: ActivitySegmentsViewModel.UiState,
    onSetUp: () -> Unit,
    onSyncNow: () -> Unit,
    onOpenAppSettings: () -> Unit,
    onUpdatePlayServices: () -> Unit,
    onDisable: () -> Unit,
    permanentlyDenied: Boolean = false,
) {
    val showingStatus = state.enabled && state.availability == ActivitySegmentsAvailability.Available
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(OmSpacing.md))
        SectionLabel("Activity Segments")
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
        when (state.availability) {
            // Nothing on this phone can fix a missing or unsupported Play services install.
            ActivitySegmentsAvailability.NotSupported, ActivitySegmentsAvailability.NotInstalled -> {
                Text(
                    "Needs Google Play services, which isn't available on this phone.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = OmTheme.colors.textSecondary,
                    modifier = Modifier.padding(vertical = OmSpacing.sm),
                )
            }
            ActivitySegmentsAvailability.UpdateRequired -> UnavailableCard(onUpdatePlayServices)
            ActivitySegmentsAvailability.Available -> when {
                showingStatus -> StatusCard(state, onSyncNow, onOpenAppSettings, onDisable)
                permanentlyDenied -> PermanentlyDeniedCard(onOpenAppSettings)
                else -> SetUpCard(onSetUp)
            }
        }
        Spacer(Modifier.height(OmSpacing.sm))
        SetupWhatsSentDisclosure(ActivitySegmentsSetupCopy)
        if (showingStatus) {
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                "Coarse movement periods — still, walking, running, cycling, driving. Never " +
                    "location or speed, just when each kind of movement started and stopped.",
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
            Icon(Icons.AutoMirrored.Outlined.DirectionsWalk, contentDescription = null, tint = c.success, modifier = Modifier.size(32.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "Set up Activity Segments",
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp),
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                )
                Text(
                    "Sync this phone's movement periods to your gateway.",
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

/** Shown once a permission request has already come back denied and the system dialog won't fire again. */
@Composable
private fun PermanentlyDeniedCard(onOpenAppSettings: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Brush.linearGradient(listOf(c.warning.copy(alpha = 0.10f), c.bgSecondary)))
            .border(1.dp, c.warning.copy(alpha = 0.35f), shape)
            .clickable(onClick = onOpenAppSettings)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = c.warning, modifier = Modifier.size(32.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "Permission denied",
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp),
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                )
                Text(
                    "Android won't show the request again — grant it from system Settings instead.",
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

/** Shown instead of the Set up card while Google Play services needs an update. */
@Composable
private fun UnavailableCard(onUpdatePlayServices: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.bgSecondary)
            .border(1.dp, c.border, shape)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Text(
            "Google Play services needs an update",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
        )
        Text(
            "Activity Segments needs Google Play services to detect movement.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
        )
        ActionRow("Update Google Play services", c.accent, onUpdatePlayServices)
    }
}

/** Status summary + the Sync now / re-prompt / stop-contributing action rows. */
@Composable
private fun StatusCard(
    state: ActivitySegmentsViewModel.UiState,
    onSyncNow: () -> Unit,
    onOpenAppSettings: () -> Unit,
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
        if (!state.hasPermission) {
            RowDivider()
            ActionRow("Grant permission in Settings", c.accent, onOpenAppSettings)
        }
        RowDivider()
        StopContributingRow(onConfirm = onDisable)
    }
}

@Composable
private fun StatusRow(state: ActivitySegmentsViewModel.UiState) {
    val c = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        when {
            !state.hasPermission -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Activity recognition permission not granted", c.warning)
            }
            state.syncing -> AuthoritativeSyncStatus(sourceSyncStatusSummary(state = "syncing"))
            state.lastResult is ActivitySegmentsSyncCoordinator.SyncResult.Success -> {
                val n = state.lastResult.processed
                Icon(Icons.Outlined.CheckCircle, null, tint = c.success, modifier = Modifier.size(18.dp))
                StatusText(if (n == 0) "Synced · up to date" else "Synced · $n records", c.success)
            }
            state.lastResult is ActivitySegmentsSyncCoordinator.SyncResult.NeedsAttention -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Needs attention: ${state.lastResult.message}", c.warning)
            }
            state.lastResult is ActivitySegmentsSyncCoordinator.SyncResult.Failed -> {
                Icon(Icons.Outlined.ErrorOutline, null, tint = c.danger, modifier = Modifier.size(18.dp))
                StatusText("Sync failed: ${state.lastResult.message}", c.danger)
            }
            state.lastResult is ActivitySegmentsSyncCoordinator.SyncResult.SourceRemoved -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Removed in Omnesis — re-enable to resume", c.warning)
            }
            state.lastResult is ActivitySegmentsSyncCoordinator.SyncResult.SourcePaused -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Paused in Omnesis — resume it there", c.warning)
            }
            state.lastResult is ActivitySegmentsSyncCoordinator.SyncResult.Skipped -> {
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

private fun enabledState() = ActivitySegmentsViewModel.UiState(
    enabled = true,
    hasPermission = true,
    availability = ActivitySegmentsAvailability.Available,
    syncing = false,
    lastResult = ActivitySegmentsSyncCoordinator.SyncResult.Success(12),
)

@Preview(name = "Activity segments · disabled · light", showBackground = true)
@Composable
private fun ActivitySegmentsSettingsDisabledLight() {
    OmnesisTheme(darkTheme = false) {
        ActivitySegmentsSettingsSectionContent(
            ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.Available),
            {}, {}, {}, {}, {},
        )
    }
}

@Preview(name = "Activity segments · permanently denied · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun ActivitySegmentsSettingsPermanentlyDeniedDark() {
    OmnesisTheme(darkTheme = true) {
        ActivitySegmentsSettingsSectionContent(
            ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.Available),
            {}, {}, {}, {}, {}, permanentlyDenied = true,
        )
    }
}

@Preview(name = "Activity segments · enabled · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun ActivitySegmentsSettingsEnabledDark() {
    OmnesisTheme(darkTheme = true) {
        ActivitySegmentsSettingsSectionContent(enabledState(), {}, {}, {}, {}, {})
    }
}

@Preview(name = "Activity segments · syncing · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun ActivitySegmentsSettingsSyncingDark() {
    OmnesisTheme(darkTheme = true) {
        ActivitySegmentsSettingsSectionContent(enabledState().copy(syncing = true), {}, {}, {}, {}, {})
    }
}

@Preview(name = "Activity segments · permission revoked · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun ActivitySegmentsSettingsNoPermissionDark() {
    OmnesisTheme(darkTheme = true) {
        ActivitySegmentsSettingsSectionContent(enabledState().copy(hasPermission = false), {}, {}, {}, {}, {})
    }
}

@Preview(name = "Activity segments · error · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun ActivitySegmentsSettingsErrorDark() {
    OmnesisTheme(darkTheme = true) {
        ActivitySegmentsSettingsSectionContent(
            enabledState().copy(lastResult = ActivitySegmentsSyncCoordinator.SyncResult.NeedsAttention("authentication failed")),
            {}, {}, {}, {}, {},
        )
    }
}

@Preview(name = "Activity segments · Play services not installed · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun ActivitySegmentsSettingsNotInstalledDark() {
    OmnesisTheme(darkTheme = true) {
        ActivitySegmentsSettingsSectionContent(
            ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.NotInstalled),
            {}, {}, {}, {}, {},
        )
    }
}

@Preview(name = "Activity segments · not supported · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun ActivitySegmentsSettingsNotSupportedDark() {
    OmnesisTheme(darkTheme = true) {
        ActivitySegmentsSettingsSectionContent(
            ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.NotSupported),
            {}, {}, {}, {}, {},
        )
    }
}

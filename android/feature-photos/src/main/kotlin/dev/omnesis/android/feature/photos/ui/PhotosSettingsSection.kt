// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.ui

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
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Image
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
import dev.omnesis.android.designsystem.components.AuthoritativeSyncStatus
import dev.omnesis.android.designsystem.components.MembershipRefusalNotice
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.components.StopContributingRow
import dev.omnesis.android.designsystem.components.sourceSyncStatusSummary
import dev.omnesis.android.setup.notices.toNoticeUi
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.feature.photos.PhotosAccess
import dev.omnesis.android.feature.photos.PhotosSyncCoordinator
import dev.omnesis.android.feature.photos.setup.PhotosSetupCopy
import dev.omnesis.android.setup.ui.LocalOpenPhoneSetupStep
import dev.omnesis.android.setup.ui.SetupWhatsSentDisclosure
import dev.omnesis.android.setup.ui.openAppDetailsSettings

/**
 * The "Photos" block of the app's Settings page. Disabled -> a set-up card
 * that opens the Photos phone setup page, where Android is asked for access;
 * enabled -> status + actions.
 */
@Composable
fun PhotosSettingsSection(vm: PhotosViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val openSetupStep = LocalOpenPhoneSetupStep.current
    // Re-read the permission grant on every RESUME — the user may have just
    // returned from the system Settings app after granting/revoking it there.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    val permanentlyDenied = !state.hasPermission && state.permissionPermanentlyDenied

    PhotosSettingsSectionContent(
        state = state,
        permanentlyDenied = permanentlyDenied,
        // Turning Photos on always goes through its setup page: the disclosure, then Android's prompt.
        onSetUp = { openSetupStep(PhotosSyncCoordinator.SOURCE_ID) },
        onSyncNow = vm::syncNow,
        onOpenAppSettings = { openAppDetailsSettings(context) },
        onDisable = vm::disable,
    )
}

/** Stateless body, split out so previews and screenshots can drive every state. */
@Composable
fun PhotosSettingsSectionContent(
    state: PhotosViewModel.UiState,
    onSetUp: () -> Unit,
    onSyncNow: () -> Unit,
    onOpenAppSettings: () -> Unit,
    onDisable: () -> Unit,
    permanentlyDenied: Boolean = false,
) {
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(OmSpacing.md))
        SectionLabel("Photos")
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
            if (permanentlyDenied) {
                PermanentlyDeniedCard(onOpenAppSettings)
            } else {
                SetUpCard(onSetUp)
            }
            Spacer(Modifier.height(OmSpacing.sm))
            SetupWhatsSentDisclosure(PhotosSetupCopy)
        } else {
            StatusCard(state, onSyncNow, onOpenAppSettings, onDisable)
            Spacer(Modifier.height(OmSpacing.sm))
            SetupWhatsSentDisclosure(PhotosSetupCopy)
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                "Screenshots and photos are analyzed entirely on-device — only extracted text and " +
                    "metadata are sent to your gateway, never images. Geotagged photos are " +
                    "reverse-geocoded to a place name, which may use your phone's location " +
                    "service. New photos process quickly; the full library backfill happens " +
                    "gradually in priority order (screenshots, then recent, then the rest).",
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
            .background(Brush.linearGradient(listOf(c.accent.copy(alpha = 0.10f), c.bgSecondary)))
            .border(1.dp, c.accent.copy(alpha = 0.35f), shape)
            .clickable(onClick = onSetUp)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            Icon(Icons.Outlined.Image, contentDescription = null, tint = c.accent, modifier = Modifier.size(32.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "Set up Photos",
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp),
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                )
                Text(
                    "OCR your screenshots and photos on-device and make them searchable.",
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

/**
 * Shown instead of [SetUpCard] once a permission request has already come
 * back denied and the system will no longer show its own dialog. Points at
 * the system app-details screen, the only remaining way to grant it.
 */
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

/** Status summary + the Sync now / re-prompt / stop-contributing action rows. */
@Composable
private fun StatusCard(
    state: PhotosViewModel.UiState,
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
        if (state.access != PhotosAccess.FULL) {
            RowDivider()
            ActionRow(if (state.access == PhotosAccess.LIMITED) "Choose more photos in Settings" else "Grant permission in Settings", c.accent, onOpenAppSettings)
        }
        RowDivider()
        StopContributingRow(onConfirm = onDisable)
    }
}

@Composable
private fun StatusRow(state: PhotosViewModel.UiState) {
    val c = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        when {
            !state.hasPermission -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Photos permission not granted", c.warning)
            }
            state.access == PhotosAccess.LIMITED -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Selected photos only", c.warning)
            }
            state.syncing -> AuthoritativeSyncStatus(sourceSyncStatusSummary(state = "syncing"))
            state.lastResult is PhotosSyncCoordinator.SyncResult.Success -> {
                val n = state.lastResult.processed
                Icon(Icons.Outlined.CheckCircle, null, tint = c.success, modifier = Modifier.size(18.dp))
                StatusText(if (n == 0) "Synced · up to date" else "Synced · $n photo(s)", c.success)
            }
            state.lastResult is PhotosSyncCoordinator.SyncResult.NeedsAttention -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Needs attention: ${state.lastResult.message}", c.warning)
            }
            state.lastResult is PhotosSyncCoordinator.SyncResult.Failed -> {
                Icon(Icons.Outlined.ErrorOutline, null, tint = c.danger, modifier = Modifier.size(18.dp))
                StatusText("Sync failed: ${state.lastResult.message}", c.danger)
            }
            state.lastResult is PhotosSyncCoordinator.SyncResult.SourceRemoved -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Removed in Omnesis — re-enable to resume", c.warning)
            }
            state.lastResult is PhotosSyncCoordinator.SyncResult.SourcePaused -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText("Paused in Omnesis — resume it there", c.warning)
            }
            state.lastResult is PhotosSyncCoordinator.SyncResult.Skipped -> {
                Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
                StatusText(state.lastResult.reason, c.warning)
            }
            state.authoritativeStatus != null -> state.authoritativeStatus.let { status ->
                AuthoritativeSyncStatus(
                    sourceSyncStatusSummary(
                        state = status.state,
                        progressMessage = status.progress?.message,
                        lastSyncAt = status.lastSyncAt,
                    ),
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

private fun enabledState() = PhotosViewModel.UiState(
    enabled = true,
    access = PhotosAccess.FULL,
    hasPermission = true,
    syncing = false,
    lastResult = PhotosSyncCoordinator.SyncResult.Success(42),
)

@Preview(name = "Photos settings · disabled · light", showBackground = true)
@Composable
private fun PhotosSettingsDisabledLight() {
    OmnesisTheme(darkTheme = false) {
        PhotosSettingsSectionContent(PhotosViewModel.UiState(), {}, {}, {}, {})
    }
}

@Preview(name = "Photos settings · permanently denied · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun PhotosSettingsPermanentlyDeniedDark() {
    OmnesisTheme(darkTheme = true) {
        PhotosSettingsSectionContent(PhotosViewModel.UiState(), {}, {}, {}, {}, permanentlyDenied = true)
    }
}

@Preview(name = "Photos settings · enabled · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun PhotosSettingsEnabledDark() {
    OmnesisTheme(darkTheme = true) {
        PhotosSettingsSectionContent(enabledState(), {}, {}, {}, {})
    }
}

@Preview(name = "Photos settings · syncing · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun PhotosSettingsSyncingDark() {
    OmnesisTheme(darkTheme = true) {
        PhotosSettingsSectionContent(enabledState().copy(syncing = true), {}, {}, {}, {})
    }
}

@Preview(name = "Photos settings · permission revoked · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun PhotosSettingsNoPermissionDark() {
    OmnesisTheme(darkTheme = true) {
        PhotosSettingsSectionContent(enabledState().copy(access = PhotosAccess.DENIED, hasPermission = false), {}, {}, {}, {})
    }
}

@Preview(name = "Photos settings · error · dark", showBackground = true, backgroundColor = 0xFF0D1117)
@Composable
private fun PhotosSettingsErrorDark() {
    OmnesisTheme(darkTheme = true) {
        PhotosSettingsSectionContent(
            enabledState().copy(lastResult = PhotosSyncCoordinator.SyncResult.NeedsAttention("authentication failed")),
            {}, {}, {}, {},
        )
    }
}

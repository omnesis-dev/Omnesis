// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Watch
import androidx.compose.material.icons.outlined.WatchOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.wear.WatchLink

/** The Watch section bound to the app's state; draws nothing on a phone without a Wearable Data Layer. */
@Composable
fun WatchSettingsSection(vm: WatchSettingsViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    val microphone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        vm.onMicrophoneAnswered(it)
    }
    state?.let {
        Spacer(Modifier.height(OmSpacing.md))
        WatchSection(
            state = it,
            onSetDecisionGate = vm::setDecisionGate,
            onEnableTranscription = { microphone.launch(Manifest.permission.RECORD_AUDIO) },
            onRetryRecordings = vm::retryRecordings,
        )
    }
}

/**
 * The Wear OS watch as the phone serves it: whether a watch running Omnesis is in reach, whether
 * one Send button leaves the question-or-note decision to the gateway, and what the phone needs
 * to transcribe a recording itself. The decision gate is a gateway setting shared by every watch.
 */
@Composable
internal fun WatchSection(
    state: WatchSettingsState,
    onSetDecisionGate: (Boolean) -> Unit,
    onEnableTranscription: () -> Unit,
    onRetryRecordings: () -> Unit,
) {
    val c = OmTheme.colors
    SectionLabel("Watch")
    OmnesisCard(padding = OmSpacing.lg) {
        WatchLinkRow(state.link)
        state.decisionGate?.let { gate ->
            RowDivider()
            Row(
                Modifier
                    .fillMaxWidth()
                    .toggleable(
                        value = gate.enabled,
                        enabled = gate.canChange && !gate.saving,
                        role = Role.Switch,
                        onValueChange = onSetDecisionGate,
                    ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Use decision gate for watch capture",
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
                if (gate.saving) {
                    OmSpinner(modifier = Modifier.size(16.dp).padding(end = OmSpacing.xs), strokeWidth = 2.dp)
                }
                Switch(
                    checked = gate.enabled,
                    onCheckedChange = null,
                    enabled = gate.canChange && !gate.saving,
                    modifier = Modifier.scale(0.78f),
                )
            }
            if (gate.needsDecisionModel) {
                Text(
                    "Assign a decision model to use Send. Until then, the watch shows Ask and Tell.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                    modifier = Modifier.padding(vertical = OmSpacing.xs),
                )
            }
        }
        state.error?.let { error ->
            RowDivider()
            Text(
                error,
                style = MaterialTheme.typography.bodySmall,
                color = c.danger,
                modifier = Modifier.padding(vertical = OmSpacing.xs),
            )
        }
        when (val transcription = state.transcription) {
            WatchSettingsState.Transcription.None -> Unit
            is WatchSettingsState.Transcription.NeedsMicrophone -> {
                RowDivider()
                WatchActionRow("Enable phone transcription for watch", onEnableTranscription)
                if (transcription.denied) {
                    Text(
                        "Allow the microphone for Omnesis in Android settings. " +
                            "On-device recognition also needs your language installed.",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.danger,
                        modifier = Modifier.padding(vertical = OmSpacing.xs),
                    )
                }
            }
            is WatchSettingsState.Transcription.Waiting -> {
                RowDivider()
                WatchActionRow(
                    if (transcription.recordings == 1) {
                        "Retry 1 waiting recording"
                    } else {
                        "Retry ${transcription.recordings} waiting recordings"
                    },
                    onRetryRecordings,
                )
            }
        }
    }
    Spacer(Modifier.height(OmSpacing.sm))
    Text(
        "Speak from the Omnesis tile or complication, then tap once to send. " +
            "When gateway transcription is off, this phone transcribes on-device with vocabulary hints. " +
            "No live transcript appears on the watch.",
        style = MaterialTheme.typography.labelMedium,
        color = c.textSecondary,
    )
}

@Composable
private fun WatchLinkRow(link: WatchLink) {
    val c = OmTheme.colors
    val (icon, tint, title, detail) = when (link) {
        WatchLink.NoWatch -> LinkRow(Icons.Outlined.WatchOff, c.textMuted, "No watch connected", null)
        is WatchLink.AppMissing -> LinkRow(
            Icons.Outlined.Watch,
            c.warning,
            "Omnesis isn't on ${link.watchName}",
            "Install Omnesis on the watch from the Play Store.",
        )
        is WatchLink.Connected -> LinkRow(Icons.Outlined.CheckCircle, c.success, "Connected to ${link.watchName}", null)
    }
    Row(Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(OmSpacing.sm))
        androidx.compose.foundation.layout.Column {
            Text(title, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textSecondary) }
        }
    }
}

private data class LinkRow(
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
    val tint: androidx.compose.ui.graphics.Color,
    val title: String,
    val detail: String?,
)

@Composable
private fun WatchActionRow(label: String, onClick: () -> Unit) {
    Text(
        label,
        style = MaterialTheme.typography.bodyMedium,
        color = OmTheme.colors.accent,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = OmSpacing.xs),
    )
}

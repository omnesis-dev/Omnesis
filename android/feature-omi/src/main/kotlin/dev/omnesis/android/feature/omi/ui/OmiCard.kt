// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.feature.omi.OmiLink
import dev.omnesis.android.feature.omi.OmiLinkService
import dev.omnesis.android.feature.omi.OmiPairing
import dev.omnesis.android.feature.omi.OmiStatus
import dev.omnesis.android.feature.recording.RecordingSettings
import dev.omnesis.android.feature.recording.ui.RecordingAvailability
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update

data class OmiCardState(
    val status: OmiStatus = OmiStatus.NotPaired,
    val associating: Boolean = false,
    val error: String? = null,
    /** The pendant captures all day, and a tap marks a moment. */
    val alwaysOn: Boolean = false,
)

@HiltViewModel
class OmiViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val link: OmiLink,
    private val pairing: OmiPairing,
    private val settings: RecordingSettings,
    availability: RecordingAvailability,
) : ViewModel() {
    /** Whether the gateway takes recordings: the pendant is only offered when it does. */
    val recordingsAvailable: StateFlow<Boolean> = availability.state
        .map { it != RecordingAvailability.Availability.UNAVAILABLE }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    private val local = MutableStateFlow(OmiCardState())
    val state: StateFlow<OmiCardState> = combine(link.status, settings.alwaysOn, local) { status, alwaysOn, l ->
        l.copy(status = status, alwaysOn = alwaysOn)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, OmiCardState(status = link.status.value, alwaysOn = settings.alwaysOn.value))

    /** Turn all-day capture on or off; the link service starts or stops the episodes. */
    fun setAlwaysOn(on: Boolean) = settings.setAlwaysOn(on)

    init {
        // The screen opening brings the link back after the app was stopped.
        if (link.status.value != OmiStatus.NotPaired && link.hasPermission()) {
            pairing.observeStored()
            OmiLinkService.start(context)
        }
    }

    fun onPermission(granted: Boolean, launch: (IntentSenderRequest) -> Unit) {
        if (!granted) {
            local.update { it.copy(error = "Nearby devices access is needed to link the pendant.") }
            return
        }
        local.update { it.copy(associating = true, error = null) }
        pairing.request(
            onChooser = { launch(IntentSenderRequest.Builder(it).build()) },
            onError = { message -> local.update { it.copy(associating = false, error = message) } },
        )
    }

    fun onChosen(resultCode: Int, data: android.content.Intent?) {
        local.update { it.copy(associating = false) }
        if (resultCode != Activity.RESULT_OK || !pairing.complete(data)) return
        link.associated()
        OmiLinkService.start(context)
    }

    val details = link.details

    fun refreshDetails() = link.refreshDetails()

    fun find() = link.find()

    fun forget() {
        OmiLinkService.stop(context)
        pairing.disassociate()
        link.forgotten()
    }
}

/** The pendant's card in Settings: associate it, see its state and details, forget it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OmiCard(vm: OmiViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val details by vm.details.collectAsStateWithLifecycle()
    var showDetails by rememberSaveable { mutableStateOf(false) }
    if (showDetails) {
        ModalBottomSheet(onDismissRequest = { showDetails = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            OmiDetailsContent(state.status, details, onFind = vm::find)
        }
    }
    val chooser = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        vm.onChosen(result.resultCode, result.data)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        vm.onPermission(granted) { chooser.launch(it) }
    }
    OmiCardContent(
        state = state,
        onAlwaysOn = vm::setAlwaysOn,
        onAssociate = {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                permission.launch(Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                vm.onPermission(true) { chooser.launch(it) }
            }
        },
        onForget = vm::forget,
        onDetails = {
            vm.refreshDetails()
            showDetails = true
        },
    )
}

/** Stateless, for the screenshot tests. */
@Composable
fun OmiCardContent(
    state: OmiCardState,
    onAssociate: () -> Unit,
    onForget: () -> Unit,
    onDetails: () -> Unit = {},
    onAlwaysOn: (Boolean) -> Unit = {},
) {
    val c = OmTheme.colors
    OmnesisCard(padding = OmSpacing.lg) {
        when (val status = state.status) {
            OmiStatus.NotPaired -> {
                Text(
                    "Record from an Omi you wear. A tap on the pendant starts a recording, confirmed by one short " +
                        "vibration; another tap stops it, with two.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                )
                Spacer(Modifier.height(OmSpacing.sm))
                Text(
                    "Disconnect the pendant from the Omi app first: that app sends its audio to its own service, " +
                        "and the pendant takes one connection at a time.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                )
                Spacer(Modifier.height(OmSpacing.md))
                OutlinedButton(onClick = onAssociate, enabled = !state.associating, modifier = Modifier.fillMaxWidth()) {
                    Text(if (state.associating) "Looking for the pendant…" else "Link an Omi")
                }
            }
            else -> {
                StatusRow(status)
                Spacer(Modifier.height(OmSpacing.xs))
                Text(
                    detail(status, state.alwaysOn),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (status is OmiStatus.Unsupported) c.danger else c.textMuted,
                )
                Spacer(Modifier.height(OmSpacing.md))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Capture all day", style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
                        Text(
                            "Every conversation the pendant hears is recorded, one recording per conversation. " +
                                "A tap marks a moment: about 30 seconds before it and what follows, up to the next " +
                                "pause, are saved as a note.",
                            style = MaterialTheme.typography.bodySmall,
                            color = c.textMuted,
                        )
                    }
                    Spacer(Modifier.width(OmSpacing.sm))
                    Switch(checked = state.alwaysOn, onCheckedChange = onAlwaysOn)
                }
                Spacer(Modifier.height(OmSpacing.sm))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(onClick = onDetails) { Text("Details") }
                    Spacer(Modifier.width(OmSpacing.sm))
                    TextButton(onClick = onForget) { Text("Forget this pendant") }
                }
            }
        }
        state.error?.let {
            Spacer(Modifier.height(OmSpacing.sm))
            Text(it, style = MaterialTheme.typography.bodySmall, color = c.danger)
        }
    }
}

@Composable
private fun StatusRow(status: OmiStatus, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, modifier = modifier) {
        val dot = when (status) {
            is OmiStatus.Ready -> c.success
            is OmiStatus.Unsupported -> c.danger
            else -> c.textMuted
        }
        androidx.compose.foundation.layout.Box(Modifier.size(10.dp).background(dot, CircleShape))
        Spacer(Modifier.width(OmSpacing.sm))
        Text(
            OmiLinkService.statusLine(status),
            style = MaterialTheme.typography.bodyMedium,
            color = c.textPrimary,
            modifier = Modifier.weight(1f),
        )
        if (status is OmiStatus.Ready) {
            Icon(
                if (status.encrypted) Icons.Outlined.Lock else Icons.Outlined.LockOpen,
                contentDescription = if (status.encrypted) "Encrypted link" else "Link not encrypted",
                tint = if (status.encrypted) c.textMuted else c.danger,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

private fun detail(status: OmiStatus, alwaysOn: Boolean): String = when (status) {
    is OmiStatus.Ready -> when {
        !status.encrypted -> "The link is not encrypted: pairing did not complete. Forget the pendant and link it again."
        alwaysOn -> "Capturing all day. Tap the pendant to mark a moment."
        status.canMute -> "Tap the pendant to start or stop a recording. Between recordings its microphone is off."
        else ->
            "Tap the pendant to start or stop a recording. Its firmware cannot switch the microphone off: " +
                "while linked it discards what it hears, but away from the phone it keeps audio on itself. " +
                "Update the firmware to turn the microphone off between recordings."
    }
    OmiStatus.Connecting -> "Linking and checking the pendant."
    OmiStatus.Disconnected -> "Switch the pendant on or bring it closer. It links again on its own."
    is OmiStatus.Unsupported ->
        "This pendant's firmware sends audio in a format Omnesis does not read (${status.codec ?: "unknown"}). Update the firmware."
    OmiStatus.NotPaired -> ""
}

/**
 * The pendant's section in Settings, beside the watch: link it, see its state
 * and details, forget it. Shown while the gateway takes recordings, and while
 * a pendant is linked so it can always be forgotten.
 */
@Composable
fun OmiSettingsSection(vm: OmiViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val available by vm.recordingsAvailable.collectAsStateWithLifecycle()
    if (!available && state.status == OmiStatus.NotPaired) return
    Spacer(Modifier.height(OmSpacing.md))
    Text(
        "OMI PENDANT",
        style = MaterialTheme.typography.labelMedium,
        color = OmTheme.colors.textSecondary,
        modifier = Modifier.padding(top = OmSpacing.sm, bottom = OmSpacing.xs),
    )
    OmiCard(vm)
}

/** The pendant on the Recordings screen: its state in one line, managed in Settings. */
@Composable
fun OmiRecordingRow(onOpenSettings: () -> Unit, vm: OmiViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    OmiRecordingRowContent(state.status, onOpenSettings)
}

@Composable
fun OmiRecordingRowContent(status: OmiStatus, onOpenSettings: () -> Unit) {
    val c = OmTheme.colors
    OmnesisCard(padding = OmSpacing.md) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (status == OmiStatus.NotPaired) {
                Text(
                    "Record from an Omi pendant you wear.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onOpenSettings) { Text("Link in Settings") }
            } else {
                StatusRow(status, Modifier.weight(1f))
                TextButton(onClick = onOpenSettings) { Text("Manage") }
            }
        }
    }
}

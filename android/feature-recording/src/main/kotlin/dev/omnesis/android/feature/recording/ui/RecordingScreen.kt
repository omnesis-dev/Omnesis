// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.ui.draw.clip
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.omnesis.android.designsystem.theme.OmRadius
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.feature.recording.RecordingInput
import dev.omnesis.android.feature.recording.RecordingState

/** Record an in-person conversation with the phone on the table (experimental). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordingScreen(
    onOpenMenu: () -> Unit,
    /** The wearable's status, supplied by the module that links it, shown below the recorder. */
    wearableCard: (@Composable () -> Unit)? = null,
    onOpenSpeakers: (id: String, title: String) -> Unit,
    vm: RecordingViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    // Back from naming speakers, the counts on the list are fresh.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refreshGatewayRecent() }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        // The notification is how recording is shown and stopped; recording
        // still starts without it, and the system lists the running service.
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        vm.onMicPermission(granted)
        if (granted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    Scaffold(
        containerColor = OmTheme.colors.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Recordings") },
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Outlined.Menu, contentDescription = "Menu")
                    }
                },
            )
        },
    ) { padding ->
        RecordingContent(
            state = state,
            onTitleChange = vm::onTitleChange,
            onStart = {
                if (state.startInput == RecordingInput.WEARABLE) vm.startWearable() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
            },
            onInputChange = vm::onInputChange,
            onPause = vm::pause,
            onResume = vm::resume,
            onStop = vm::stop,
            onWifiOnlyChange = vm::onWifiOnlyChange,
            onDelete = vm::delete,
            onDismissError = vm::dismissDeleteError,
            wearableCard = wearableCard,
            onOpenRecording = { onOpenSpeakers(it.id, it.title) },
            onRetryGatewayRecent = vm::refreshGatewayRecent,
            modifier = Modifier.padding(padding),
        )
    }
}

/**
 * The screen's content, taking its state as arguments so a screenshot test
 * renders every state without a service, a microphone or a gateway. Paints
 * its own background (see `WatchesContent`).
 */
@Composable
fun RecordingContent(
    state: RecordingUiState,
    onTitleChange: (String) -> Unit,
    onStart: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
    onWifiOnlyChange: (Boolean) -> Unit,
    onDelete: (String) -> Unit,
    onDismissError: () -> Unit,
    onOpenRecording: (GatewayRecording) -> Unit,
    onRetryGatewayRecent: () -> Unit,
    modifier: Modifier = Modifier,
    onInputChange: (RecordingInput) -> Unit = {},
    wearableCard: (@Composable () -> Unit)? = null,
) {
    val c = OmTheme.colors
    LazyColumn(
        modifier = modifier.fillMaxSize().background(c.bgPrimary),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(OmSpacing.lg),
    ) {
        val recording = state.recording
        if (recording != null) {
            item { RecorderCard(recording, state.elapsedMs, state.wearableName, onPause, onResume, onStop) }
        }
        // While a wearable captures all day, a recording can still be started: it takes the episode's place.
        if (recording == null || recording.ambient) {
            item {
                if (state.availability == RecordingAvailability.Availability.AVAILABLE) {
                    StartCard(state, onTitleChange, onStart, onInputChange, onWifiOnlyChange)
                } else {
                    UnavailableCard(state.availability)
                }
            }
        }
        if (wearableCard != null && state.availability == RecordingAvailability.Availability.AVAILABLE) {
            item { wearableCard() }
        }
        state.deleteError?.let { message ->
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(message, color = c.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = onDismissError) { Text("Dismiss") }
                }
            }
        }
        if (state.recent.isNotEmpty()) {
            item {
                Text(
                    "On this phone",
                    style = MaterialTheme.typography.titleSmall,
                    color = c.textSecondary,
                    modifier = Modifier.padding(top = OmSpacing.sm),
                )
            }
            items(state.recent, key = { it.id }) { recent -> RecentRow(recent, onDelete) }
        }
        val gateway = state.gatewayRecent
        if (gateway !is GatewayRecent.Hidden) {
            item {
                Text(
                    "Recent recordings",
                    style = MaterialTheme.typography.titleSmall,
                    color = c.textSecondary,
                    modifier = Modifier.padding(top = OmSpacing.sm),
                )
            }
            when (gateway) {
                GatewayRecent.Loading -> item { QuietLine("Loading recent recordings…") }
                GatewayRecent.Failed -> item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        QuietLine("Recent recordings could not be loaded.", Modifier.weight(1f))
                        TextButton(onClick = onRetryGatewayRecent) { Text("Retry") }
                    }
                }
                is GatewayRecent.Loaded -> if (gateway.recordings.isEmpty()) {
                    item { QuietLine("No recordings on the gateway yet.") }
                } else {
                    items(gateway.recordings, key = { "gateway-${it.id}" }) { recording ->
                        GatewayRecordingRow(recording, onOpenRecording)
                    }
                }
                GatewayRecent.Hidden -> Unit
            }
        }
    }
}

@Composable
private fun QuietLine(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textMuted, modifier = modifier)
}

@Composable
private fun GatewayRecordingRow(recording: GatewayRecording, onOpen: (GatewayRecording) -> Unit) {
    val c = OmTheme.colors
    OmnesisCard(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(OmRadius.large)).clickable { onOpen(recording) }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.RecordVoiceOver, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(OmSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    recording.title,
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${recording.when_} · ${gatewayStateLine(recording.state)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                speakersLine(recording)?.let { line ->
                    Text(
                        line,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (recording.namedSpeakers < recording.speakers) c.accent else c.textSecondary,
                        maxLines = 1,
                    )
                }
            }
            Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(20.dp))
        }
    }
}

internal fun gatewayStateLine(state: String): String = when (state) {
    "recording" -> "Recording"
    "transcribing" -> "Transcribing"
    "done" -> "Transcribed"
    else -> state.replaceFirstChar { it.uppercase() }
}

/** "2 of 3 speakers named", or null when the gateway did not tell speakers apart. */
internal fun speakersLine(recording: GatewayRecording): String? = when {
    recording.speakers <= 0 -> null
    recording.namedSpeakers >= recording.speakers ->
        if (recording.speakers == 1) "1 speaker named" else "All ${recording.speakers} speakers named"
    else -> "${recording.namedSpeakers} of ${recording.speakers} ${if (recording.speakers == 1) "speaker" else "speakers"} named"
}

@Composable
private fun StartCard(
    state: RecordingUiState,
    onTitleChange: (String) -> Unit,
    onStart: () -> Unit,
    onInputChange: (RecordingInput) -> Unit,
    onWifiOnlyChange: (Boolean) -> Unit,
) {
    val c = OmTheme.colors
    val wearable = state.wearableName
    OmnesisCard(padding = OmSpacing.lg) {
        Text("Record a conversation", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Spacer(Modifier.height(OmSpacing.xs))
        Text(
            if (state.startInput == RecordingInput.WEARABLE) {
                "Records from the $wearable you are wearing. It keeps recording with the phone's screen off, " +
                    "uploads as it goes, and the gateway turns the conversation into a searchable transcript."
            } else {
                "Put the phone on the table. It keeps recording with the screen off, uploads as it goes, " +
                    "and the gateway turns the conversation into a searchable transcript."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = c.textSecondary,
        )
        if (wearable != null && state.wearableReady) {
            Spacer(Modifier.height(OmSpacing.md))
            Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                FilterChip(
                    selected = state.startInput == RecordingInput.PHONE,
                    onClick = { onInputChange(RecordingInput.PHONE) },
                    leadingIcon = if (state.startInput == RecordingInput.PHONE) {
                        { Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(18.dp)) }
                    } else {
                        null
                    },
                    label = { Text("Phone microphone") },
                )
                FilterChip(
                    selected = state.startInput == RecordingInput.WEARABLE,
                    onClick = { onInputChange(RecordingInput.WEARABLE) },
                    leadingIcon = if (state.startInput == RecordingInput.WEARABLE) {
                        { Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(18.dp)) }
                    } else {
                        null
                    },
                    label = { Text(wearable) },
                )
            }
            Spacer(Modifier.height(OmSpacing.xs))
            Text(
                "Start records from the input selected here. A tap on the $wearable always records from the $wearable.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textMuted,
            )
        }
        Spacer(Modifier.height(OmSpacing.md))
        OutlinedTextField(
            value = state.title,
            onValueChange = onTitleChange,
            label = { Text("Title (optional)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(OmSpacing.sm))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Upload on Wi-Fi only", style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
                Text(
                    "Recording continues offline; parts upload once connected.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                )
            }
            Switch(checked = state.wifiOnly, onCheckedChange = onWifiOnlyChange)
        }
        if (state.micDenied) {
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                "Microphone access is needed to record. Allow it, then start again.",
                style = MaterialTheme.typography.bodySmall,
                color = c.danger,
            )
        }
        Spacer(Modifier.height(OmSpacing.md))
        Button(onClick = onStart, enabled = !state.starting, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Outlined.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(OmSpacing.sm))
            Text(if (state.starting) "Starting…" else "Start recording")
        }
        Spacer(Modifier.height(OmSpacing.sm))
        Text(
            "Let everyone know you are recording.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textMuted,
        )
    }
}

@Composable
private fun RecorderCard(
    recording: RecordingState.Active,
    elapsedMs: Long,
    wearableName: String?,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
) {
    val c = OmTheme.colors
    OmnesisCard(padding = OmSpacing.lg) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(10.dp)
                    .background(if (recording.paused) c.textMuted else c.danger, CircleShape),
            )
            Spacer(Modifier.width(OmSpacing.sm))
            Text(
                when {
                    recording.paused -> "Paused"
                    recording.ambient -> "Capturing conversations with the ${wearableName ?: "wearable"}"
                    recording.input == RecordingInput.WEARABLE -> "Recording with the ${wearableName ?: "wearable"}"
                    else -> "Recording"
                },
                style = MaterialTheme.typography.labelLarge,
                color = c.textSecondary,
            )
        }
        Spacer(Modifier.height(OmSpacing.md))
        Text(
            formatElapsed(elapsedMs),
            style = MaterialTheme.typography.displayMedium.copy(
                fontSize = 48.sp,
                fontWeight = FontWeight.Light,
                fontFeatureSettings = "tnum",
            ),
            color = c.textPrimary,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        recording.title?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodyMedium,
                color = c.textSecondary,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (recording.micLost) {
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                if (recording.input == RecordingInput.WEARABLE) {
                    "The ${wearableName ?: "wearable"} is not connected. Recording resumes when it is back."
                } else {
                    "The microphone is in use by another app. Resume to try again."
                },
                style = MaterialTheme.typography.bodySmall,
                color = c.danger,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (recording.ambient) {
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                "This conversation is kept until three minutes pass without speech; the next starts on its own. " +
                    "Tap the ${wearableName ?: "wearable"} to mark a moment.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(OmSpacing.xs))
        Text(
            "${recording.chunks} ${if (recording.chunks == 1) "part" else "parts"} saved · the screen can turn off",
            style = MaterialTheme.typography.bodySmall,
            color = c.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(OmSpacing.lg))
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            OutlinedButton(onClick = if (recording.paused) onResume else onPause, modifier = Modifier.weight(1f)) {
                Icon(
                    if (recording.paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(OmSpacing.xs))
                Text(if (recording.paused) "Resume" else "Pause")
            }
            Button(
                onClick = onStop,
                colors = ButtonDefaults.buttonColors(containerColor = c.danger, contentColor = Color.White),
                modifier = Modifier.weight(1f),
            ) {
                Icon(Icons.Outlined.Stop, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(OmSpacing.xs))
                // Stopping an episode turns all-day capture off: the next would open at once.
                Text(if (recording.ambient) "Turn off" else "Stop")
            }
        }
    }
}

@Composable
private fun UnavailableCard(availability: RecordingAvailability.Availability) {
    val c = OmTheme.colors
    OmnesisCard(padding = OmSpacing.lg) {
        Text("Recording is not available", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Spacer(Modifier.height(OmSpacing.xs))
        Text(
            when (availability) {
                RecordingAvailability.Availability.TRANSCRIPTION_OFF ->
                    "Gateway transcription is switched off. Turn it on in the gateway's settings to record conversations."
                else ->
                    "This gateway does not take recordings. It needs experimental mode and an assigned transcriber."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = c.textSecondary,
        )
    }
}

@Composable
private fun RecentRow(recent: RecentRecording, onDelete: (String) -> Unit) {
    val c = OmTheme.colors
    OmnesisCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val (icon, tint) = when (recent.status) {
                is RecentRecording.Status.Uploading -> Icons.Outlined.CloudUpload to c.accent
                RecentRecording.Status.Sent -> Icons.Outlined.CloudDone to c.success
                is RecentRecording.Status.Refused -> Icons.Outlined.ErrorOutline to c.danger
            }
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(OmSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    recent.title,
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${recent.when_} · ${statusLine(recent.status)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = { onDelete(recent.id) }) {
                Icon(Icons.Outlined.Delete, contentDescription = "Delete recording", tint = c.textMuted)
            }
        }
    }
}

internal fun statusLine(status: RecentRecording.Status): String = when (status) {
    is RecentRecording.Status.Uploading -> when (status.partsLeft) {
        0 -> "Waiting to upload"
        1 -> "Uploading, 1 part left"
        else -> "Uploading, ${status.partsLeft} parts left"
    }
    RecentRecording.Status.Sent -> "Sent; the gateway transcribes it"
    is RecentRecording.Status.Refused -> "Not sent: ${status.reason}"
}

/** `m:ss`, or `h:mm:ss` from the first hour. */
internal fun formatElapsed(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

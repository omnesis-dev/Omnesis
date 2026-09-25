// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MicOff
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.ui.common.landingPalette
import dev.omnesis.android.ui.common.LandingMicUnavailableGlyph
import dev.omnesis.android.ui.common.LandingMicGlyph
import dev.omnesis.android.ui.common.LandingMicRings
import dev.omnesis.android.ui.common.LandingBackdrop
import dev.omnesis.android.ui.common.LANDING_MIC_CENTRE_Y
import androidx.compose.material3.TopAppBarDefaults
import dev.omnesis.android.notes.QueueReason
import kotlinx.coroutines.delay

/**
 * "Tell Omnesis" quick capture: opens listening (once the mic permission
 * resolves), streams the transcript into an editable field, and saves to the
 * gateway — or the durable offline queue — with the launching surface's slug.
 */
@Composable
fun CaptureScreen(
    onClose: () -> Unit,
    vm: CaptureViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> vm.onMicPermission(granted) }

    fun micGranted() = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED

    // Dictation starts as soon as the screen opens; the runtime prompt fires
    // first when the permission hasn't been granted yet.
    LaunchedEffect(Unit) {
        if (micGranted()) vm.onMicPermission(true) else permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    // Linger on the confirmation just long enough to read it, then close.
    val save = state.save
    LaunchedEffect(save) {
        if (save is SaveState.Done) {
            delay(1200)
            onClose()
        }
    }

    CaptureContent(
        state = state,
        onMicTap = {
            when (state.speech) {
                SpeechState.LISTENING -> vm.stopListening()
                SpeechState.IDLE -> vm.startListening()
                // A tap on the muted mic re-asks; the system remembers a hard denial.
                SpeechState.DENIED -> permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                // Neither has an in-app remedy: the language pack is installed
                // from system settings, which no public intent can deep-link to.
                SpeechState.LANGUAGE_NOT_DOWNLOADED, SpeechState.UNAVAILABLE -> Unit
            }
        },
        onTextChange = vm::onTextEdited,
        onSave = vm::save,
        onCancel = onClose,
        onDismissError = vm::dismissError,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaptureContent(
    state: CaptureUiState,
    onMicTap: () -> Unit,
    onTextChange: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    onDismissError: () -> Unit,
) {
    val c = OmTheme.colors
    // The same wash the agent landing screen sits on, with the halo centred on the
    // mic — this surface is its sibling: one calm screen with a single glowing
    // subject in the middle. Behind the Scaffold, and the Scaffold's own chrome is
    // transparent, so it is one continuous screen rather than a wash starting below
    // an app bar with its own container colour.
    Box(Modifier.fillMaxSize()) {
        LandingBackdrop(Modifier.matchParentSize(), focusY = LANDING_MIC_CENTRE_Y)
        Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.Outlined.Close, contentDescription = "Cancel", tint = c.accent)
                    }
                },
                title = { Text("Tell Omnesis") },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = Color.Transparent,
                    titleContentColor = c.textPrimary,
                ),
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (val save = state.save) {
                is SaveState.Done -> SavedConfirmation(queued = save.queued)
                else -> CaptureForm(
                    state = state,
                    saving = save is SaveState.Saving,
                    onMicTap = onMicTap,
                    onTextChange = onTextChange,
                    onSave = onSave,
                    onCancel = onCancel,
                    onDismissError = onDismissError,
                )
            }
        }
    }
    }
}

@Composable
private fun CaptureForm(
    state: CaptureUiState,
    saving: Boolean,
    onMicTap: () -> Unit,
    onTextChange: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    onDismissError: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(OmSpacing.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(OmSpacing.lg))
        MicVisual(speech = state.speech, onTap = onMicTap)
        Spacer(Modifier.height(OmSpacing.md))
        Text(
            statusLine(state.speech),
            style = MaterialTheme.typography.bodySmall,
            color = when (state.speech) {
                SpeechState.LISTENING -> c.accent
                // The only status line that is an instruction to act on rather
                // than an aside, so it carries readable weight.
                SpeechState.LANGUAGE_NOT_DOWNLOADED -> c.textSecondary
                else -> c.textMuted
            },
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(OmSpacing.lg))

        OutlinedTextField(
            value = state.textWithPartial(),
            onValueChange = onTextChange,
            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
            placeholder = {
                Text("What should Omnesis remember?", color = c.textMuted)
            },
            enabled = !saving,
            shape = RoundedCornerShape(20.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = c.accent,
                // The agent composer's rim: blue-gray, not the neutral hairline a
                // Material field would draw on an opaque card.
                unfocusedBorderColor = landingPalette.composerRim,
                focusedContainerColor = landingPalette.composerFill,
                unfocusedContainerColor = landingPalette.composerFill,
                disabledContainerColor = landingPalette.composerFill,
                focusedTextColor = c.textPrimary,
                unfocusedTextColor = c.textPrimary,
                // The field is disabled while saving; keep the note legible
                // instead of letting it wash out to the disabled gray.
                disabledTextColor = c.textPrimary,
                disabledBorderColor = landingPalette.composerRim,
                cursorColor = c.accent,
            ),
        )

        val save = state.save
        if (save is SaveState.Failed) {
            Spacer(Modifier.height(OmSpacing.md))
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(OmRadius.medium))
                    .background(c.warning.copy(alpha = 0.12f))
                    .padding(OmSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = c.warning, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    save.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(10.dp))
                IconButton(onClick = onDismissError, modifier = Modifier.size(20.dp)) {
                    Icon(Icons.Outlined.Close, contentDescription = "Dismiss", tint = c.textMuted, modifier = Modifier.size(14.dp))
                }
            }
        }

        Spacer(Modifier.weight(1f))
        Spacer(Modifier.height(OmSpacing.lg))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            TextButton(onClick = onCancel, modifier = Modifier.weight(1f), enabled = !saving) {
                Text("Cancel", color = c.textSecondary)
            }
            Button(
                onClick = onSave,
                modifier = Modifier.weight(2f),
                enabled = state.textWithPartial().isNotBlank() && !saving,
                colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
            ) {
                if (saving) {
                    OmSpinner(modifier = Modifier.size(16.dp), color = Color.White)
                    Spacer(Modifier.width(8.dp))
                    Text("Saving…")
                } else {
                    Text("Tell Omnesis")
                }
            }
        }
    }
}

/**
 * The mic as this screen's subject — lit and breathing while the recogniser is hot,
 * the way the Omnesis mark is lit on the agent landing screen.
 */
@Composable
private fun MicVisual(speech: SpeechState, onTap: () -> Unit) {
    val listening = speech == SpeechState.LISTENING
    val muted = speech != SpeechState.LISTENING && speech != SpeechState.IDLE

    Box(contentAlignment = Alignment.Center) {
        // Outside the tap target, which is clipped to a circle — rings drawn inside
        // it would be cut off as they grew past its edge.
        if (listening) LandingMicRings()
        Box(
            Modifier
                // The glyph is a mic shape, not a disc, so the tap target has to be
                // declared rather than inherited from the artwork.
                .size(88.dp)
                .clip(CircleShape)
                .clickable(
                    onClickLabel = if (listening) "Stop listening" else "Start listening",
                    onClick = onTap,
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (muted) LandingMicUnavailableGlyph() else LandingMicGlyph(listening = listening)
        }
    }
}

/** Post-save confirmation; [queued] null = landed on the gateway, else the queue reason picks the copy. */
@Composable
private fun SavedConfirmation(queued: QueueReason?) {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxSize().padding(OmSpacing.lg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            if (queued != null) Icons.Outlined.CloudOff else Icons.Outlined.CheckCircle,
            contentDescription = null,
            tint = if (queued != null) c.textMuted else c.success,
            modifier = Modifier.size(48.dp),
        )
        Spacer(Modifier.height(OmSpacing.md))
        Text(
            when (queued) {
                null -> "Told Omnesis"
                QueueReason.UNPAIRED -> "Saved on this phone"
                QueueReason.UNREACHABLE -> "Saved on this phone"
                QueueReason.UNAUTHORIZED -> "Saved on this phone"
                QueueReason.FEATURE_OFF -> "Saved on device"
            },
            style = MaterialTheme.typography.titleMedium,
            color = c.textPrimary,
        )
        if (queued != null) {
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                when (queued) {
                    QueueReason.UNPAIRED ->
                        "Pair this phone with your gateway to sync this note."
                    QueueReason.UNREACHABLE ->
                        "The gateway isn't reachable right now — this note will sync automatically."
                    QueueReason.UNAUTHORIZED ->
                        "Pair this phone with your gateway again to sync this note."
                    QueueReason.FEATURE_OFF ->
                        "Update your gateway to sync quick captures."
                },
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
                textAlign = TextAlign.Center,
            )
        }
    }
}

private fun statusLine(speech: SpeechState): String = when (speech) {
    SpeechState.LISTENING -> "Listening…"
    SpeechState.IDLE -> "Tap the mic to talk, or just type"
    SpeechState.DENIED -> "Microphone access is off — type your note, or tap the mic to allow access"
    SpeechState.LANGUAGE_NOT_DOWNLOADED ->
        "Dictation runs on this phone only, and your language's offline speech pack isn't " +
            "installed. Add it in the phone's settings under Speech Services by Google → " +
            "Offline speech recognition. Until then, just type your note."
    SpeechState.UNAVAILABLE -> "Speech recognition isn't available on this device — type your note"
}

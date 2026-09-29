// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.voice

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.voice.DictationFailure

/** A gateway dictation's microphone, as the recording visual shows it. [level] is 0–1. */
data class VoiceRecording(val level: Float, val elapsedMs: Long)

/** A failed gateway transcription and the ways forward the surface can offer. */
data class DictationFailureNotice(
    val message: String,
    /** The recording was kept and can be sent again. */
    val canRetry: Boolean,
    /** The phone's own recognizer can take the dictation instead. */
    val canDictateOnDevice: Boolean,
    /** Only the system's app settings can fix it: the microphone permission was permanently refused. */
    val canOpenSettings: Boolean = false,
) {
    companion object {
        fun of(failure: DictationFailure, onDeviceAvailable: Boolean) =
            DictationFailureNotice(failure.message, failure.retryable, onDeviceAvailable)
    }
}

/** "0:07", "1:32": how long the recording has run. */
fun formatRecordingTime(elapsedMs: Long): String {
    val seconds = (elapsedMs / 1000).coerceAtLeast(0)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

/**
 * A live level meter plus the running time — the recording's only feedback, since
 * gateway dictation shows no words until the transcript arrives. Bars grow from the
 * centre outwards, so a whisper moves the middle bar and full speech lights all of them.
 */
@Composable
fun RecordingMeter(
    recording: VoiceRecording,
    modifier: Modifier = Modifier,
    barHeight: Dp = 22.dp,
    color: Color = OmTheme.colors.accent,
) {
    val level by animateFloatAsState(recording.level.coerceIn(0f, 1f), tween(90), label = "recordingLevel")
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(OmTheme.colors.danger))
        Spacer(Modifier.width(OmSpacing.sm))
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
            BAR_WEIGHTS.forEach { weight ->
                val fraction = (MIN_BAR + (1f - MIN_BAR) * (level * weight).coerceIn(0f, 1f))
                Box(
                    Modifier
                        .width(3.dp)
                        .height(barHeight * fraction)
                        .clip(RoundedCornerShape(2.dp))
                        .background(color),
                )
            }
        }
        Spacer(Modifier.width(OmSpacing.sm))
        Text(
            formatRecordingTime(recording.elapsedMs),
            style = MaterialTheme.typography.labelMedium.merge(TextStyle(fontFeatureSettings = "tnum")),
            color = OmTheme.colors.textSecondary,
        )
    }
}

/** The wait between the end of a recording and its transcript. */
@Composable
fun TranscribingStatus(modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        OmSpinner(modifier = Modifier.size(14.dp), color = OmTheme.colors.accent, strokeWidth = 2.dp)
        Spacer(Modifier.width(OmSpacing.sm))
        Text(
            TRANSCRIBING_LABEL,
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.textSecondary,
        )
    }
}

const val TRANSCRIBING_LABEL = "Transcribing on your gateway…"

/**
 * A failed transcription: what went wrong, then Retry (the recording was kept) and
 * Dictate on this phone. Typing always remains possible, so there is no dead end.
 */
@Composable
fun DictationFailureCard(
    notice: DictationFailureNotice,
    onRetry: () -> Unit,
    onDictateOnDevice: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenSettings: () -> Unit = {},
) {
    val c = OmTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(c.warning.copy(alpha = 0.12f))
            .padding(start = OmSpacing.md, top = OmSpacing.sm, bottom = OmSpacing.xs, end = OmSpacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = c.warning, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Text(
                notice.message,
                style = MaterialTheme.typography.bodySmall,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onDismiss, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Outlined.Close, contentDescription = "Dismiss", tint = c.textMuted, modifier = Modifier.size(14.dp))
            }
        }
        if (notice.canRetry || notice.canDictateOnDevice || notice.canOpenSettings) {
            Row(Modifier.padding(start = 20.dp), horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
                if (notice.canRetry) {
                    TextButton(onClick = onRetry) { Text("Retry", color = c.accent) }
                }
                if (notice.canDictateOnDevice) {
                    TextButton(onClick = onDictateOnDevice) { Text("Dictate on this phone", color = c.accent) }
                }
                if (notice.canOpenSettings) {
                    TextButton(onClick = onOpenSettings) { Text("Open settings", color = c.accent) }
                }
            }
        }
    }
}

/** Heights of the meter's bars relative to the level: tallest in the middle. */
private val BAR_WEIGHTS = listOf(0.55f, 0.8f, 1.0f, 1.25f, 1.0f, 0.8f, 0.55f)
private const val MIN_BAR = 0.18f

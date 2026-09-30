// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.ui.common.landingPalette

/**
 * The voice note in place of the text field: while recording, a live level meter and
 * the running time; once stopped, its length with Record more and Discard. It never
 * shows words — the gateway writes them. Discard turns the capture into a typed note.
 */
@Composable
fun VoiceNoteCard(
    note: VoiceNoteUi,
    enabled: Boolean,
    onRecordMore: () -> Unit,
    onDiscard: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(20.dp)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clip(shape)
            .background(landingPalette.composerFill)
            .border(1.dp, if (note.recording) c.accent else landingPalette.composerRim, shape)
            .padding(start = OmSpacing.lg, end = OmSpacing.xs, top = OmSpacing.sm, bottom = OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .weight(1f)
                .semantics(mergeDescendants = true) {
                    contentDescription = "Voice note, ${spokenDuration(note.elapsedMs)}"
                    stateDescription = if (note.recording) "Recording" else "Recorded"
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (note.recording) {
                LevelMeter(note.level)
            } else {
                Icon(Icons.Outlined.Mic, contentDescription = null, tint = c.accent, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(OmSpacing.md))
            Text(
                "${if (note.recording) "Recording" else "Voice note"} · ${clockDuration(note.elapsedMs)}",
                style = MaterialTheme.typography.bodyMedium.merge(TextStyle(fontFeatureSettings = "tnum")),
                color = c.textPrimary,
            )
        }
        if (!note.recording) {
            TextButton(onClick = onRecordMore, enabled = enabled) { Text("Record more", color = c.accent) }
        }
        TextButton(
            onClick = onDiscard,
            enabled = enabled,
            modifier = Modifier.semantics { contentDescription = "Discard recording" },
        ) { Text("Discard", color = c.textSecondary) }
    }
}

/**
 * Bars that rise with the microphone level, tallest in the middle, so a whisper moves
 * the centre and full speech lights all of them.
 */
@Composable
private fun LevelMeter(level: Float) {
    val c = OmTheme.colors
    val animated by animateFloatAsState(level.coerceIn(0f, 1f), tween(90), label = "voiceNoteLevel")
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(c.danger))
        Spacer(Modifier.width(3.dp))
        BAR_WEIGHTS.forEach { weight ->
            Box(
                Modifier
                    .width(3.dp)
                    .height(22.dp * (MIN_BAR + (1f - MIN_BAR) * (animated * weight).coerceIn(0f, 1f)))
                    .clip(RoundedCornerShape(2.dp))
                    .background(c.accent),
            )
        }
    }
}

/** "0:07", "1:32". */
internal fun clockDuration(elapsedMs: Long): String {
    val seconds = (elapsedMs / 1000).coerceAtLeast(0)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

/** "12 seconds", "1 minute 5 seconds" — the running time as TalkBack reads it. */
internal fun spokenDuration(elapsedMs: Long): String {
    val seconds = (elapsedMs / 1000).coerceAtLeast(0)
    val minutes = seconds / 60
    val rest = seconds % 60
    fun unit(n: Long, word: String) = "$n $word${if (n == 1L) "" else "s"}"
    return when {
        minutes == 0L -> unit(rest, "second")
        rest == 0L -> unit(minutes, "minute")
        else -> "${unit(minutes, "minute")} ${unit(rest, "second")}"
    }
}

private val BAR_WEIGHTS = listOf(0.55f, 0.8f, 1.0f, 1.25f, 1.0f, 0.8f, 0.55f)
private const val MIN_BAR = 0.18f

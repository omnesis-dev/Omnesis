// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import dev.omnesis.android.wear.R
import dev.omnesis.android.wear.core.NoteState
import dev.omnesis.android.wear.core.VoiceNoteState
import dev.omnesis.android.wearprotocol.WearLine
import kotlin.time.Duration

/** The note flow: a standing invitation before anything is captured, then the last note and whether it is on its way. */
@Composable
fun NoteScreen(state: NoteState, actions: WatchActions, modifier: Modifier = Modifier) {
    WatchColumn(modifier, fadesAtEdges = state != NoteState.Idle) {
        when (state) {
            NoteState.Idle -> {
                item {
                    Image(
                        painter = painterResource(R.drawable.ic_note),
                        contentDescription = null,
                        modifier = Modifier.size(32.dp),
                        colorFilter = ColorFilter.tint(WearPalette.Accent),
                    )
                }
                item { Text(WearLine.NOTE_TITLE.text, style = MaterialTheme.typography.title3) }
                item { NewNoteButton(actions) }
            }
            is NoteState.Sent -> settledNote(state.text, sent = true, actions)
            is NoteState.Failed -> settledNote(state.text, sent = false, actions)
        }
    }
}

private fun ScalingLazyListScope.settledNote(
    text: String,
    sent: Boolean,
    actions: WatchActions,
) {
    item {
        if (sent) {
            StatusLabel(
                WearLine.SENT_TO_PHONE.text,
                R.drawable.ic_check_circle,
                WearPalette.Success,
                Modifier.fillMaxWidth(),
            )
        } else {
            StatusLabel(WearLine.COULDNT_SAVE.text, R.drawable.ic_warning, WearPalette.Warning, Modifier.fillMaxWidth())
        }
    }
    item { Text(text = text, modifier = Modifier.fillMaxWidth(), style = MaterialTheme.typography.body2) }
    // A finished note is where the app stays until it is next used, so the
    // next note is one press from it.
    item { NewNoteButton(actions) }
}

@Composable
private fun NewNoteButton(actions: WatchActions) {
    PillButton(
        text = WearLine.NEW_NOTE.text,
        onClick = actions.dictateNote,
        emphasis = ButtonEmphasis.TONAL,
        icon = R.drawable.ic_mic,
    )
}

/**
 * The note recorder and what it ends on: the recording with its elapsed
 * time, the confirmation, a failure, or the notice about notes that were
 * dropped. [elapsed] is how long the recording has run.
 */
@Composable
fun VoiceNoteScreen(state: VoiceNoteState, elapsed: Duration, actions: WatchActions, modifier: Modifier = Modifier) {
    when (state) {
        VoiceNoteState.Idle -> Unit
        is VoiceNoteState.Recording -> VoiceNoteRecording(elapsed, state.limit, actions, modifier)
        is VoiceNoteState.Sent -> Notice(
            icon = R.drawable.ic_check_circle,
            tint = WearPalette.Success,
            title = WearLine.SENT_TO_PHONE.text,
            detail = WearLine.GATEWAY_WILL_TRANSCRIBE.text.takeIf { state.recorded },
            onDismiss = actions.dismissNotice,
            modifier = modifier,
        )
        VoiceNoteState.Failed -> Notice(
            icon = R.drawable.ic_warning,
            tint = WearPalette.Warning,
            title = WearLine.COULDNT_SAVE.text,
            detail = WearLine.RECORDING_NOT_SAVED.text,
            onDismiss = actions.dismissNotice,
            modifier = modifier,
        )
        is VoiceNoteState.Dropped -> DroppedNotice(state.count, actions, modifier)
    }
}

@Composable
private fun VoiceNoteRecording(elapsed: Duration, limit: Duration, actions: WatchActions, modifier: Modifier) {
    val insets = screenInsets(underTime = false)
    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = insets.horizontal),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(WearLine.NOTE_TITLE.text, style = MaterialTheme.typography.title3)
        Spacer(Modifier.height(2.dp))
        StatusLabel(
            text = "${clock(minOf(elapsed, limit))} / ${clock(limit)}",
            icon = R.drawable.ic_waveform,
            color = WearPalette.Recording,
        )
        Spacer(Modifier.height(6.dp))
        PillButton(
            text = WearLine.SEND.text,
            onClick = actions.sendVoiceNote,
            modifier = Modifier.fillMaxWidth(0.86f),
            icon = R.drawable.ic_arrow_up,
            tag = "watchVoiceSend",
        )
        PillButton(WearLine.CANCEL.text, actions.cancelVoiceNote, emphasis = ButtonEmphasis.PLAIN)
    }
}

/** A confirmation or a failure that fills the screen and goes away on a press. */
@Composable
private fun Notice(
    icon: Int,
    tint: Color,
    title: String,
    detail: String?,
    onDismiss: () -> Unit,
    modifier: Modifier,
) {
    val insets = screenInsets(underTime = false)
    Column(
        modifier = modifier
            .fillMaxSize()
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss)
            .padding(horizontal = insets.horizontal),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            painter = painterResource(icon),
            contentDescription = null,
            modifier = Modifier.size(32.dp),
            colorFilter = ColorFilter.tint(tint),
        )
        Spacer(Modifier.height(6.dp))
        Text(title, style = MaterialTheme.typography.title3, textAlign = TextAlign.Center)
        if (detail != null) {
            Spacer(Modifier.height(4.dp))
            Text(
                detail,
                color = WearPalette.SecondaryText,
                style = MaterialTheme.typography.caption1,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun DroppedNotice(count: Int, actions: WatchActions, modifier: Modifier) {
    WatchColumn(modifier, showTime = false) {
        item {
            Image(
                painter = painterResource(R.drawable.ic_warning),
                contentDescription = null,
                modifier = Modifier.size(28.dp),
                colorFilter = ColorFilter.tint(WearPalette.Warning),
            )
        }
        item {
            Text(WearLine.notesNotSent(count), style = MaterialTheme.typography.title3, textAlign = TextAlign.Center)
        }
        item {
            Text(
                WearLine.NOTES_DROPPED_HINT.text,
                color = WearPalette.SecondaryText,
                style = MaterialTheme.typography.caption1,
                textAlign = TextAlign.Center,
            )
        }
        item { PillButton(WearLine.OK.text, actions.dismissNotice, emphasis = ButtonEmphasis.TONAL) }
    }
}

/** A duration as minutes and seconds, such as 0:12. */
internal fun clock(duration: Duration): String {
    val seconds = duration.inWholeSeconds.coerceAtLeast(0)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

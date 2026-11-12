// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import dev.omnesis.android.wear.R
import dev.omnesis.android.wear.core.AskState
import dev.omnesis.android.wear.core.ReadAlong
import dev.omnesis.android.wear.core.SpeakerState
import dev.omnesis.android.wearprotocol.AskActivity
import dev.omnesis.android.wearprotocol.AskActivitySnapshot
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.WearLine

/**
 * The ask flow: a standing invitation before anything is asked, the question
 * and one line of progress while the phone works, then the answer, dimmed
 * past the point the voice has reached when it is read aloud.
 */
@Composable
fun AskScreen(
    state: AskState,
    activity: AskActivitySnapshot?,
    speaker: SpeakerState,
    hintVisible: Boolean,
    actions: WatchActions,
    modifier: Modifier = Modifier,
) {
    when (state) {
        AskState.Idle -> AskIdle(hintVisible, actions, modifier)
        is AskState.Asking -> AskInProgress(state.question, activity, modifier)
        is AskState.Answered -> AskAnswer(state, speaker, actions, modifier)
    }
}

/**
 * The mark and the way in. The buttons stay hidden for a beat after launch:
 * a tile or complication tap opens this app and moves on to the recorder
 * within moments, and an invitation flashed at someone who just accepted it
 * reads as a glitch.
 */
@Composable
private fun AskIdle(hintVisible: Boolean, actions: WatchActions, modifier: Modifier) {
    val shown = if (LocalInspectionMode.current) {
        if (hintVisible) 1f else 0f
    } else {
        val eased by animateFloatAsState(if (hintVisible) 1f else 0f, label = "hint")
        eased
    }
    WatchColumn(modifier, insets = controlBlockInsets()) {
        // The mark and the name share a line, which leaves room for both
        // rows of buttons under them on the smallest display.
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(
                    painter = painterResource(R.drawable.omnesis_mark),
                    contentDescription = null,
                    modifier = Modifier.size(26.dp),
                    colorFilter = ColorFilter.tint(WearPalette.Accent),
                )
                Spacer(Modifier.width(6.dp))
                Text(WearLine.APP_NAME.text, style = MaterialTheme.typography.title3)
            }
        }
        item {
            PillButton(
                text = WearLine.TAP_TO_SPEAK.text,
                onClick = actions.startCapture,
                modifier = Modifier.alpha(shown),
                icon = R.drawable.ic_mic,
                enabled = hintVisible,
            )
        }
        item {
            Row(modifier = Modifier.alpha(shown), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircleIconButton(
                    R.drawable.ic_keyboard,
                    WearLine.TYPE_A_QUESTION.text,
                    actions.enterQuestion,
                    enabled = hintVisible,
                )
                CircleIconButton(R.drawable.ic_note, WearLine.NOTE_TITLE.text, actions.showNotes, enabled = hintVisible)
            }
        }
    }
}

/**
 * The question, and one line saying what is happening to it. Nothing else: a
 * wrist glanced at mid-turn needs to know the ask is alive and what step it
 * is on.
 */
@Composable
private fun AskInProgress(question: String, activity: AskActivitySnapshot?, modifier: Modifier) {
    val insets = screenInsets(underTime = true)
    val statusZone = insets.bottom + STATUS_HEIGHT + 4.dp
    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val questionRoom = maxHeight - insets.top - statusZone
        // The question is centred when it fits and scrolls when it does not:
        // a question longer than the screen would otherwise be clipped for
        // the whole wait.
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(top = insets.top, bottom = statusZone)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.Center,
        ) {
            Box(
                modifier = Modifier.fillMaxWidth().heightIn(min = questionRoom),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = question,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = insets.horizontal * 1.2f),
                    style = MaterialTheme.typography.body1,
                    textAlign = TextAlign.Center,
                )
            }
        }
        StatusLine(
            activity = activity ?: AskActivitySnapshot(AskActivity.fallbackLabel),
            // The line sits where a round screen is already narrowing.
            available = maxWidth - insets.horizontal * 2.6f,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = insets.bottom),
        )
    }
}

/**
 * The status line. It never wraps and never truncates: the whole line when
 * it fits, otherwise the step alone (the count is the part that can go and
 * still say what is happening), and only then smaller type.
 */
@Composable
private fun StatusLine(activity: AskActivitySnapshot, available: Dp, modifier: Modifier = Modifier) {
    val style = MaterialTheme.typography.caption2
    val measurer = rememberTextMeasurer()
    val room = with(LocalDensity.current) { (available - DOTS_WIDTH).toPx() }

    fun fits(text: String, candidate: TextStyle) = measurer.measure(text, candidate, maxLines = 1).size.width <= room

    val small = style.copy(fontSize = 10.sp)
    val (text, chosen) = when {
        fits(activity.line, style) -> activity.line to style
        fits(activity.label, style) -> activity.label to style
        else -> activity.label to small
    }
    Row(
        modifier = modifier.heightIn(min = STATUS_HEIGHT).semantics(mergeDescendants = true) {
            contentDescription = activity.line
        },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ThinkingDots()
        Spacer(Modifier.width(6.dp))
        Text(text = text, color = WearPalette.Accent, style = chosen, maxLines = 1, softWrap = false)
    }
}

/**
 * The settled ask: the answer alone. The question has served its purpose by
 * the time its answer is on screen.
 */
@Composable
private fun AskAnswer(state: AskState.Answered, speaker: SpeakerState, actions: WatchActions, modifier: Modifier) {
    WatchColumn(modifier, fadesAtEdges = true) {
        // An answer needs no label. A problem must not read like one, and
        // neither must a turn still running somewhere else.
        when (state.kind) {
            AskOutcome.Kind.ANSWER -> Unit
            AskOutcome.Kind.STATUS -> item {
                StatusLabel(state.statusTitle, R.drawable.ic_clock, WearPalette.SecondaryText, Modifier.fillMaxWidth())
            }
            AskOutcome.Kind.FAILURE -> item {
                StatusLabel(
                    WearLine.COULDNT_ANSWER.text,
                    R.drawable.ic_warning,
                    WearPalette.Warning,
                    Modifier.fillMaxWidth(),
                )
            }
        }
        item {
            Text(
                text = readAlong(state.text, speaker),
                modifier = Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.body2,
            )
        }
        item {
            // Side by side in the middle, where a round display still has room for both.
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (speaker.isSpeaking) {
                    CircleIconButton(R.drawable.ic_stop, WearLine.STOP.text, actions.stopSpeaking)
                } else {
                    CircleIconButton(R.drawable.ic_speaker, WearLine.SPEAK_ANSWER.text, actions.speakAnswer)
                }
                // A settled answer is where the app stays until it is next
                // used, so the next question is one press from it.
                CircleIconButton(R.drawable.ic_mic, WearLine.ASK_AGAIN.text, actions.askAgain)
            }
        }
    }
}

/** The answer with everything spoken so far at full strength and the rest dimmed, so the text tracks the voice. */
internal fun readAlong(text: String, speaker: SpeakerState): AnnotatedString {
    val split = ReadAlong.split(text, speaker) ?: return AnnotatedString(text, SpanStyle(color = WearPalette.Text))
    return buildAnnotatedString {
        withStyle(SpanStyle(color = WearPalette.Text)) { append(text.substring(0, split)) }
        withStyle(SpanStyle(color = WearPalette.SecondaryText)) { append(text.substring(split)) }
    }
}

private val STATUS_HEIGHT = 18.dp
private val DOTS_WIDTH = 26.dp

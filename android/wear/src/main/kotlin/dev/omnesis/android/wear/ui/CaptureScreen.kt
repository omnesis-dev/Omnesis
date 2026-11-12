// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import dev.omnesis.android.wear.R
import dev.omnesis.android.wear.core.CapturePhase
import dev.omnesis.android.wear.core.CaptureState
import dev.omnesis.android.wearprotocol.CaptureButtons
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.WearLine

/**
 * The unified recorder: the halo over what the microphone is doing, the send
 * buttons, and what became of the recording.
 */
@Composable
fun CaptureScreen(state: CaptureState, reduceMotion: Boolean, actions: WatchActions, modifier: Modifier = Modifier) {
    if (state.phase == CapturePhase.Failed) {
        CaptureFailed(actions, modifier.background(Color.Black))
        return
    }
    val configuration = LocalConfiguration.current
    val haloSize = (configuration.screenHeightDp * HALO_SHARE).dp.coerceIn(MIN_HALO, MAX_HALO)
    Column(
        modifier = modifier.fillMaxSize().background(Color.Black),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CaptureHalo(
            listening = state.phase == CapturePhase.Recording,
            level = state.level,
            size = haloSize,
            reduceMotion = reduceMotion,
        )
        when (val phase = state.phase) {
            CapturePhase.Idle, CapturePhase.Failed -> Unit
            CapturePhase.Preparing -> {
                Headline(WearLine.OPENING_MICROPHONE.text, supporting = true)
                PillButton(WearLine.CANCEL.text, actions.cancelCapture, emphasis = ButtonEmphasis.PLAIN)
            }
            CapturePhase.Recording, CapturePhase.Ready -> {
                Headline(if (phase == CapturePhase.Recording) WearLine.LISTENING.text else WearLine.READY_TO_SEND.text)
                Spacer(Modifier.height(4.dp))
                SendButtons(state.buttons, actions)
                PillButton(WearLine.CANCEL.text, actions.cancelCapture, emphasis = ButtonEmphasis.PLAIN)
            }
            CapturePhase.Saving -> {
                Spacer(Modifier.height(10.dp))
                ThinkingDots()
            }
            is CapturePhase.Sent -> {
                Headline(WearLine.GOT_IT.text)
                Text(
                    text = state.sentLine.orEmpty(),
                    modifier = Modifier.fillMaxWidth(0.8f),
                    color = WearPalette.SecondaryText,
                    style = MaterialTheme.typography.caption1,
                    textAlign = TextAlign.Center,
                )
                PillButton(WearLine.DONE.text, actions.closeCapture, emphasis = ButtonEmphasis.PLAIN)
            }
        }
    }
}

@Composable
private fun Headline(text: String, supporting: Boolean = false) {
    Text(
        text = text,
        color = if (supporting) WearPalette.SecondaryText else WearPalette.Text,
        style = if (supporting) MaterialTheme.typography.caption1 else MaterialTheme.typography.title3,
        textAlign = TextAlign.Center,
    )
}

/** One Send when the phone decides what the recording is; Ask and Tell when the person does; Ask alone for a follow-up. */
@Composable
private fun SendButtons(buttons: CaptureButtons, actions: WatchActions) {
    Row(
        modifier = Modifier.fillMaxWidth(0.84f),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        when (buttons) {
            CaptureButtons.SEND -> SendButton(WearLine.SEND.text, CaptureRoute.AUTOMATIC, actions, Modifier.weight(1f))
            CaptureButtons.ASK_ONLY -> SendButton(WearLine.ASK.text, CaptureRoute.ASK, actions, Modifier.weight(1f))
            CaptureButtons.ASK_AND_TELL -> {
                SendButton(WearLine.ASK.text, CaptureRoute.ASK, actions, Modifier.weight(1f))
                SendButton(WearLine.TELL.text, CaptureRoute.NOTE, actions, Modifier.weight(1f))
            }
            // The recorder reports this instead of recording, so there is nothing to send.
            CaptureButtons.UNSUPPORTED -> Unit
        }
    }
}

@Composable
private fun SendButton(title: String, route: CaptureRoute, actions: WatchActions, modifier: Modifier) {
    PillButton(
        text = title,
        onClick = { actions.sendCapture(route) },
        modifier = modifier,
        tag = "watchCapture-${route.name.lowercase()}",
    )
}

/** The recorder could not record: the phone app cannot take recordings, or the microphone is not available. */
@Composable
private fun CaptureFailed(actions: WatchActions, modifier: Modifier) {
    WatchColumn(modifier, showTime = false) {
        item {
            Image(
                painter = painterResource(R.drawable.omnesis_mark),
                contentDescription = null,
                modifier = Modifier.size(28.dp),
                colorFilter = ColorFilter.tint(WearPalette.Accent),
            )
        }
        item { Headline(WearLine.COULDNT_RECORD.text) }
        item {
            Text(
                text = WearLine.COULDNT_RECORD_HINT.text,
                color = WearPalette.SecondaryText,
                style = MaterialTheme.typography.caption1,
                textAlign = TextAlign.Center,
            )
        }
        item { PillButton(WearLine.TRY_AGAIN.text, actions.retryCapture, emphasis = ButtonEmphasis.TONAL) }
        item { PillButton(WearLine.CANCEL.text, actions.cancelCapture, emphasis = ButtonEmphasis.PLAIN) }
    }
}

private const val HALO_SHARE = 0.31f
private val MIN_HALO = 54.dp
private val MAX_HALO = 96.dp

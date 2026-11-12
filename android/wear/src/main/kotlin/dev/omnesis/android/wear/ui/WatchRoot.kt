// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.ui

import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.BasicSwipeToDismissBox
import dev.omnesis.android.wear.WatchViewModel
import dev.omnesis.android.wear.core.AskState
import dev.omnesis.android.wear.core.CapturePhase
import dev.omnesis.android.wear.core.CaptureState
import dev.omnesis.android.wear.core.NoteState
import dev.omnesis.android.wear.core.SpeakerState
import dev.omnesis.android.wear.core.VoiceNoteState
import dev.omnesis.android.wear.core.WatchScreen
import dev.omnesis.android.wearprotocol.AskActivitySnapshot
import dev.omnesis.android.wearprotocol.CaptureRoute
import kotlinx.coroutines.delay
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds

/** Everything the watch's screens draw. */
data class WatchUiState(
    val screen: WatchScreen = WatchScreen.ASK,
    val ask: AskState = AskState.Idle,
    val activity: AskActivitySnapshot? = null,
    val note: NoteState = NoteState.Idle,
    val capture: CaptureState = CaptureState(),
    val voiceNote: VoiceNoteState = VoiceNoteState.Idle,
    val speaker: SpeakerState = SpeakerState(),
) {
    /** Whether the recorder, the note recorder or the note screen covers the ask screen. */
    val coversAsk: Boolean
        get() = capture.phase != CapturePhase.Idle || voiceNote != VoiceNoteState.Idle || screen == WatchScreen.NOTE

    /**
     * Whether the display should stay awake: the microphone is open, or a
     * typed question is being relayed, which ends within the relay's own time
     * limits. Waiting on a recorded question has no such limit, so it does
     * not hold the display on.
     */
    val keepsScreenOn: Boolean
        get() = capture.phase == CapturePhase.Preparing || capture.phase == CapturePhase.Recording ||
            voiceNote is VoiceNoteState.Recording || ask is AskState.Asking
}

/** Everything the watch's screens can ask for. */
class WatchActions(
    val startCapture: () -> Unit = {},
    val askAgain: () -> Unit = {},
    val sendCapture: (CaptureRoute) -> Unit = {},
    /** Cancel on the recorder, which leaves the app when a tile or complication opened it. */
    val cancelCapture: () -> Unit = {},
    /** Done on a sent recording, which stays in the app. */
    val closeCapture: () -> Unit = {},
    val retryCapture: () -> Unit = {},
    val enterQuestion: () -> Unit = {},
    val showNotes: () -> Unit = {},
    val dictateNote: () -> Unit = {},
    val sendVoiceNote: () -> Unit = {},
    val cancelVoiceNote: () -> Unit = {},
    val dismissNotice: () -> Unit = {},
    val speakAnswer: () -> Unit = {},
    val stopSpeaking: () -> Unit = {},
)

/** What draws without the person having asked for it, which a screen capture must hold still. */
data class WatchPresentation(
    /** Whether the ask screen's buttons have appeared. */
    val hintVisible: Boolean = true,
    /** How long the note recorder has been recording. */
    val voiceNoteElapsed: Duration = Duration.ZERO,
    /** Whether the person has turned animations off. */
    val reduceMotion: Boolean = false,
)

/**
 * The screen for [state]: the recorder over everything, then the note
 * recorder and its notices, then the ask or note flow.
 */
@Composable
fun WatchRoot(
    state: WatchUiState,
    presentation: WatchPresentation,
    actions: WatchActions,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.fillMaxSize().background(Color.Black)) {
        when {
            state.capture.phase != CapturePhase.Idle -> CaptureScreen(state.capture, presentation.reduceMotion, actions)
            state.voiceNote != VoiceNoteState.Idle -> VoiceNoteScreen(state.voiceNote, presentation.voiceNoteElapsed, actions)
            state.screen == WatchScreen.NOTE -> NoteScreen(state.note, actions)
            else -> AskScreen(state.ask, state.activity, state.speaker, presentation.hintVisible, actions)
        }
    }
}

/** The ask screen alone, as it shows behind whatever is being swiped away. */
@Composable
private fun AskBackdrop(state: WatchUiState, presentation: WatchPresentation, actions: WatchActions) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AskScreen(state.ask, state.activity, state.speaker, presentation.hintVisible, actions)
    }
}

/**
 * The app's screen, bound to the view model: it times what the stateless
 * screens only draw, keeps the display awake while the watch is working, and
 * lets a swipe or the back button close whatever covers the ask screen.
 */
@Composable
fun WatchApp(viewModel: WatchViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val launchRequests by viewModel.launchRequests.collectAsStateWithLifecycle()
    val presentation = WatchPresentation(
        hintVisible = rememberHintVisible(),
        voiceNoteElapsed = rememberElapsed(state.voiceNote, viewModel.now),
        reduceMotion = animationsAreOff(),
    )

    LaunchedEffect(Unit) { viewModel.screenAppeared() }
    LaunchedEffect(launchRequests) { viewModel.openRequestedCapture() }
    KeepScreenOn(state.keepsScreenOn)

    OmnesisWearTheme {
        BackHandler(enabled = state.coversAsk, onBack = viewModel::dismissOverlay)
        BasicSwipeToDismissBox(
            onDismissed = viewModel::dismissOverlay,
            userSwipeEnabled = state.coversAsk,
        ) { isBackground ->
            if (isBackground) {
                AskBackdrop(state, presentation, viewModel.actions)
            } else {
                WatchRoot(state, presentation, viewModel.actions)
            }
        }
    }
}

/**
 * Whether the ask screen's buttons have appeared: half a second after the
 * screen does, long enough for a tile or complication launch to reach the
 * recorder first, short enough that someone opening the app by hand is not
 * left looking at a bare mark.
 */
@Composable
private fun rememberHintVisible(): Boolean {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(HINT_DELAY)
        visible = true
    }
    return visible
}

/** How long the note recorder has been recording, refreshed while it is. */
@Composable
private fun rememberElapsed(state: VoiceNoteState, now: () -> Long): Duration {
    val elapsed by produceState(Duration.ZERO, state) {
        val recording = state as? VoiceNoteState.Recording ?: return@produceState
        while (true) {
            value = (now() - recording.startedAt).milliseconds
            delay(ELAPSED_REFRESH)
        }
    }
    return elapsed
}

@Composable
private fun animationsAreOff(): Boolean {
    val resolver = LocalContext.current.contentResolver
    return remember(resolver) { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
}

@Composable
private fun KeepScreenOn(on: Boolean) {
    val view = LocalView.current
    DisposableEffect(view, on) {
        view.keepScreenOn = on
        onDispose { view.keepScreenOn = false }
    }
}

private val HINT_DELAY = 500.milliseconds
private val ELAPSED_REFRESH = 250.milliseconds

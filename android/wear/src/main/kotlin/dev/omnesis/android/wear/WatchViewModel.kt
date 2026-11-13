// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.omnesis.android.wear.core.WatchCore
import dev.omnesis.android.wear.core.WatchEffect
import dev.omnesis.android.wear.ui.WatchActions
import dev.omnesis.android.wear.ui.WatchUiState
import dev.omnesis.android.wearprotocol.EpochMillis
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

/** Presents the watch logic to the screen as one immutable state and one set of actions. */
class WatchViewModel(private val core: WatchCore, val now: () -> EpochMillis) : ViewModel() {
    private val asking = combine(core.screen, core.ask.state, core.ask.activity, core.speaker.state) {
            screen, ask, activity, speaker ->
        WatchUiState(screen = screen, ask = ask, activity = activity, speaker = speaker)
    }

    val state: StateFlow<WatchUiState> =
        combine(asking, core.note.state, core.capture.state, core.voiceNote.state) { base, note, capture, voiceNote ->
            base.copy(note = note, capture = capture, voiceNote = voiceNote)
        }.stateIn(viewModelScope, SharingStarted.Eagerly, WatchUiState())

    val effects: Flow<WatchEffect> = core.effects
    val launchRequests: StateFlow<Int> = core.launchRequests

    val actions = WatchActions(
        startCapture = { core.capture.start() },
        askAgain = { core.capture.start(followUp = true) },
        sendCapture = core.capture::send,
        cancelCapture = core.capture::cancelByUser,
        closeCapture = core.capture::cancel,
        retryCapture = {
            val failed = core.capture.state.value
            core.capture.start(followUp = failed.followUp, fromSurface = failed.fromSurface)
        },
        enterQuestion = core::enterQuestion,
        showNotes = core::showNotes,
        dictateNote = core::dictateNote,
        sendVoiceNote = core.voiceNote::send,
        cancelVoiceNote = core.voiceNote::cancel,
        dismissNotice = core.voiceNote::dismiss,
        speakAnswer = core.speaker::replay,
        stopSpeaking = core.speaker::stop,
    )

    fun screenAppeared() = core.screenAppeared()

    fun openRequestedCapture() = core.openRequestedCapture()

    /** Swipe-to-dismiss or the back button on whatever covers the ask screen. */
    fun dismissOverlay() = core.dismissTop()

    companion object {
        fun factory(container: WearContainer, now: () -> EpochMillis): ViewModelProvider.Factory = viewModelFactory {
            initializer { WatchViewModel(container.core, now) }
        }
    }
}

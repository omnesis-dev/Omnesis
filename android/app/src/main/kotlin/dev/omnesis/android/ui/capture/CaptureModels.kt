// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import dev.omnesis.android.notes.QueueReason

/** Surface slugs stamped on each captured note so the gateway knows the entry point. */
object CaptureSurface {
    const val APP = "android-app"
    const val TILE = "android-tile"

    /** Capture launched by a Gemini or Google Assistant App Action. */
    const val ASSISTANT = "android-assistant"

    /** Must stay in sync with the literal extra value in `src/main/shortcuts/shortcuts.xml` (static XML can't reference constants). */
    const val SHORTCUT = "android-shortcut"
}

/** Where speech input currently stands; anything but LISTENING leaves the keyboard as the input path. */
enum class SpeechState {
    /** Mic idle — tap to (re)start listening; typing always works. */
    IDLE,

    /** Actively recognizing; partial results stream into the text field. */
    LISTENING,

    /** No recognition service on this device, or none for its language — keyboard only. */
    UNAVAILABLE,

    /**
     * The recognizer supports the device's language but its offline model isn't
     * installed. Dictation runs on-device only, so nothing can transcribe until
     * the user installs the pack from system settings.
     */
    LANGUAGE_NOT_DOWNLOADED,

    /** RECORD_AUDIO denied — keyboard only, with a hint that the mic is off. */
    DENIED,
}

/** Lifecycle of the save action. */
sealed interface SaveState {
    data object Idle : SaveState

    data object Saving : SaveState

    /**
     * Saved. [queued] is null when the note landed on the gateway, otherwise
     * why it went to the offline queue instead (unreachable / unauthorized / feature off) —
     * the confirmation copy differs per reason.
     */
    data class Done(val queued: QueueReason? = null) : SaveState

    /** Save failed on a deterministic per-note rejection. */
    data class Failed(val message: String) : SaveState
}

/** Everything the capture screen renders. Pure data so screenshot tests can drive any state. */
data class CaptureUiState(
    /** Committed (final + user-edited) text. */
    val text: String = "",
    /** In-flight partial recognition, displayed after [text] while listening. */
    val partialText: String = "",
    val speech: SpeechState = SpeechState.IDLE,
    val save: SaveState = SaveState.Idle,
)

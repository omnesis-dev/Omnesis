// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.text.BreakIterator

/** What is being read aloud and how far the voice has got. */
data class SpeakerState(
    /** The answer on screen, which Speak answer reads. */
    val text: String = "",
    /** UTF-16 offset of the end of the word being spoken. */
    val spokenUpTo: Int = 0,
    val isSpeaking: Boolean = false,
)

/**
 * Speaks an answer aloud and reports how far it has got, so the text on
 * screen can follow along. The text is the reliable channel; audio is best
 * effort. Callbacks from [SpeechEngine] must arrive on the thread that owns
 * this model.
 */
class Speaker(
    private val engine: SpeechEngine,
    /** Whether the microphone is open or about to be. */
    private val isRecording: () -> Boolean,
) : SpeechEngine.Listener {
    private val _state = MutableStateFlow(SpeakerState())
    val state: StateFlow<SpeakerState> = _state.asStateFlow()

    /**
     * The utterance being spoken. Callbacks for a superseded utterance still
     * arrive after a new one starts, so each checks this before touching state.
     */
    private var current: Int? = null
    private var lastId = 0

    init {
        engine.listener = this
    }

    val isSpeaking: Boolean get() = _state.value.isSpeaking

    /** Keep [text] for Speak answer without starting audio. */
    fun prepare(text: String) {
        stop()
        _state.value = SpeakerState(text = text)
    }

    /**
     * Speak [text]. While the microphone is open the text is only kept for
     * Speak answer: playing audio would end up in the recording.
     */
    fun speak(text: String) {
        if (text.isEmpty()) return
        if (isRecording()) {
            current = null
            _state.value = SpeakerState(text = text, spokenUpTo = text.length)
            return
        }
        lastId += 1
        current = lastId
        _state.value = SpeakerState(text = text, isSpeaking = true)
        engine.speak(text, lastId)
    }

    /** Speak what is on screen again. */
    fun replay() = speak(_state.value.text)

    fun stop() {
        if (current != null) {
            current = null
            engine.stop()
        }
        // Stopping means the reader is done with it: show the whole answer
        // as read rather than freezing the highlight mid-sentence.
        _state.update { it.copy(isSpeaking = false, spokenUpTo = it.text.length) }
    }

    override fun onRange(id: Int, end: Int) {
        if (id != current) return
        _state.update { it.copy(spokenUpTo = end.coerceIn(0, it.text.length)) }
    }

    override fun onDone(id: Int) {
        if (id != current) return
        current = null
        _state.update { it.copy(isSpeaking = false, spokenUpTo = it.text.length) }
    }

    override fun onStopped(id: Int) {
        if (id != current) return
        current = null
        _state.update { it.copy(isSpeaking = false) }
    }
}

/** Where to split an answer between the part already spoken and the part still to come. */
object ReadAlong {
    /**
     * The index splitting [text] at [spokenUtf16], or null when nothing has
     * been spoken yet. An offset inside a character made of several code
     * units rounds down to the character's start, so the highlight lags by
     * one character rather than splitting it.
     */
    fun split(text: String, spokenUtf16: Int): Int? {
        if (spokenUtf16 <= 0 || text.isEmpty()) return null
        if (spokenUtf16 >= text.length) return text.length
        val characters = BreakIterator.getCharacterInstance()
        characters.setText(text)
        return if (characters.isBoundary(spokenUtf16)) spokenUtf16 else characters.preceding(spokenUtf16)
    }

    /**
     * The split to draw for [text] given what the speaker is reading: null
     * when the speaker holds another text or has not started, so the answer
     * shows plainly rather than wholly dimmed.
     */
    fun split(text: String, speaker: SpeakerState): Int? =
        if (speaker.text == text) split(text, speaker.spokenUpTo) else null
}

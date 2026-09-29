// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import dev.omnesis.android.ui.capture.joinUtterances

/**
 * What has been heard so far in one dictation: the utterances the recogniser has
 * finalised, plus the in-flight guess for the utterance still being spoken.
 *
 * The two are kept apart because a partial is *replaced* by the next partial, while a
 * final is *appended*. Collapsing them would make every pause overwrite the sentence
 * before it.
 *
 * A partial the recogniser never finalised reaches this buffer as text from
 * [dev.omnesis.android.voice.OnDeviceVoiceInput], which commits it before the next session.
 */
data class DictationBuffer(
    /** Utterances the recogniser has finalised. */
    val committed: String = "",
    /** The in-flight guess for the utterance being spoken; replaced, never appended to. */
    val partial: String = "",
) {
    /** Everything heard, as the strip displays it. */
    val display: String get() = joinUtterances(committed, partial)

    fun withPartial(text: String): DictationBuffer = copy(partial = text)

    fun withFinal(text: String): DictationBuffer =
        DictationBuffer(committed = joinUtterances(committed, text), partial = "")
}

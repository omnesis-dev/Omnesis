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
 * Pure data, so the rule that matters — a session ending without a final result must
 * still keep the words it heard — is exercised without a recogniser or an emulator.
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

    /**
     * Fold the in-flight guess into the committed text.
     *
     * Called whenever a session ends, before any next session starts. A session that ends
     * without a final result — an error, or the recogniser simply stopping — still heard
     * those words, and the next session's first partial would otherwise replace them.
     */
    fun committing(): DictationBuffer = DictationBuffer(committed = display, partial = "")
}

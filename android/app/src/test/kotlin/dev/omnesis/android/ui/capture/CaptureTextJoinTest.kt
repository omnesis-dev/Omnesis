// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import org.junit.Assert.assertEquals
import org.junit.Test

/** Committed-text + partial joining as the capture field displays and saves it. */
class CaptureTextJoinTest {

    @Test
    fun blank_partial_leaves_committed_text_untouched() {
        assertEquals("call the vet", joinUtterances("call the vet", ""))
        assertEquals("call the vet", joinUtterances("call the vet", "   "))
    }

    @Test
    fun first_utterance_lands_without_a_leading_space() {
        assertEquals("call the vet", joinUtterances("", "call the vet"))
    }

    @Test
    fun later_utterances_join_with_a_single_space() {
        assertEquals("call the vet tomorrow morning", joinUtterances("call the vet ", "tomorrow morning"))
    }

    @Test
    fun state_joins_text_and_partial_for_display() {
        val state = CaptureUiState(text = "remember to", partialText = "buy stamps")
        assertEquals("remember to buy stamps", state.textWithPartial())
    }
}

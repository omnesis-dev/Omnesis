// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import org.junit.Assert.assertEquals
import org.junit.Test

/** The dictation buffer's two rules: a partial is replaced, a final is appended. */
class DictationBufferTest {

    @Test
    fun `a partial replaces the previous partial`() {
        val buffer = DictationBuffer()
            .withPartial("tell her the")
            .withPartial("tell her the weekend")
        assertEquals("tell her the weekend", buffer.display)
        assertEquals("", buffer.committed)
    }

    @Test
    fun `a final appends and clears the partial`() {
        val buffer = DictationBuffer()
            .withPartial("tell her the weekend")
            .withFinal("Tell her the weekend works.")
        assertEquals("Tell her the weekend works.", buffer.display)
        assertEquals("", buffer.partial)
    }

    @Test
    fun `finals accumulate across utterances`() {
        val buffer = DictationBuffer()
            .withFinal("Tell her the weekend works.")
            .withFinal("Ask about the drive.")
        assertEquals("Tell her the weekend works. Ask about the drive.", buffer.display)
    }
}

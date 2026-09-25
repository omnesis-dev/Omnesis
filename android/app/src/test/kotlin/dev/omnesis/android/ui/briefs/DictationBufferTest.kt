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

    /**
     * The rule the whole type exists for. The recogniser ends a session on every pause,
     * and a session that ends without a final result still heard those words — committing
     * first is what stops the next session's opening partial from erasing them.
     */
    @Test
    fun `committing keeps words from a session that ended without a final`() {
        val ended = DictationBuffer(committed = "Tell her the weekend works.")
            .withPartial("and ask about the")
            .committing()
        assertEquals("Tell her the weekend works. and ask about the", ended.committed)
        assertEquals("", ended.partial)

        // The next session opens with its own partial, which must not replace the above.
        assertEquals(
            "Tell her the weekend works. and ask about the drive",
            ended.withPartial("drive").display,
        )
    }

    @Test
    fun `committing nothing changes nothing`() {
        val buffer = DictationBuffer(committed = "Already said.")
        assertEquals("Already said.", buffer.committing().committed)
    }
}

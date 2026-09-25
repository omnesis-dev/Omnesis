// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The sub-agent card's per-source document count sits in a badge overlaid on a 16-dp icon,
 * so it has to stay short whatever the reader found. Mirrors the portal and iOS
 * `formatSourceCount`; the saturating branch is out of reach of any screenshot fixture.
 */
class AgentSubagentCardFormatTest {

    @Test fun a_small_count_is_printed_as_is() {
        assertEquals("1", formatSourceCount(1))
        assertEquals("42", formatSourceCount(42))
    }

    @Test fun the_widest_exact_count_is_two_digits() {
        assertEquals("99", formatSourceCount(99))
    }

    @Test fun a_prolific_reader_saturates_rather_than_widening_the_badge() {
        assertEquals("99+", formatSourceCount(100))
        assertEquals("99+", formatSourceCount(4_312))
    }
}

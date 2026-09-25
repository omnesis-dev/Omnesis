// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The quiet diagnostic line under a humanized failure sentence. All fixture data is invented.
 */
class FailureDetailLineTest {

    @Test
    fun a_code_and_a_disposition_join_with_the_separator() {
        assertEquals(
            "http_api_error · HTTP 404 · NOT_FOUND · param=model",
            failureDetailLine("http_api_error", "HTTP 404 · NOT_FOUND · param=model"),
        )
    }

    @Test
    fun either_half_alone_still_renders() {
        assertEquals("http_api_error", failureDetailLine("http_api_error", null))
        assertEquals("HTTP 404 · NOT_FOUND", failureDetailLine(null, "HTTP 404 · NOT_FOUND"))
    }

    @Test
    fun nothing_to_say_renders_nothing() {
        assertNull(failureDetailLine(null, null))
        assertNull(failureDetailLine("", "   "))
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The icon constant must stay byte-identical to what
 * `packages/providers-synth/android-call-log/src/icons.ts` produces
 * (`svgDataUri(tintLucideSvg(PHONE_CALL_SVG, "#3DDC84"))`), so the portal
 * shows one stable glyph for the source no matter which side registered it.
 */
class CallLogIconTest {

    /** The TS construction's exact output, captured from `icons.ts`. */
    private val tsOutput =
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0" +
            "PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzRERDODQiIHN0cm9rZS13aWR0aD0iMiIgc3Ry" +
            "b2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTMgMmE5IDkgMCAwIDEgOSA5Ii8+" +
            "PHBhdGggZD0iTTEzIDZhNSA1IDAgMCAxIDUgNSIvPjxwYXRoIGQ9Ik0xNC4wNSAyYTEzIDEzIDAgMCAxIDggOCIvPjxwYXRoIGQ9" +
            "Ik0yMiAxNi45MnYzYTIgMiAwIDAgMS0yLjE4IDIgMTkuNzkgMTkuNzkgMCAwIDEtOC42My0zLjA3IDE5LjUgMTkuNSAwIDAgMS02" +
            "LTYgMTkuNzkgMTkuNzkgMCAwIDEtMy4wNy04LjY3QTIgMiAwIDAgMSA0LjExIDJoM2EyIDIgMCAwIDEgMiAxLjcyIDEyLjg0IDEy" +
            "Ljg0IDAgMCAwIC43IDIuODEgMiAyIDAgMCAxLS40NSAyLjExTDguMDkgOS45MWExNiAxNiAwIDAgMCA2IDZsMS4yNy0xLjI3YTIg" +
            "MiAwIDAgMSAyLjExLS40NSAxMi44NCAxMi44NCAwIDAgMCAyLjgxLjdBMiAyIDAgMCAxIDIyIDE2LjkyeiIvPjwvc3ZnPg=="

    @Test
    fun matches_the_ts_construction_byte_for_byte() {
        assertEquals(tsOutput, CALL_LOG_ICON_DATA_URI)
    }

    @Test
    fun decodes_back_to_the_tinted_lucide_svg() {
        val b64 = CALL_LOG_ICON_DATA_URI.removePrefix("data:image/svg+xml;base64,")
        val svg = String(Base64.getDecoder().decode(b64), Charsets.UTF_8)
        assertTrue(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""))
        assertTrue(svg.contains("stroke=\"#3DDC84\""))
        assertFalse(svg.contains("currentColor"))
    }

    @Test
    fun tint_replaces_every_current_color_stroke() {
        val tinted = tintLucideSvg(
            """<a stroke="currentColor"/><b stroke="currentColor"/>""",
            "#112233",
        )
        assertEquals("""<a stroke="#112233"/><b stroke="#112233"/>""", tinted)
    }
}

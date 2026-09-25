// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The icon constant must stay byte-identical to
 * `ios/Sources/Omnesis/Photos/PhotosIcon.swift`'s output, so the portal
 * shows one stable glyph for the source no matter which platform
 * registered it.
 */
class PhotosIconTest {

    /** iOS's exact construction output, captured from `PhotosIcon.swift`. */
    private val iosOutput =
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0" +
            "PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMwQTg0RkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ry" +
            "b2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB3aWR0aD0iMTgiIGhlaWdodD0iMTgiIHg9" +
            "IjMiIHk9IjMiIHJ4PSIyIiByeT0iMiIvPjxjaXJjbGUgY3g9IjkiIGN5PSI5IiByPSIyIi8+PHBhdGggZD0ibTIxIDE1LTMuMDg2" +
            "LTMuMDg2YTIgMiAwIDAgMC0yLjgyOCAwTDYgMjEiLz48L3N2Zz4="

    @Test
    fun matches_the_ios_construction_byte_for_byte() {
        assertEquals(iosOutput, PHOTOS_ICON_DATA_URI)
    }

    @Test
    fun decodes_back_to_the_tinted_lucide_svg() {
        val b64 = PHOTOS_ICON_DATA_URI.removePrefix("data:image/svg+xml;base64,")
        val svg = String(Base64.getDecoder().decode(b64), Charsets.UTF_8)
        assertTrue(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""))
        assertTrue(svg.contains("stroke=\"#0A84FF\""))
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The icon constant must stay byte-identical to what
 * `packages/providers-synth/health-connect/src/icons.ts` produces
 * (`svgDataUri(tintLucideSvg(HEART_PULSE_SVG, "#3DDC84"))`), so the portal
 * shows one stable glyph for the source no matter which side registered it.
 */
class HealthConnectIconTest {

    /** The TS construction's exact output, captured from `icons.ts`. */
    private val tsOutput =
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0" +
            "PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzRERDODQiIHN0cm9rZS13aWR0aD0iMiIgc3Ry" +
            "b2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTkgMTRjMS40OS0xLjQ2IDMtMy4y" +
            "MSAzLTUuNUE1LjUgNS41IDAgMCAwIDE2LjUgM2MtMS43NiAwLTMgLjUtNC41IDItMS41LTEuNS0yLjc0LTItNC41LTJBNS41IDUu" +
            "NSAwIDAgMCAyIDguNWMwIDIuMjkgMS41MSA0LjA0IDMgNS41bDcgN1oiLz48cGF0aCBkPSJNMy4yMiAxMkg5LjVsLjUtMSAyIDQu" +
            "NSAyLTcgMS41IDMuNWg1LjI3Ii8+PC9zdmc+"

    @Test
    fun matches_the_ts_construction_byte_for_byte() {
        assertEquals(tsOutput, HEALTH_CONNECT_ICON_DATA_URI)
    }

    @Test
    fun decodes_back_to_the_tinted_lucide_svg() {
        val b64 = HEALTH_CONNECT_ICON_DATA_URI.removePrefix("data:image/svg+xml;base64,")
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

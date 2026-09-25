// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUsageIconTest {

    @Test
    fun decodes_back_to_the_tinted_svg() {
        val b64 = APP_USAGE_ICON_DATA_URI.removePrefix("data:image/svg+xml;base64,")
        val svg = String(Base64.getDecoder().decode(b64), Charsets.UTF_8)
        assertTrue(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""))
        assertTrue(svg.contains("stroke=\"#3DDC84\""))
        assertFalse(svg.contains("currentColor"))
    }

    @Test
    fun tint_replaces_every_current_color_stroke() {
        val tinted = tintSvg("""<a stroke="currentColor"/><b stroke="currentColor"/>""", "#112233")
        assertEquals("""<a stroke="#112233"/><b stroke="#112233"/>""", tinted)
    }
}

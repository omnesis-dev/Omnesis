// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class ProviderIconTest {
    @Test fun gateway_svg_current_color_is_explicit_for_each_theme() {
        val svg = """<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor"/><path fill="#4285F4"/></svg>"""
        val dark = decode(providerLogoDataUri(svg, "#F7F8F9"))
        val light = decode(providerLogoDataUri(svg, "#202124"))
        assertTrue(dark.contains("fill=\"#F7F8F9\""))
        assertTrue(light.contains("fill=\"#202124\""))
        assertTrue(dark.contains("fill=\"#4285F4\""))
        assertFalse(dark.contains("currentColor"))
    }

    private fun decode(uri: String): String {
        assertTrue(uri.startsWith("data:image/svg+xml;base64,"))
        return String(Base64.getDecoder().decode(uri.substringAfter(',')), Charsets.UTF_8)
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Resources another process draws: launcher shortcut icons, the Quick Settings tile and
 * notification icons, the widget's layouts. None of them is inflated with the app's theme,
 * so a `?attr/…` reference in one resolves to nothing and the icon comes out blank.
 */
class OutOfThemeResourcesTest {
    private val res = File("src/main/res")
    private val shortcuts = File("src/main/shortcuts/shortcuts.xml").readText()

    private fun drawable(name: String): File = res.listFiles { dir -> dir.name.startsWith("drawable") }
        .orEmpty()
        .map { File(it, "$name.xml") }
        .firstOrNull(File::exists)
        ?: error("No drawable named $name")

    /** [name] and every drawable it is built from. */
    private fun drawableTree(name: String, seen: MutableSet<String> = mutableSetOf()): Set<String> {
        if (!seen.add(name)) return seen
        DRAWABLE_REFERENCE.findAll(drawable(name).readText()).forEach { drawableTree(it.groupValues[1], seen) }
        return seen
    }

    private val shortcutIcons: Map<String, String> = SHORTCUT.findAll(shortcuts).associate { shortcut ->
        val id = SHORTCUT_ID.find(shortcut.value)?.groupValues?.get(1) ?: error("A shortcut has no id")
        val icon = SHORTCUT_ICON.find(shortcut.value)?.groupValues?.get(1) ?: error("Shortcut $id has no drawable icon")
        id to icon
    }

    @Test
    fun every_launcher_shortcut_has_an_icon_of_its_own() {
        assertEquals(setOf("voice_input", "tell_brain", "ask_omnesis"), shortcutIcons.keys)
        assertEquals("two shortcuts share an icon: $shortcutIcons", shortcutIcons.size, shortcutIcons.values.toSet().size)
    }

    @Test
    fun a_launcher_shortcut_icon_is_drawn_without_the_apps_theme() {
        for ((id, icon) in shortcutIcons) {
            for (name in drawableTree(icon)) {
                val xml = drawable(name).readText()
                assertTrue("$id's icon uses $name, which reads a theme attribute", THEME_REFERENCE.find(xml) == null)
            }
        }
    }

    @Test
    fun a_launcher_shortcut_icon_is_an_adaptive_icon_with_a_glyph_in_explicit_colors() {
        for ((id, icon) in shortcutIcons) {
            assertTrue("$id's icon is not adaptive", "<adaptive-icon" in drawable(icon).readText())
            val layers = drawableTree(icon) - icon
            assertTrue("$id's icon has no layer of its own", layers.isNotEmpty())
            assertTrue(
                "$id's icon names no color",
                layers.any { EXPLICIT_COLOR.containsMatchIn(drawable(it).readText()) },
            )
        }
    }

    @Test
    fun no_drawable_or_widget_layout_reads_a_theme_attribute() {
        val drawn = res.listFiles { dir ->
            dir.name.startsWith("drawable") || dir.name.startsWith("mipmap") || dir.name.startsWith("layout")
        }.orEmpty().flatMap { it.listFiles { file -> file.extension == "xml" }.orEmpty().toList() }
        assertTrue("found no resources under ${res.absolutePath}", drawn.isNotEmpty())
        val themed = drawn.filter { THEME_REFERENCE.containsMatchIn(it.readText()) }.map { it.name }
        assertEquals(emptyList<String>(), themed)
    }

    private companion object {
        val SHORTCUT = Regex("""<shortcut\b[^>]*>""")
        val SHORTCUT_ID = Regex("""android:shortcutId="([^"]+)"""")
        val SHORTCUT_ICON = Regex("""android:icon="@drawable/([^"]+)"""")
        val DRAWABLE_REFERENCE = Regex(""""@drawable/([^"]+)"""")
        val THEME_REFERENCE = Regex("""="\?[^"]*"""")
        val EXPLICIT_COLOR = Regex("""Color="#[0-9A-Fa-f]{6,8}"""")
    }
}
